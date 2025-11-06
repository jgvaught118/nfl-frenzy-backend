// scripts/syncKickoffsFromSportsdata.js

require("dotenv").config();
const pg = require("pg");
const axios = require("axios");

const { Client } = pg;

// APPLY mode: true for `npm run kickoffs:sync`, false for `kickoffs:audit`
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

/**
 * US DST rules helper (for America/New_York)
 * DST starts: 2nd Sunday in March
 * DST ends:   1st Sunday in November
 */
function isUsDstInEffect(year, month, day) {
  // month: 1-12, day: 1-31 (local date in ET)
  // Compute 2nd Sunday in March
  const marchFirst = new Date(Date.UTC(year, 2, 1)); // March = 2
  const marchFirstDow = marchFirst.getUTCDay(); // 0=Sun
  const firstSundayInMarch = marchFirstDow === 0 ? 1 : 8 - marchFirstDow;
  const secondSundayInMarch = firstSundayInMarch + 7;

  // Compute 1st Sunday in November
  const novFirst = new Date(Date.UTC(year, 10, 1)); // Nov = 10
  const novFirstDow = novFirst.getUTCDay();
  const firstSundayInNov = novFirstDow === 0 ? 1 : 8 - novFirstDow;

  const mmdd = month * 100 + day;
  const dstStart = 3 * 100 + secondSundayInMarch; // MMDD
  const dstEnd = 11 * 100 + firstSundayInNov; // MMDD

  return mmdd >= dstStart && mmdd < dstEnd;
}

/**
 * Interpret a timezone-less DateTime string from SportsDataIO as
 * Eastern Time (America/New_York), then convert to UTC ISO string.
 *
 * Example input: "2025-11-09T13:00:00" (1:00pm ET)
 */
function easternLocalToUtcIso(localStr) {
  if (!localStr || typeof localStr !== "string") return null;

  const [datePart, timePart] = localStr.split("T");
  if (!datePart || !timePart) return null;

  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const [hourStr, minStr, secStr = "00"] = timePart.split(":");

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  // Determine Eastern offset for that date
  const isDst = isUsDstInEffect(year, month, day);
  // Eastern offset relative to UTC: -4 (DST) or -5 (standard)
  const offsetMinutes = isDst ? -4 * 60 : -5 * 60;

  // local(ET) = UTC + offset  =>  UTC = local - offset
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) -
    offsetMinutes * 60 * 1000;

  const d = new Date(utcMs);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Get canonical UTC kickoff from SportsDataIO for a game.
 *
 * IMPORTANT:
 * - We DO NOT trust DateTimeUTC from this feed in your environment,
 *   because it has been consistently off.
 * - We treat DateTime as local Eastern time and convert -> UTC.
 * - If DateTime already has a timezone/offset, we respect it.
 */
function getApiKickoffUtc(game) {
  let src = game.DateTime || game.DateTimeUTC;
  if (!src) return null;

  // If includes explicit offset or Z, trust it directly.
  if (/[zZ]$/.test(src) || /[+\-]\d\d:?\d\d$/.test(src)) {
    const d = new Date(src);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
    // fall through to try as Eastern-local if parsing failed
  }

  // Otherwise: treat as Eastern local time (no offset in string).
  const iso = easternLocalToUtcIso(src);
  return iso;
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

    for (const db of dbGames) {
      const key = `${db.week}|${normalizeTeamName(
        db.away_team
      )}|${normalizeTeamName(db.home_team)}`;
      const apiGame = schedMap.get(key);
      if (!apiGame) continue;

      const apiKickoffUtc = getApiKickoffUtc(apiGame);
      if (!apiKickoffUtc) continue;

      const dbKickoffIso = db.kickoff
        ? new Date(db.kickoff).toISOString()
        : null;

      // If DB empty -> set
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

      // Compare and update if off by more than 1 minute
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
