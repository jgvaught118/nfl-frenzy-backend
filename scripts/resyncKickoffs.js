/* scripts/resyncKickoffs.js
 * Align kickoff times by preferring The Odds API commence_time, and
 * falling back to SportsDataIO DateTimeUTC. Overwrites targeted weeks.
 *
 * Env:
 *   RW_DB                  - Postgres connect string
 *   ODDS_API_KEY           - The Odds API key
 *   SPORTSDATA_API_KEY     - SportsDataIO key
 *   SPORTSDATA_SEASON      - e.g. "2025REG" (default)
 *   MIN_WEEK               - first week to touch (default 12)
 *   APPLY=1                - actually write changes (otherwise dry run)
 *   FORCE=1                - overwrite even if diff < threshold (default off)
 *   DIFF_MINUTES           - update if |delta| >= this (default 1)
 *
 * Usage examples:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/resyncKickoffs.js
 *   APPLY=1 MIN_WEEK=12 NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/resyncKickoffs.js
 *   APPLY=1 MIN_WEEK=12 FORCE=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/resyncKickoffs.js
 */

const pg = require("pg");
const axios = require("axios");

const {
  RW_DB,
  ODDS_API_KEY,
  SPORTSDATA_API_KEY,
  SPORTSDATA_SEASON = "2025REG",
  MIN_WEEK: MIN_WEEK_ENV,
  DIFF_MINUTES: DIFF_MIN_ENV,
  APPLY: APPLY_ENV,
  FORCE: FORCE_ENV,
} = process.env;

if (!RW_DB) {
  console.error("FATAL: RW_DB not set.");
  process.exit(1);
}
if (!ODDS_API_KEY) {
  console.error("FATAL: ODDS_API_KEY not set.");
  process.exit(1);
}
if (!SPORTSDATA_API_KEY) {
  console.error("FATAL: SPORTSDATA_API_KEY not set.");
  process.exit(1);
}

const APPLY = String(APPLY_ENV || "").trim() === "1";
const FORCE = String(FORCE_ENV || "").trim() === "1";
const MIN_WEEK = Number(MIN_WEEK_ENV || 12);
const DIFF_MIN = Number(DIFF_MIN_ENV || 1); // minutes threshold for updates

const { Client } = pg;

// ---------- team name helpers ----------
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function canonicalSlug(raw) {
  let x = slug(raw);
  x = x.replace(/^la(?=(rams|chargers)$)/, "losangeles");
  x = x.replace(/^ny(?=(jets|giants)$)/, "newyork");
  x = x.replace(/^kc(?=chiefs$)/, "kansascity");
  x = x.replace(/^ne(?=patriots$)/, "newengland");
  x = x.replace(/^no(?=saints$)/, "neworleans");
  x = x.replace(/^sf(?=49ers$)/, "sanfrancisco");
  x = x.replace(/^tb(?=(buccaneers|bucs)$)/, "tampabay");
  x = x.replace(/^gb(?=packers$)/, "greenbay");
  x = x.replace(/^lv(?=raiders$)/, "lasvegas");
  x = x.replace(/^jax(?=jaguars$)/, "jacksonville");
  x = x.replace(/^was(?=(footballteam|commanders)$)/, "washingtoncommanders");
  x = x.replace(/^washington(?=footballteam$)/, "washingtoncommanders");

  const nicknameToCity = {
    cardinals: "arizonacardinals",
    falcons: "atlantafalcons",
    ravens: "baltimoreravens",
    bills: "buffalobills",
    panthers: "carolinapanthers",
    bears: "chicagobears",
    bengals: "cincinnatibengals",
    browns: "clevelandbrowns",
    cowboys: "dallascowboys",
    broncos: "denverbroncos",
    lions: "detroitlions",
    packers: "greenbaypackers",
    texans: "houstontexans",
    colts: "indianapoliscolts",
    jaguars: "jacksonvillejaguars",
    chiefs: "kansascitychiefs",
    raiders: "lasvegasraiders",
    chargers: "losangeleschargers",
    rams: "losangelesrams",
    dolphins: "miamidolphins",
    vikings: "minnesotavikings",
    patriots: "newenglandpatriots",
    saints: "neworleanssaints",
    giants: "newyorkgiants",
    jets: "newyorkjets",
    eagles: "philadelphiaeagles",
    steelers: "pittsburghsteelers",
    niners: "sanfrancisco49ers",
    "49ers": "sanfrancisco49ers",
    seahawks: "seattleseahawks",
    buccaneers: "tampabaybuccaneers",
    bucs: "tampabaybuccaneers",
    titans: "tennesseetitans",
    commanders: "washingtoncommanders",
  };
  if (nicknameToCity[x]) return nicknameToCity[x];
  return x;
}
const matchKey = (home, away) =>
  `${canonicalSlug(home)}__${canonicalSlug(away)}`;

