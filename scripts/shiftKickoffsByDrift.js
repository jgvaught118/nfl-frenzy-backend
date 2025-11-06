// scripts/shiftKickoffsByDrift.js
// Normalize bad kickoff times by aligning to The Odds API commence_time.
//
// Usage:
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/shiftKickoffsByDrift.js
//     - dry run, prints differences
//
//   APPLY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/shiftKickoffsByDrift.js
//     - writes changes where |delta| >= DRIFT_THRESHOLD_MIN
//
// Env:
//   RW_DB                - Postgres connection string
//   ODDS_API_KEY         - The Odds API key
//   MIN_WEEK             - Minimum week to adjust (default: 10)
//   DRIFT_THRESHOLD_MIN  - Min absolute diff (in minutes) required to update (default: 60)

require("dotenv").config();
const { Client } = require("pg");
const https = require("https");

const {
  RW_DB,
  ODDS_API_KEY,
  MIN_WEEK = "10",
  DRIFT_THRESHOLD_MIN = "60",
} = process.env;

if (!RW_DB) {
  console.error("FATAL: Missing RW_DB");
  process.exit(2);
}
if (!ODDS_API_KEY) {
  console.error("FATAL: Missing ODDS_API_KEY");
  process.exit(2);
}

const APPLY = process.env.APPLY === "1";
const THRESH_MIN = Number(DRIFT_THRESHOLD_MIN) || 60;

const agent = new https.Agent({ rejectUnauthorized: false });

function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalSlug(raw) {
  let x = slug(raw);

  // Normalize city abbreviations / variants
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

  // Map nicknames to canonical "city+nickname"
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
    titans: "tennesseetitans",
    commanders: "washingtoncommanders",
  };

  if (nicknameToCity[x]) return nicknameToCity[x];
  return x;
}

function matchupKey(home, away) {
  return `${canonicalSlug(home)}__${canonicalSlug(away)}`;
}

async function fetchOddsSnapshot() {
  const base =
    "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url =
    `${base}` +
    `?regions=us,us2` +
    `&markets=spreads` +
    `&dateFormat=iso` +
    `&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;

  const res = await fetch(url, { agent });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${txt}`);
  }
  const events = await res.json();

  const map = new Map();
  for (const ev of events || []) {
    if (!ev.home_team || !ev.away_team || !ev.commence_time) continue;

    const commence = new Date(ev.commence_time); // ISO UTC from Odds API
    if (Number.isNaN(commence.getTime())) continue;

    const k1 = matchupKey(ev.home_team, ev.away_team);
    const k2 = matchupKey(ev.away_team, ev.home_team);

    const payload = {
      commence,
      home: ev.home_team,
      away: ev.away_team,
    };

    map.set(k1, payload);
    map.set(k2, payload);
  }

  return map;
}

async function main() {
  console.log(
    `shiftKickoffsByDrift: MIN_WEEK=${MIN_WEEK} THRESH=${THRESH_MIN}min APPLY=${
      APPLY ? "yes" : "no (dry)"
    }`
  );

  const client = new Client({
    connectionString: RW_DB,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // 1) Load affected games from DB
    const { rows: games } = await client.query(
      `SELECT id, week, home_team, away_team, kickoff
         FROM games
        WHERE week >= $1
        ORDER BY week, kickoff, id`,
      [Number(MIN_WEEK)]
    );
    console.log(`DB rows to evaluate: ${games.length}`);

    if (!games.length) {
      console.log("No games found for given MIN_WEEK.");
      return;
    }

    // 2) Load odds snapshot
    const odds = await fetchOddsSnapshot();
    console.log(
      `Odds snapshot matchups (both directions counted): ${odds.size}`
    );

    const audit = [];

    for (const g of games) {
      const hit = odds.get(matchupKey(g.home_team, g.away_team));
      if (!hit) continue;

      const dbKick = g.kickoff ? new Date(g.kickoff) : null;
      if (!dbKick || Number.isNaN(dbKick.getTime())) continue;

      const deltaMin = Math.round((hit.commence - dbKick) / 60000); // book - db

      audit.push({
        id: g.id,
        week: g.week,
        match: `${g.away_team} @ ${g.home_team}`,
        dbKick: dbKick.toISOString(),
        bookKick: hit.commence.toISOString(),
        deltaMin,
      });
    }

    if (!audit.length) {
      console.log(
        "No joinable games between DB and Odds API for given MIN_WEEK."
      );
      return;
    }

    console.log("\nSample (first 25 rows):");
    console.table(
      audit.slice(0, 25).map((x) => ({
        id: x.id,
        week: x.week,
        deltaMin: x.deltaMin,
        db: x.dbKick,
        book: x.bookKick,
        match: x.match,
      }))
    );

    // 3) Filter to candidates that are clearly wrong
    const toFix = audit.filter((x) => Math.abs(x.deltaMin) >= THRESH_MIN);

    console.log(
      `\nCandidates with |delta| >= ${THRESH_MIN}min: ${toFix.length}`
    );

    if (!APPLY) {
      console.log(
        "Dry run complete. Set APPLY=1 to write these kickoff corrections."
      );
      return;
    }

    let updated = 0;
    for (const r of toFix) {
      const { rowCount } = await client.query(
        `UPDATE games
            SET kickoff = $1
          WHERE id = $2`,
        [r.bookKick, r.id]
      );
      if (rowCount) {
        console.log(
          `[UPDATE] id=${r.id} w${r.week} ${r.match}\n  ${r.dbKick} -> ${r.bookKick} (Δ=${r.deltaMin}m)`
        );
        updated += rowCount;
      }
    }

    console.log(`\nUpdated rows: ${updated}`);
  } catch (e) {
    console.error("Fatal:", e);
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(2);
});
