/* eslint-disable no-console */
/**
 * Sync all game kickoff times from SportsDataIO official schedule.
 *
 * Uses:
 *  - SPORTSDATA_API_KEY
 *  - SPORTSDATA_SEASON  (e.g. "2025REG")
 *  - RW_DB (Railway Postgres URL) or DATABASE_URL
 *
 * Logic:
 *  - Fetch full NFL schedule for the season from SportsDataIO.
 *  - For each DB game (by week, home_team, away_team):
 *      - Find matching SportsData game via canonicalized names.
 *      - Use SportsData DateTimeUTC as the single source of truth.
 *      - If |dbKickoff - apiKickoff| >= 60s, update DB kickoff.
 *
 * This avoids “blind +4 hours” and handles DST correctly.
 */

const { Client } = require("pg");
const fetch = require("node-fetch");

const {
  SPORTSDATA_API_KEY,
  SPORTSDATA_SEASON,
  RW_DB,
  DATABASE_URL,
} = process.env;

if (!SPORTSDATA_API_KEY) {
  console.error("Missing env: SPORTSDATA_API_KEY");
  process.exit(2);
}
if (!SPORTSDATA_SEASON) {
  console.error("Missing env: SPORTSDATA_SEASON (e.g. 2025REG)");
  process.exit(2);
}

const DB_URL = RW_DB || DATABASE_URL;
if (!DB_URL) {
  console.error("Missing env: RW_DB or DATABASE_URL");
  process.exit(2);
}

const APPLY = String(process.env.APPLY || "").toLowerCase() === "1";
const MIN_WEEK = Number(process.env.MIN_WEEK || 1);
const MAX_DELTA_SEC = 60; // if >= 60s difference, we correct

// ---------- Helpers ----------

const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function canonicalTeam(raw) {
  const x = slug(raw);

  // direct map for standard NFL teams
  const map = {
    // full names / nicknames normalized
    arizonacardinals: "arizonacardinals",
    cardinals: "arizonacardinals",

    atlantafalcons: "atlantafalcons",
    falcons: "atlantafalcons",

    baltimoreravens: "baltimoreravens",
    ravens: "baltimoreravens",

    buffalobills: "buffalobills",
    bills: "buffalobills",

    carolinapanthers: "carolinapanthers",
    panthers: "carolinapanthers",

    chicagobears: "chicagobears",
    bears: "chicagobears",

    cincinnatibengals: "cincinnatibengals",
    bengals: "cincinnatibengals",

    clevelandbrowns: "clevelandbrowns",
    browns: "clevelandbrowns",

    dallascowboys: "dallascowboys",
    cowboys: "dallascowboys",

    denverbroncos: "denverbroncos",
    broncos: "denverbroncos",

    detroitlions: "detroitlions",
    lions: "detroitlions",

    greenbaypackers: "greenbaypackers",
    packers: "greenbaypackers",
    gbpackers: "greenbaypackers",

    houstontexans: "houstontexans",
    texans: "houstontexans",

    indianapolisco lts: "indianapoliscolts",
    indianapoliscolts: "indianapoliscolts",
    colts: "indianapoliscolts",

    jacksonvillejaguars: "jacksonvillejaguars",
    jags: "jacksonvillejaguars",
    jaguars: "jacksonvillejaguars",

    kansascitychiefs: "kansascitychiefs",
    chiefs: "kansascitychiefs",
    kcchiefs: "kansascitychiefs",

    lasvegasraiders: "lasvegasraiders",
    raiders: "lasvegasraiders",

    losangeleschargers: "losangeleschargers",
    chargers: "losangeleschargers",
    lachargers: "losangeleschargers",

    losangelesrams: "losangelesrams",
    rams: "losangelesrams",
    larams: "losangelesrams",

    miamidolphins: "miamidolphins",
    dolphins: "miamidolphins",

    minnesotavikings: "minnesotavikings",
    vikings: "minnesotavikings",

    newenglandpatriots: "newenglandpatriots",
    patriots: "newenglandpatriots",
    nepatriots: "newenglandpatriots",

    neworleanssaints: "neworleanssaints",
    saints: "neworleanssaints",

    newyorkgiants: "newyorkgiants",
    giants: "newyorkgiants",
    nygiants: "newyorkgiants",

    newyorkjets: "newyorkjets",
    jets: "newyorkjets",
    nyjets: "newyorkjets",

    philadelphiaeagles: "philadelphiaeagles",
    eagles: "philadelphiaeagles",

    pittsburghsteelers: "pittsburghsteelers",
    steelers: "pittsburghsteelers",

    sanfrancisco49ers: "sanfrancisco49ers",
    "49ers": "sanfrancisco49ers",
    niners: "sanfrancisco49ers",

    seattleseahawks: "seattleseahawks",
    seahawks: "seattleseahawks",

    tampabaybuccaneers: "tampabaybuccaneers",
    buccaneers: "tampabaybuccaneers",
    bucs: "tampabaybuccaneers",

    tennesseetitans: "tennesseetitans",
    titans: "tennesseetitans",

    washingtoncommanders: "washingtoncommanders",
    commanders: "washingtoncommanders",
    washingtonfootballteam: "washingtoncommanders",
  };

  if (map[x]) return map[x];

  // fallback: keep as-is slug
  return x;
}

