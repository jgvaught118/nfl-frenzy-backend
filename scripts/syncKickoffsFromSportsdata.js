// scripts/syncKickoffsFromSportsdata.js

require("dotenv").config();
const pg = require("pg");
const axios = require("axios");

const { Client } = pg;

const APPLY =
  process.env.npm_lifecycle_event === "kickoffs:sync" ||
  process.argv.includes("--apply");

const {
  RW_DB,
  SPORTSDATA_API_KEY,
  SPORTSDATA_SEASON = "2025REG",
} = process.env;

if (!RW_DB) {
  console.error("FATAL: RW_DB not set.");
  process.exit(1);
}
if (!SPORTSDATA_API_KEY) {
  console.error("FATAL: SPORTSDATA_API_KEY not set.");
  process.exit(1);
}

const SPORTS_DATA_BASE_URL =
  "https://api.sportsdata.io/v3/nfl/scores/json/Schedules";

/** Normalize for matching DB <-> API team names */
function normalizeTeamName(name) {
  if (!name) return "";
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

/**
 * Check whether a datetime string already includes timezone/offset info.
 * Examples that return true:
 *  - "2025-11-07T01:15:00Z"
 *  - "2025-11-07T01:15:00+00:00"
 *  - "2025-11-07T01:15:00-05:00"
 */
function hasExplicitTz(str) {
  return /([zZ]|[+\-]\d{2}:?\d{2})$/.test(str);
}

/**
 * Parse SportsDataIO DateTimeUTC / DateTime into a proper UTC Date.
 *
 * Rules:
 * - Prefer DateTimeUTC. SportsDataIO defines this as UTC.
 *   - If it lacks 'Z' or offset, we treat it as UTC and append 'Z'.
 * - If DateTimeUTC is missing/invalid, fall back to DateTime (local ET).
 *   - If DateTime has no offset, we treat it as US Eastern and convert:
 *     - During DST (approx Mar–early Nov): ET = UTC-4
 *     - Otherwise: ET = UTC-5
 */
function parseSportsDataUtc(dateTimeUtc, dateTimeEt) {
  if (dateTimeUtc) {
    const raw = String(dateTimeUtc).trim();
    if (raw) {
      let iso = raw;
      if (!hasExplicitTz(iso)) {
        // SportsDataIO says this is UTC, so force it.
        iso = iso + "Z";
      }

      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) {
        return d;
      }
    }
  }

  if (dateTimeEt) {
    const raw = String(dateTimeEt).trim();
    if (raw) {
      if (hasExplicitTz(raw)) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) return d;
      } else {
        // Treat as Eastern Time, convert to UTC.
        // Heuristic DST rules good enough for NFL season.
        // Create a Date assuming the given clock time is ET, then shift.
        const base = new Date(raw + "Z");
        if (!Number.isNaN(base.getTime())) {
          const m = base.getUTCMonth() + 1; // 1-12
          const dNum = base.getUTCDate();

          // US DST ends first Sunday in November; for 2025 that’s Nov 2.
          const dstEndsMonth = 11;
          const dstEndsDay = 2;
          const isDst =
            m < dstEndsMonth ||
            (m === dstEndsMonth && dNum < dstEndsDay);

          const offsetHours = isDst ? 4 : 5; // ET: UTC-4 (DST), UTC-5 (std)
          // Local ET time + offsetHours = UTC
          base.setUTCHours(base.getUTCHours() + offsetHours);
          return base;
        }
      }
    }
  }

  return null;
}

/**
 * Get canonical UTC kickoff from SportsDataIO game object.
 * Returns ISO string in UTC, or null.
 */
function getApiKickoffUtc(game) {
  const d = parseSportsDataUtc(game.DateTimeUTC, game.DateTime);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Build lookup: `${week}|${away}|${home}` -> SportsData game
 * Uses HomeTeamName/AwayTeamName when available, falls back to HomeTeam/AwayTeam.
 */
function buildScheduleMap(sched) {
  const map = new Map();
  for (const g of sched) {
    const week = g.Week;
    const home = normalizeTeamName(g.HomeTeamName || g.HomeTeam);
    const away = normalizeTeamName(g.AwayTeamName || g.AwayTeam);
    if (!week || !home || !away) continue;
    const key = `${week}|${away}|${home}`;
    map.set(key, g);
  }
  return map;
}

async function main() {
  console.log(
    `kickoffs:${APPLY ? "sync" : "audit"} (APPLY=${
      APPLY ? "yes" : "no"
    }) using ${SPORTSDATA_SEASON}`
  );

  const client = new Client({ connectionString: RW_DB });
  await client.connect();

  try {
    // 1) Load DB games
    const dbRes = await client.query(
      `SELECT id, week, home_team, away_team, kickoff
       FROM games
       WHERE week >= 1
       ORDER BY week, id`
    );
    const dbGames = dbRes.rows;
    console.log("DB games loaded:", dbGames.length);

    // 2) Load SportsDataIO schedule
    console.log("Fetching SportsDataIO schedule…");
    const apiRes = await axios.get(
      `${SPORTS_DATA_BASE_URL}/${SPORTSDATA_SEASON}`,
      {
        headers: { "Ocp-Apim-Subscription-Key": SPORTSDATA_API_KEY },
      }
    );
    const schedule = apiRes.data || [];
    console.log("SportsDataIO schedule entries:", schedule.length);

    const schedMap = buildScheduleMap(schedule);
    let updates = 0;

    // 3) Compare & update
    for (const db of dbGames) {
      const key = `${db.week}|${normalizeTeamName(
        db.away_team
      )}|${normalizeTeamName(db.home_team)}`;
      const apiGame = schedMap.get(key);
      if (!apiGame) continue;

      const apiKickoffUtc = getApiKickoffUtc(apiGame);
      if (!apiKickoffUtc) {
        console.warn(
          `[WARN] No valid API kickoff for w${db.week} ${db.away_team} @ ${db.home_team}`
        );
        continue;
      }

      const dbKickoffIso = db.kickoff
        ? new Date(db.kickoff).toISOString()
        : null;

      // If DB empty -> set it
      if (!dbKickoffIso) {
        console.log(
          `[SET ] id=${db.id} w${db.week} ${db.away_team} @ ${db.home_team}
     DB:  (null)
     API: ${apiKickoffUtc}`
        );
        if (APPLY) {
          await client.query(
            "UPDATE games SET kickoff = $1 WHERE id = $2",
            [apiKickoffUtc, db.id]
          );
        }
        updates++;
        continue;
      }

      // Compare; only update if off by > 60 seconds
      const diffMs =
        new Date(apiKickoffUtc).getTime() -
        new Date(dbKickoffIso).getTime();
      const diffMin = Math.abs(diffMs) / 60000;

      if (diffMin > 1) {
        console.log(
          `[FIX ] id=${db.id} w${db.week} ${db.away_team} @ ${db.home_team}
     DB:  ${dbKickoffIso}
     API: ${apiKickoffUtc}
     Δ = ${diffMin.toFixed(1)} min`
        );
        if (APPLY) {
          await client.query(
            "UPDATE games SET kickoff = $1 WHERE id = $2",
            [apiKickoffUtc, db.id]
          );
        }
        updates++;
      }
    }

    if (APPLY) {
      console.log(`Updated rows: ${updates}`);
    } else {
      console.log(`Dry run only. Rows that would be updated: ${updates}`);
    }
  } catch (err) {
    console.error("FATAL:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(1);
});
