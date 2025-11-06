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
 * Whether a datetime string already includes timezone/offset info.
 * Examples:
 *  - "2025-11-07T01:15:00Z"
 *  - "2025-11-07T01:15:00+00:00"
 *  - "2025-11-07T01:15:00-05:00"
 */
function hasExplicitTz(str) {
  return /([zZ]|[+\-]\d{2}:?\d{2})$/.test(str);
}

/**
 * US DST helpers (for correct ET→UTC conversion)
 * DST: second Sunday in March @ 2am local
 * Ends: first Sunday in November @ 2am local
 * We'll approximate using UTC dates; good for NFL season.
 */

function getNthDowOfMonthUtc(year, monthIndex, dow, n) {
  // monthIndex: 0-11, dow: 0=Sun..6=Sat
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
  const firstDow = firstOfMonth.getUTCDay();
  const delta = (dow - firstDow + 7) % 7;
  const day = 1 + delta + (n - 1) * 7;
  return new Date(Date.UTC(year, monthIndex, day, 0, 0, 0));
}

function getUsDstRangeUtc(year) {
  // Second Sunday in March
  const dstStart = getNthDowOfMonthUtc(year, 2, 0, 2); // March = 2
  // First Sunday in November
  const dstEnd = getNthDowOfMonthUtc(year, 10, 0, 1); // Nov = 10
  return { dstStart, dstEnd };
}

function isUsEasternDst(dateUtc) {
  const year = dateUtc.getUTCFullYear();
  const { dstStart, dstEnd } = getUsDstRangeUtc(year);
  return dateUtc >= dstStart && dateUtc < dstEnd;
}

/**
 * Convert SportsDataIO DateTime (local ET) into canonical UTC ISO.
 *
 * Strategy:
 * - Ignore DateTimeUTC because it has proven unreliable in your data.
 * - Use DateTime:
 *    - If it already has a timezone/offset, trust it.
 *    - If it is naive (no offset), treat as US Eastern local time:
 *        * Determine if that date is in DST.
 *        * ET offset = UTC-4 (DST) or UTC-5 (standard).
 *        * So UTC = local_ET + offsetHours.
 */
function getApiKickoffUtc(game) {
  const rawDt = game.DateTime;
  if (!rawDt) return null;

  const raw = String(rawDt).trim();
  if (!raw) return null;

  // If DateTime has explicit TZ, trust it directly
  if (hasExplicitTz(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
    return null;
  }

  // Naive: treat as ET local time.
  // Step 1: interpret the naive clock as if it were UTC just to get Y/M/D/H/M.
  const pseudoUtc = new Date(raw + "Z");
  if (Number.isNaN(pseudoUtc.getTime())) {
    return null;
  }

  // Step 2: decide DST based on that date.
  const isDst = isUsEasternDst(pseudoUtc);
  const offsetHours = isDst ? 4 : 5; // ET = UTC-4 (DST) or UTC-5 (std)

  // Step 3: real UTC time = local_ET + offset
  pseudoUtc.setUTCHours(pseudoUtc.getUTCHours() + offsetHours);

  return pseudoUtc.toISOString();
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
