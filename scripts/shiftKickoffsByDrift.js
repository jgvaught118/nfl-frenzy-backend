/* scripts/shiftKickoffsByDrift.js
 * Audit & optionally fix kickoff times by aligning to Odds API commence_time
 * Usage:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/shiftKickoffsByDrift.js      # dry run (prints deltas)
 *   APPLY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/shiftKickoffsByDrift.js  # writes fixes (>= 60min)
 */

const { Client } = require("pg");

const {
  RW_DB,
  ODDS_API_KEY,
  MIN_WEEK = "8",
} = process.env;

if (!RW_DB) { console.error("Missing RW_DB"); process.exit(2); }
if (!ODDS_API_KEY) { console.error("Missing ODDS_API_KEY"); process.exit(2); }

const APPLY = process.env.APPLY === "1";

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
    titans: "tennesseetitans",
    commanders: "washingtoncommanders",
  };
  if (nicknameToCity[x]) return nicknameToCity[x];
  return x;
}
const key = (home, away) => `${canonicalSlug(home)}__${canonicalSlug(away)}`;

async function fetchOddsSnapshot() {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url = `${base}?regions=us,us2&markets=spreads&dateFormat=iso&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`Odds API ${res.status} ${txt}`);
  }
  const events = await res.json();
  const map = new Map();
  for (const ev of events || []) {
    if (!ev.home_team || !ev.away_team || !ev.commence_time) continue;
    const commence = new Date(ev.commence_time); // ISO UTC
    map.set(key(ev.home_team, ev.away_team), { commence, home: ev.home_team, away: ev.away_team });
    map.set(key(ev.away_team, ev.home_team), { commence, home: ev.home_team, away: ev.away_team });
  }
  return map;
}

async function main() {
  console.log(`MIN_WEEK=${MIN_WEEK} APPLY=${APPLY ? "yes" : "no (dry)"}`);
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Pull games from DB (current+future)
  const { rows: games } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
       FROM games
      WHERE week >= $1
      ORDER BY week, kickoff, id`,
    [Number(MIN_WEEK)]
  );
  console.log(`DB rows to evaluate: ${games.length}`);

  const odds = await fetchOddsSnapshot();
  console.log(`Odds snapshot matchups: ${new Set([...odds.keys()]).size / 2}`);

  const audit = [];
  for (const g of games) {
    const hit = odds.get(key(g.home_team, g.away_team));
    if (!hit) continue;
    const dbKick = new Date(g.kickoff);
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
    console.log("No joinable games found between DB and odds snapshot.");
    await client.end();
    return;
  }

  // Pretty print a sample
  console.table(audit.slice(0, 20).map(x => ({
    id: x.id, week: x.week, deltaMin: x.deltaMin, db: x.dbKick, book: x.bookKick, match: x.match
  })));

  // Which need fix? (abs delta ≥ 60 min)
  const toFix = audit.filter(x => Math.abs(x.deltaMin) >= 60);
  console.log(`Candidates with |delta| ≥ 60min: ${toFix.length}`);

  if (!APPLY) {
    console.log("Dry run (APPLY=1 to write).");
    await client.end();
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
    updated += rowCount;
  }
  console.log(`Updated rows: ${updated}`);

  await client.end();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(2);
});
