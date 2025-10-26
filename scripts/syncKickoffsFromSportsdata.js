/* eslint-disable no-console */
// scripts/syncKickoffsFromSportsdata.js
const { Client } = require("pg");
const fetch = require("node-fetch");

const {
  RW_DB,
  SPORTSDATA_API_KEY,
  SPORTSDATA_SEASON, // e.g., "2025REG"
  ODDS_API_KEY,
} = process.env;

if (!RW_DB) throw new Error("Missing env RW_DB");
if (!SPORTSDATA_API_KEY) throw new Error("Missing env SPORTSDATA_API_KEY");
if (!SPORTSDATA_SEASON) throw new Error("Missing env SPORTSDATA_SEASON");

const DAYS_FOR_ODDS_CHECK = 10;   // cross-check window with The Odds API
const UPDATE_THRESHOLD_MIN = 60;  // update only if |delta| >= 60 minutes

function toUtcDate(s) {
  // SportsDataIO typically returns ISO strings in UTC.
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function minutes(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}
function slugTeam(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function keyMatch(home, away) {
  return `${slugTeam(home)}__${slugTeam(away)}`;
}

async function fetchSportsdataSchedule() {
  // Example: https://api.sportsdata.io/v3/nfl/scores/json/Schedules/2025REG?key=API_KEY
  const base = "https://api.sportsdata.io/v3/nfl/scores/json";
  const url = `${base}/Schedules/${encodeURIComponent(SPORTSDATA_SEASON)}?key=${encodeURIComponent(SPORTSDATA_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SportsData schedules failed ${res.status}`);
  const arr = await res.json();
  const map = new Map();
  for (const g of arr || []) {
    // Fields vary by plan; prefer UTC date fields when present.
    const home = g.HomeTeam || g.HomeTeamName || g.HomeTeamKey || g.HomeTeamID;
    const away = g.AwayTeam || g.AwayTeamName || g.AwayTeamKey || g.AwayTeamID;
    const iso = g.Date || g.DateTime || g.GameTime || g.Updated || null;

    if (!home || !away || !iso) continue;
    const when = toUtcDate(iso);
    if (!when) continue;

    map.set(keyMatch(home, away), { when, src: "sportsdata", raw: g });
  }
  return map;
}

async function fetchOddsCommenceMap() {
  if (!ODDS_API_KEY) return new Map();
  // Only need upcoming window; the Odds API doesn’t page season-long.
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?regions=us,us2&markets=spreads&oddsFormat=american&dateFormat=iso&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) return new Map();

  const arr = await res.json();
  const now = Date.now();
  const horizon = now + DAYS_FOR_ODDS_CHECK * 24 * 3600 * 1000;

  const map = new Map();
  for (const e of arr || []) {
    const home = e.home_team, away = e.away_team;
    const iso = e.commence_time;
    if (!home || !away || !iso) continue;
    const dt = toUtcDate(iso);
    if (!dt) continue;

    // Only include games within the horizon
    if (dt.getTime() <= horizon) {
      map.set(keyMatch(home, away), { when: dt, src: "odds" });
    }
  }
  return map;
}

async function getCurrentWeek(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS w
    FROM games;
  `);
  return Number(rows[0].w);
}

async function loadDbGamesFromWeek(client, weekMin) {
  const { rows } = await client.query(`
    SELECT id, week, home_team, away_team, kickoff
    FROM games
    WHERE week >= $1
    ORDER BY week, kickoff, id
  `, [weekMin]);
  return rows.map(r => ({
    ...r,
    kickoff: r.kickoff ? new Date(r.kickoff) : null,
  }));
}

async function updateKickoff(client, id, whenUtc) {
  const q = `
    UPDATE games
       SET kickoff = $1
     WHERE id = $2
  `;
  await client.query(q, [whenUtc.toISOString(), id]);
}

(async function main() {
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const cur = await getCurrentWeek(client);
  const weekMin = cur + 1; // only future weeks (no global lock impact from already-started games)
  const dbRows = await loadDbGamesFromWeek(client, weekMin);

  console.log(`DB future rows (week >= ${weekMin}): ${dbRows.length}`);

  const sdMap = await fetchSportsdataSchedule();
  console.log(`SportsData schedule entries: ${sdMap.size}`);

  const oddsMap = await fetchOddsCommenceMap();
  console.log(`Odds commence entries (<= ${DAYS_FOR_ODDS_CHECK}d): ${oddsMap.size}`);

  const pending = [];
  const audit = [];

  for (const g of dbRows) {
    const k = keyMatch(g.home_team, g.away_team);
    const sd = sdMap.get(k);
    if (!sd) {
      audit.push({ id: g.id, week: g.week, issue: "no-sportsdata-match", home: g.home_team, away: g.away_team });
      continue;
    }

    const dbWhen = g.kickoff;
    const sdWhen = sd.when;
    const deltaToSD = dbWhen ? minutes(sdWhen, dbWhen) : null;

    // Optional: if within near horizon, compare Odds commence as a second opinion
    const o = oddsMap.get(k);
    const deltaOddsVsSD = o ? minutes(o.when, sdWhen) : null;

    audit.push({
      id: g.id,
      week: g.week,
      db: dbWhen ? dbWhen.toISOString() : null,
      sportsdata: sdWhen.toISOString(),
      odds: o ? o.when.toISOString() : null,
      delta_db_vs_sd_min: deltaToSD,
      delta_odds_vs_sd_min: deltaOddsVsSD,
    });

    // Update policy:
    // - Trust SportsData (UTC, DST-aware).
    // - Only update when |delta| >= UPDATE_THRESHOLD_MIN to avoid churn.
    if (deltaToSD === null || Math.abs(deltaToSD) >= UPDATE_THRESHOLD_MIN) {
      pending.push({ id: g.id, to: sdWhen });
    }
  }

  if (pending.length) {
    console.log(`Updating ${pending.length} games to SportsData UTC times...`);
    for (const p of pending) {
      await updateKickoff(client, p.id, p.to);
    }
  } else {
    console.log("No games required kickoff updates.");
  }

  // Helpful summary rows with large disagreement (≥ 30 min) to eyeball
  const noisy = audit.filter(r => {
    const d = r.delta_db_vs_sd_min;
    return typeof d === "number" && Math.abs(d) >= 30;
  });
  if (noisy.length) {
    console.table(noisy.map(r => ({
      id: r.id,
      week: r.week,
      delta_db_vs_sd_min: r.delta_db_vs_sd_min,
      db: r.db,
      sportsdata: r.sportsdata,
      odds: r.odds,
      delta_odds_vs_sd_min: r.delta_odds_vs_sd_min,
    })));
  }

  await client.end();
})().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});