const matchKey = (home, away) =>
  `${canonicalTeam(home)}__${canonicalTeam(away)}`;

// ---------- SportsData fetch ----------

async function fetchSportsdataSchedule() {
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/Schedules/${encodeURIComponent(
    SPORTSDATA_SEASON
  )}?key=${encodeURIComponent(SPORTSDATA_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SportsData schedule failed ${res.status} ${txt}`.trim());
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("SportsData schedule: unexpected response shape");
  }

  const map = new Map();

  for (const g of data) {
    const home = g.HomeTeam || g.HomeTeamName || g.HomeDisplayName;
    const away = g.AwayTeam || g.AwayTeamName || g.AwayDisplayName;
    if (!home || !away) continue;

    // Prefer DateTimeUTC; fall back to DateTime if needed
    const utc =
      g.DateTimeUTC ||
      g.DateTime ||
      g.GameDate ||
      null;

    if (!utc) continue;

    const kickoff = new Date(utc);
    if (Number.isNaN(kickoff.getTime())) continue;

    const key1 = matchKey(home, away);
    const key2 = matchKey(away, home);

    const payload = {
      home,
      away,
      kickoff,
      raw: utc,
    };

    map.set(key1, payload);
    map.set(key2, payload);
  }

  console.log("SportsData schedule entries:", map.size);
  return map;
}

// ---------- DB helpers ----------

async function getDbGames(client) {
  const { rows } = await client.query(
    `
    SELECT id, week, home_team, away_team, kickoff
    FROM games
    WHERE kickoff IS NOT NULL
      AND week >= $1
    ORDER BY week, kickoff, id
    `,
    [MIN_WEEK]
  );
  return rows.map((r) => ({
    id: r.id,
    week: Number(r.week),
    home_team: r.home_team,
    away_team: r.away_team,
    kickoff: new Date(r.kickoff),
  }));
}

async function updateKickoff(client, id, newKickoff) {
  await client.query(
    `
    UPDATE games
       SET kickoff = $1
     WHERE id = $2
    `,
    [newKickoff.toISOString(), id]
  );
}

// ---------- Main ----------

async function main() {
  console.log(
    `Using DB=${DB_URL.replace(/:\/\/.*@/, "://***:***@")} SEASON=${SPORTSDATA_SEASON} MIN_WEEK=${MIN_WEEK} APPLY=${
      APPLY ? "yes" : "no (dry)"
    }`
  );

  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const games = await getDbGames(client);
  console.log("DB games to evaluate:", games.length);

  const schedule = await fetchSportsdataSchedule();

  let touched = 0;
  const table = [];

  for (const g of games) {
    const key = matchKey(g.home_team, g.away_team);
    const apiGame = schedule.get(key);
    if (!apiGame) continue;

    const dbTs = g.kickoff.getTime();
    const apiTs = apiGame.kickoff.getTime();
    const deltaSec = Math.round((apiTs - dbTs) / 1000);

    if (Math.abs(deltaSec) >= MAX_DELTA_SEC) {
      table.push({
        id: g.id,
        week: g.week,
        deltaMin: deltaSec / 60,
        db: g.kickoff.toISOString(),
        api: apiGame.kickoff.toISOString(),
        match: `${apiGame.away} @ ${apiGame.home}`,
      });

      if (APPLY) {
        await updateKickoff(client, g.id, apiGame.kickoff);
        touched++;
      }
    }
  }

  if (table.length) {
    console.log("Kickoff differences (|delta| >= 60s):");
    console.table(table);
  } else {
    console.log("No kickoff differences >= 60s detected.");
  }

  console.log(`Updated rows: ${touched}`);

  await client.end();

  if (!APPLY && table.length > 0) {
    console.log("Dry run only. Set APPLY=1 to write changes.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
