// scripts/syncKickoffsFromSportsdata.js
// Align DB kickoff times with SportsDataIO schedule.
// Usage:
//   npm run kickoffs:audit   # dry run
//   npm run kickoffs:sync    # apply updates
//
// Requires env:
//   RW_DB or DATABASE_URL  -> postgres connection string
//   SPORTSDATA_API_KEY
//   SPORTSDATA_SEASON      -> e.g. "2025REG"

require("dotenv").config();
const fetch = require("node-fetch");
const { Client } = require("pg");

const lifecycle = process.env.npm_lifecycle_event || "";
const APPLY = lifecycle === "kickoffs:sync";

const SEASON = process.env.SPORTSDATA_SEASON || "2025REG";
const API_KEY = process.env.SPORTSDATA_API_KEY;
const DB_URL = process.env.RW_DB || process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("FATAL: SPORTSDATA_API_KEY not set.");
  process.exit(1);
}
if (!DB_URL) {
  console.error("FATAL: RW_DB or DATABASE_URL not set.");
  process.exit(1);
}

const SCHEDULE_URL = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${SEASON}?key=${API_KEY}`;

function toSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Very small DST helper for Eastern Time (US rules).
function isUS_DST(dateUtc) {
  const y = dateUtc.getUTCFullYear();

  // Second Sunday in March
  const march = new Date(Date.UTC(y, 2, 1));
  let secondSunMar = null;
  for (let i = 0, found = 0; i < 31; i++) {
    const d = new Date(Date.UTC(y, 2, 1 + i));
    if (d.getUTCDay() === 0) {
      found++;
      if (found === 2) {
        secondSunMar = d;
        break;
      }
    }
  }

  // First Sunday in November
  const nov = new Date(Date.UTC(y, 10, 1));
  let firstSunNov = null;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(y, 10, 1 + i));
    if (d.getUTCDay() === 0) {
      firstSunNov = d;
      break;
    }
  }

  if (!secondSunMar || !firstSunNov) return false;
  return dateUtc >= secondSunMar && dateUtc < firstSunNov;
}

// SportsDataIO docs: DateTime is Eastern local time (with DST).
// Convert that to a UTC Date.
function parseSportsdataUtc(game) {
  let dt = game.DateTime || game.DateTimeUTC || null;

  if (!dt && game.Date && game.Time) {
    dt = `${game.Date}T${game.Time}`;
  }

  if (!dt) return null;

  // If already tagged as UTC, trust it.
  if (dt.endsWith("Z")) {
    const d = new Date(dt);
    return isNaN(d) ? null : d;
  }

  // Parse "YYYY-MM-DDTHH:MM:SS" as Eastern, then convert to UTC.
  const m = dt.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) {
    return null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);

  // Start with a UTC date at the same wall-clock time.
  const asUtc = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second)
  );
  if (isNaN(asUtc)) return null;

  // Decide ET offset at that date.
  const dst = isUS_DST(asUtc);
  const offsetHours = dst ? 4 : 5; // ET to UTC

  // To get real UTC: add offset hours.
  return new Date(asUtc.getTime() + offsetHours * 60 * 60 * 1000);
}

async function main() {
  console.log(
    `${APPLY ? "kickoffs:sync (APPLY=yes)" : "kickoffs:audit (APPLY=no)"} using ${SEASON}`
  );

  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const dbRes = await client.query(
    "SELECT id, week, home_team, away_team, kickoff FROM games ORDER BY week, id"
  );
  const dbGames = dbRes.rows;
  console.log("DB games loaded:", dbGames.length);

  console.log("Fetching SportsDataIO schedule…");
  const resp = await fetch(SCHEDULE_URL);
  if (!resp.ok) {
    console.error(
      "FATAL: schedule fetch failed:",
      resp.status,
      await resp.text()
    );
    process.exit(1);
  }
  const schedule = await resp.json();
  console.log("SportsDataIO schedule entries:", schedule.length);

  // Build lookup: "away@home" -> { utc, week }
  const schedMap = new Map();
  for (const g of schedule) {
    if (!g.HomeTeam || !g.AwayTeam) continue;
    const key = `${toSlug(g.AwayTeam)}@${toSlug(g.HomeTeam)}`;
    const utc = parseSportsdataUtc(g);
    if (!utc || isNaN(utc)) continue;
    schedMap.set(key, {
      utc,
      week: g.Week,
      raw: g.DateTime || g.DateTimeUTC || "",
    });
  }

  const thresholdMin = 10; // only touch if off by >= 10 minutes
  const updates = [];

  for (const g of dbGames) {
    const key = `${toSlug(g.away_team)}@${toSlug(g.home_team)}`;
    const s = schedMap.get(key);
    if (!s) continue;

    const dbKick =
      g.kickoff != null ? new Date(g.kickoff) : null;
    if (!dbKick || isNaN(dbKick)) continue;

    const sdKick = s.utc;
    const deltaMin = Math.round(
      (sdKick.getTime() - dbKick.getTime()) / 60000
    );

    if (Math.abs(deltaMin) >= thresholdMin) {
      updates.push({
        id: g.id,
        week: g.week,
        home: g.home_team,
        away: g.away_team,
        oldUtc: dbKick.toISOString(),
        newUtc: sdKick.toISOString(),
        deltaMin,
      });
    }
  }

  if (!updates.length) {
    console.log(
      "No kickoff differences above threshold; nothing to change ✅"
    );
    await client.end();
    return;
  }

  console.log(`Proposed updates (${updates.length}):`);
  for (const u of updates) {
    console.log(
      `Week ${u.week} ${u.away} @ ${u.home}: ${u.oldUtc} -> ${u.newUtc} (${u.deltaMin} min)`
    );
  }

  if (!APPLY) {
    console.log(
      "Dry run only. Re-run with `npm run kickoffs:sync` to apply."
    );
    await client.end();
    return;
  }

  for (const u of updates) {
    await client.query("UPDATE games SET kickoff = $1 WHERE id = $2", [
      u.newUtc,
      u.id,
    ]);
  }

  console.log("Updates applied ✅");
  await client.end();
}

main().catch((err) => {
  console.error("Unhandled:", err);
  process.exit(1);
});
