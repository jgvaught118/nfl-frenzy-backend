// scripts/syncKickoffsFromSportsdata.js

import "dotenv/config";
import pg from "pg";
import axios from "axios";

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

/**
 * Normalize team names between DB and SportsDataIO.
 * DB uses full names, SportsDataIO uses Team + maybe suffix.
 */
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
 * Build a quick lookup map for schedule entries:
 * key: `${week}|${away}|${home}` all normalized
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
 * Get correct UTC kickoff from SportsDataIO entry.
 *
 * We ONLY trust DateTimeUTC here.
 */
function getApiKickoffUtc(game) {
  // SportsDataIO docs: DateTimeUTC is ISO-8601 in UTC.
  const utc = game.DateTimeUTC || game.DateTime;
  if (!utc) return null;

  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;

  // Ensure we return a canonical Z string
  return d.toISOString();
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

    // 2) Load SportsDataIO schedule (entire season)
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
      if (!apiGame) {
        // silently skip if no exact match (preseason, etc.)
        continue;
      }

      const apiKickoffUtc = getApiKickoffUtc(apiGame);
      if (!apiKickoffUtc) continue;

      const dbKickoff = db.kickoff
        ? new Date(db.kickoff).toISOString()
        : null;

      // If DB empty or differs by more than 60 seconds, update
      if (!dbKickoff) {
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

      const diffMs =
        new Date(apiKickoffUtc).getTime() -
        new Date(dbKickoff).getTime();
      const diffMin = Math.abs(diffMs) / 60000;

      if (diffMin > 1) {
        console.log(
          `[FIX ] id=${db.id} w${db.week} ${db.away_team} @ ${db.home_team}
     DB:  ${dbKickoff}
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

    console.log(
      APPLY
        ? `Updated rows: ${updates}`
        : `Dry run only. Rows that would be updated: ${updates}`
    );
  } catch (err) {
    console.error("FATAL:", err.message || err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(1);
});