// ---------- fetchers ----------
async function fetchOddsCommenceMap() {
  const url =
    `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?regions=us,us2&markets=spreads&dateFormat=iso&apiKey=${encodeURIComponent(
      ODDS_API_KEY
    )}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`The Odds API ${res.status} ${txt}`.trim());
  }

  const events = await res.json();
  const map = new Map();
  for (const ev of events || []) {
    if (!ev.home_team || !ev.away_team || !ev.commence_time) continue;
    const d = new Date(ev.commence_time); // ISO UTC
    if (isNaN(d.getTime())) continue;
    map.set(matchKey(ev.home_team, ev.away_team), d);
    map.set(matchKey(ev.away_team, ev.home_team), d);
  }
  return map;
}

async function fetchSportsdataScheduleMap(season) {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${season}`;
  const res = await axios.get(url, {
    headers: { "Ocp-Apim-Subscription-Key": SPORTSDATA_API_KEY },
  });
  const sched = Array.isArray(res.data) ? res.data : [];
  const map = new Map();
  for (const g of sched) {
    const week = g.Week;
    const home = g.HomeTeamName || g.HomeTeam;
    const away = g.AwayTeamName || g.AwayTeam;
    if (!week || !home || !away) continue;

    // Prefer DateTimeUTC if present; otherwise parse DateTime as UTC-equivalent
    let isoUtc = null;
    if (g.DateTimeUTC) {
      const d = new Date(g.DateTimeUTC);
      if (!isNaN(d.getTime())) isoUtc = d.toISOString();
    } else if (g.DateTime) {
      // SportsDataIO's DateTime field is local (ET for most), but
      // there are international games; we can't infer reliably.
      // If DateTimeUTC is absent, treat DateTime as UTC *only* as a last resort.
      const d2 = new Date(g.DateTime);
      if (!isNaN(d2.getTime())) isoUtc = d2.toISOString();
    }

    if (!isoUtc) continue;

    map.set(`${week}|${matchKey(home, away)}`, isoUtc);
  }
  return map;
}

// ---------- db helpers ----------
async function dbGamesFromWeek(client, minWeek) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
       FROM games
      WHERE week >= $1
      ORDER BY week, kickoff, id`,
    [Number(minWeek)]
  );
  return rows;
}

// ---------- main ----------
async function main() {
  console.log(
    `resyncKickoffs: APPLY=${APPLY ? "yes" : "no (dry)"} FORCE=${
      FORCE ? "yes" : "no"
    } MIN_WEEK=${MIN_WEEK} DIFF>=${DIFF_MIN}m  SEASON=${SPORTSDATA_SEASON}`
  );

  const client = new Client({
    connectionString: RW_DB,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const games = await dbGamesFromWeek(client, MIN_WEEK);
  console.log(`DB games to consider: ${games.length}`);

  let oddsMap = new Map();
  try {
    oddsMap = await fetchOddsCommenceMap();
    console.log(`Odds events with commence_time: ~${oddsMap.size / 2}`);
  } catch (e) {
    console.warn(`Odds fetch failed (will rely on SportsDataIO): ${e.message}`);
  }

  const sdioMap = await fetchSportsdataScheduleMap(SPORTSDATA_SEASON);
  console.log(`SportsDataIO schedule entries mapped: ${sdioMap.size}`);

  let updates = 0;
  const audit = [];

  for (const g of games) {
    const key = matchKey(g.home_team, g.away_team);
    const oddsKick = oddsMap.get(key) || null;

    let targetIso = null;
    if (oddsKick) {
      targetIso = oddsKick.toISOString();
    } else {
      const sdioIso = sdioMap.get(`${g.week}|${key}`) || null;
      if (sdioIso) targetIso = sdioIso;
    }

    if (!targetIso) {
      audit.push({
        id: g.id,
        w: g.week,
        match: `${g.away_team} @ ${g.home_team}`,
        action: "SKIP (no odds/SDIO time)",
      });
      continue;
    }

    const dbIso = g.kickoff ? new Date(g.kickoff).toISOString() : null;
    const diffMin =
      dbIso == null
        ? Infinity
        : Math.abs((new Date(targetIso) - new Date(dbIso)) / 60000);

    const shouldWrite = FORCE || dbIso == null || diffMin >= DIFF_MIN;

    audit.push({
      id: g.id,
      w: g.week,
      match: `${g.away_team} vs ${g.home_team}`,
      db: dbIso,
      to: targetIso,
      source: oddsKick ? "odds" : "sportsdata",
      deltaMin: diffMin === Infinity ? "null→set" : Math.round(diffMin),
      action: shouldWrite ? (APPLY ? "UPDATE" : "WOULD_UPDATE") : "NOOP",
    });

    if (shouldWrite && APPLY) {
      await client.query(`UPDATE games SET kickoff = $1 WHERE id = $2`, [
        targetIso,
        g.id,
      ]);
      updates++;
    }
  }

  // Pretty print first 30 for quick sanity
  console.table(
    audit.slice(0, 30).map((r) => ({
      id: r.id,
      w: r.w,
      action: r.action,
      source: r.source,
      deltaMin: r.deltaMin,
      db: r.db,
      to: r.to,
      match: r.match,
    }))
  );

  console.log(`Updated rows: ${updates}`);
  await client.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
