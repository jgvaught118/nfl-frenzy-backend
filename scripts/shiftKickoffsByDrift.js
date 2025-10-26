// scripts/shiftKickoffsByDrift.js
/* eslint-disable no-console */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

const { Client } = require("pg");

const { RW_DB, ODDS_API_KEY } = process.env;
const MIN_WEEK = Number(process.env.MIN_WEEK || 8);
const TARGET = Number(process.env.TARGET_MINUTES || 240); // expected drift in minutes
const TOL = Number(process.env.TOL || 20);                 // tolerance window in minutes
const DRY = !process.env.APPLY;                            // APPLY=1 to write

if (!RW_DB) { console.error("❌ Missing env: RW_DB"); process.exit(2); }
if (!ODDS_API_KEY) { console.error("❌ Missing env: ODDS_API_KEY"); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    cardinals:"arizonacardinals", falcons:"atlantafalcons", ravens:"baltimoreravens", bills:"buffalobills",
    panthers:"carolinapanthers", bears:"chicagobears", bengals:"cincinnatibengals", browns:"clevelandbrowns",
    cowboys:"dallascowboys", broncos:"denverbroncos", lions:"detroitlions", packers:"greenbaypackers",
    texans:"houstontexans", colts:"indianapoliscolts", jaguars:"jacksonvillejaguars", chiefs:"kansascitychiefs",
    raiders:"lasvegasraiders", chargers:"losangeleschargers", rams:"losangelesrams", dolphins:"miamidolphins",
    vikings:"minnesotavikings", patriots:"newenglandpatriots", saints:"neworleanssaints", giants:"newyorkgiants",
    jets:"newyorkjets", eagles:"philadelphiaeagles", steelers:"pittsburghsteelers", niners:"sanfrancisco49ers",
    "49ers":"sanfrancisco49ers", seahawks:"seattleseahawks", buccaneers:"tampabaybuccaneers",
    titans:"tennesseetitans", commanders:"washingtoncommanders",
  };
  if (nicknameToCity[x]) return nicknameToCity[x];
  return x;
}
const keyFor = (home, away) => `${canonicalSlug(home)}__${canonicalSlug(away)}`;

async function loadOddsSnapshot() {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url = `${base}?regions=us&markets=spreads&dateFormat=iso&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`Odds API ${res.status} ${txt}`);
  }
  const events = await res.json();
  const m = new Map();
  for (const ev of events || []) {
    if (!ev.home_team || !ev.away_team || !ev.commence_time) continue;
    const when = new Date(ev.commence_time);
    m.set(keyFor(ev.home_team, ev.away_team), when);
    m.set(keyFor(ev.away_team, ev.home_team), when);
  }
  return m;
}

async function main() {
  console.log(`MIN_WEEK=${MIN_WEEK} TARGET=${TARGET}min TOL=±${TOL}min DRY=${DRY ? "yes" : "no (APPLY=1)"}`);

  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows: cwRows } = await client.query(`
    SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS cw FROM games;
  `);
  const currentWeek = Number(cwRows[0].cw);
  const floorWeek = Math.max(currentWeek, MIN_WEEK);

  const { rows: games } = await client.query(`
    SELECT id, week, home_team, away_team, kickoff
    FROM games
    WHERE week >= $1
    ORDER BY week, kickoff, id;
  `, [floorWeek]);

  console.log(`DB sample to evaluate: ${games.length} games (weeks >= ${floorWeek})`);

  const oddsTimes = await loadOddsSnapshot();
  console.log(`Odds snapshot events: ${oddsTimes.size / 2} unique matchups`);

  const toUpdate = [];
  for (const g of games) {
    const k = keyFor(g.home_team, g.away_team);
    const apiKick = oddsTimes.get(k);
    if (!apiKick) continue;

    const dbKick = new Date(g.kickoff);
    const deltaMin = Math.round((apiKick - dbKick) / 60000);
    if (Math.abs(deltaMin - TARGET) <= TOL) {
      // don't touch already-started games
      if (dbKick <= new Date(Date.now() - 5 * 60000)) continue;
      toUpdate.push({
        id: g.id, week: g.week, match: `${g.home_team} vs ${g.away_team}`,
        dbKickISO: dbKick.toISOString(), apiKickISO: apiKick.toISOString(), deltaMin
      });
    }
    await sleep(2);
  }

  if (!toUpdate.length) {
    console.log("No rows matched the target drift window; nothing to do.");
    await client.end();
    return;
  }

  console.table(toUpdate.map(x => ({
    id: x.id, week: x.week, deltaMin: x.deltaMin, match: x.match,
    dbKick: x.dbKickISO, apiKick: x.apiKickISO
  })));
  console.log(`Candidate updates: ${toUpdate.length}`);

  if (DRY) {
    console.log("DRY RUN — set APPLY=1 to write changes.");
    await client.end();
    return;
  }

  await client.query("BEGIN");
  try {
    for (const row of toUpdate) {
      await client.query(
        `UPDATE games
           SET kickoff = $1
         WHERE id = $2
           AND week >= $3
           AND kickoff > now() - interval '5 minutes'`,
        [row.apiKickISO, row.id, floorWeek]
      );
    }
    await client.query("COMMIT");
    console.log(`✅ Updated ${toUpdate.length} rows to API commence_time.`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Update failed; rolled back:", e.message);
    process.exit(2);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
