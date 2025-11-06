// scripts/syncKickoffsFromSportsdata.js
// Sync kickoff times from SportsDataIO into `games.kickoff` as TRUE UTC.
// Usage:
//   npm run kickoffs:audit   # dry-run
//   npm run kickoffs:sync    # apply fixes
//
// Requires env:
//   SPORTSDATA_API_KEY
//   SPORTSDATA_SEASON (e.g. "2025REG")
//   RW_DB or DATABASE_URL (your Railway URL)

require("dotenv").config();
const fetch = require("node-fetch");
const { Client } = require("pg");

const LIFECYCLE = process.env.npm_lifecycle_event || "";
const APPLY =
  LIFECYCLE === "kickoffs:sync" ||
  process.env.APPLY === "1";

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

console.log(
  `${LIFECYCLE || "kickoffs:script"} (APPLY=${APPLY ? "yes" : "no"}) using ${SEASON}`
);

const TEAM_MAP = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LV: "Las Vegas Raiders",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WSH: "Washington Commanders",
};

function mapTeams(homeCode, awayCode) {
  const home = TEAM_MAP[homeCode];
  const away = TEAM_MAP[awayCode];
  if (!home || !away) return null;
  return { home, away };
}

function parseUtc(dtUtc, dtLocal) {
  // Prefer DateTimeUTC if present and parseable
  if (dtUtc) {
    const d = new Date(dtUtc);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Fallback: if only DateTime is provided and clearly has a timezone,
  // let JS parse it. If it's a naive local time, we *don't* trust it here.
  if (dtLocal) {
    const d = new Date(dtLocal);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function isPlaceholderMidnight(date) {
  if (!date) return false;
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0
  );
}

async function main() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const { rows: games } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
     FROM games
     ORDER BY week, id`
  );

  console.log(`DB games loaded: ${games.length}`);

  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${SEASON}?key=${API_KEY}`;
  console.log("Fetching SportsDataIO schedule…");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SportsDataIO Schedules HTTP ${res.status}`);
  }
  const schedule = await res.json();
  console.log(`SportsDataIO schedule entries: ${schedule.length}`);

  // Index schedule by normalized "Home Team Name|Away Team Name"
  const schedIndex = new Map();

  for (const s of schedule) {
    const map = mapTeams(s.HomeTeam, s.AwayTeam);
    if (!map) continue;

    const key = `${map.home}|${map.away}`;
    const candidateUtc = parseUtc(s.DateTimeUTC, s.DateTime);

    // Prefer entries with a real UTC time
    if (!schedIndex.has(key)) {
      schedIndex.set(key, { ...s, mappedHome: map.home, mappedAway: map.away, kickoffUtc: candidateUtc });
    } else {
      const existing = schedIndex.get(key);
      if (!existing.kickoffUtc && candidateUtc) {
        schedIndex.set(key, { ...s, mappedHome: map.home, mappedAway: map.away, kickoffUtc: candidateUtc });
      }
    }
  }

  const THRESH_MS = 60 * 60 * 1000; // 60 minutes

  let updateCount = 0;

  for (const g of games) {
    const key = `${g.home_team}|${g.away_team}`;
    const s = schedIndex.get(key);

    if (!s) {
      // No schedule match; skip quietly (pre/postseason, data drift, etc.)
      continue;
    }

    const sdUtc = s.kickoffUtc;
    if (!sdUtc) {
      // If SportsDataIO still has no real time (TBD), do not force junk into DB.
      continue;
    }

    // Ignore obvious placeholder midnight times to avoid early global lock
    if (isPlaceholderMidnight(sdUtc)) {
      continue;
    }

    const dbUtc = g.kickoff ? new Date(g.kickoff) : null;

    if (!dbUtc || Number.isNaN(dbUtc.getTime())) {
      console.log(
        `[MISS] id=${g.id} w${g.week} ${g.away_team} @ ${g.home_team} has no valid kickoff;`
        + ` would set -> ${sdUtc.toISOString()}`
      );
      if (APPLY) {
        await client.query(
          "UPDATE games SET kickoff = $1 WHERE id = $2",
          [sdUtc.toISOString(), g.id]
        );
        updateCount++;
      }
      continue;
    }

    const delta = sdUtc.getTime() - dbUtc.getTime();
    const absDelta = Math.abs(delta);

    if (absDelta >= THRESH_MS) {
      console.log(
        `[FIX] id=${g.id} w${g.week} ${g.away_team} @ ${g.home_team}\n`
        + `     DB:  ${dbUtc.toISOString()}\n`
        + `     API: ${sdUtc.toISOString()}\n`
        + `     Δ = ${(delta / 60000).toFixed(1)} min`
      );
      if (APPLY) {
        await client.query(
          "UPDATE games SET kickoff = $1 WHERE id = $2",
          [sdUtc.toISOString(), g.id]
        );
        updateCount++;
      }
    }
  }

  if (APPLY) {
    console.log(`Updated rows: ${updateCount}`);
  } else {
    console.log(`Dry run only. Rows that would be updated: ${updateCount}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
