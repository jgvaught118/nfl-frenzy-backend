// scripts/fetchOdds.js
/* eslint-disable no-console */
const { Client } = require("pg");
const fetch = global.fetch || ((...args) => import("node-fetch").then(m => m.default(...args)));

const {
  RW_DB,
  ODDS_API_KEY,
  MIN_WEEK: MIN_WEEK_ENV,
  BOOKMAKERS: BOOKMAKERS_ENV,
  ALLOW_PAST: ALLOW_PAST_ENV,
} = process.env;

if (!RW_DB) { console.error("Missing env: RW_DB"); process.exit(2); }
if (!ODDS_API_KEY) { console.error("Missing env: ODDS_API_KEY"); process.exit(2); }

const BOOKMAKERS = (BOOKMAKERS_ENV || "caesars,draftkings,fanduel,betmgm")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const args = process.argv.slice(2);
const ARG    = (flag) => args.includes(flag);
const getVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : dflt; };

const ONLY_WEEK  = getVal("--week") ? Number(getVal("--week")) : undefined;
// IMPORTANT: we now use MIN_WEEK as the write guard lower bound
const MIN_WEEK   = Number(getVal("--minWeek", MIN_WEEK_ENV || "0"));
const DO_ALL     = ARG("--all");
const MAX_WEEKS  = Number(getVal("--maxWeeks", "3"));
const ALLOW_PAST = ARG("--allow-past") || ALLOW_PAST_ENV === "1";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- robust name matching ---------- */
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
    cardinals:"arizonacardinals", falcons:"atlantafalcons", ravens:"baltimoreravens",
    bills:"buffalobills", panthers:"carolinapanthers", bears:"chicagobears",
    bengals:"cincinnatibengals", browns:"clevelandbrowns", cowboys:"dallascowboys",
    broncos:"denverbroncos", lions:"detroitlions", packers:"greenbaypackers",
    texans:"houstontexans", colts:"indianapoliscolts", jaguars:"jacksonvillejaguars",
    chiefs:"kansascitychiefs", raiders:"lasvegasraiders", chargers:"losangeleschargers",
    rams:"losangelesrams", dolphins:"miamidolphins", vikings:"minnesotavikings",
    patriots:"newenglandpatriots", saints:"neworleanssaints", giants:"newyorkgiants",
    jets:"newyorkjets", eagles:"philadelphiaeagles", steelers:"pittsburghsteelers",
    niners:"sanfrancisco49ers", "49ers":"sanfrancisco49ers", seahawks:"seattleseahawks",
    buccaneers:"tampabaybuccaneers", bucs:"tampabaybuccaneers", titans:"tennesseetitans",
    commanders:"washingtoncommanders",
  };
  if (nicknameToCity[x]) return nicknameToCity[x];
  return x;
}
const matchKey = (home, away) => `${canonicalSlug(home)}__${canonicalSlug(away)}`;

/* ---------- DB helpers ---------- */
async function ensureOddsColumns(client) {
  await client.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS line_favorite    text,
      ADD COLUMN IF NOT EXISTS line_spread      numeric,
      ADD COLUMN IF NOT EXISTS line_over_under  numeric,
      ADD COLUMN IF NOT EXISTS line_source      text,
      ADD COLUMN IF NOT EXISTS line_updated_at  timestamptz,
      ADD COLUMN IF NOT EXISTS favorite         text,
      ADD COLUMN IF NOT EXISTS spread           numeric;
  `);
}
async function getCurrentWeek(client) {
  // Still useful for defaults/logging, but no longer used as the write guard.
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS current_week
    FROM games;
  `);
  return Number(rows[0].current_week || 1);
}
async function weeksCurrentAndFuture(client, lowerBoundWeek) {
  const { rows } = await client.query(
    `SELECT DISTINCT week FROM games WHERE week >= $1 ORDER BY week`, [lowerBoundWeek]
  );
  return rows.map(r => Number(r.week));
}
async function dbGamesForWeek(client, week) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
       FROM games
      WHERE week = $1
      ORDER BY kickoff, id`, [week]
  );
  return rows;
}

/* ---------- Odds API per-week window ---------- */
function isoNoMs(d) {
  // API requires YYYY-MM-DDTHH:MM:SSZ (no milliseconds)
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}
async function fetchOddsForWindow(fromIso, toIso) {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url = `${base}?regions=us,us2&markets=spreads,totals&oddsFormat=american&dateFormat=iso` +
              `&commenceTimeFrom=${encodeURIComponent(fromIso)}` +
              `&commenceTimeTo=${encodeURIComponent(toIso)}` +
              `&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`The Odds API ${res.status} ${txt}`);
  }
  return res.json();
}
function chooseBookmaker(books) {
  if (!Array.isArray(books) || !books.length) return null;
  return BOOKMAKERS.map(pref =>
    books.find(b => {
      const k = (b.key||"").toLowerCase();
      const n = (b.name||"").toLowerCase();
      return k === pref || n.includes(pref);
    })
  ).find(Boolean) || null;
}
function extractLine(chosen) {
  if (!chosen) return { favoriteName:null, spread:null, overUnder:null, provider:null };
  const provider = chosen.name || chosen.key || "Unknown";
  const spreads = (chosen.markets||[]).find(m => m.key === "spreads");
  const totals  = (chosen.markets||[]).find(m => m.key === "totals");
  let favoriteName = null, spread = null, overUnder = null;
  if (spreads?.outcomes?.length >= 2) {
    const [o1, o2] = spreads.outcomes;
    const fav = [o1,o2].find(o => typeof o.point === "number" && Number(o.point) < 0) || null;
    if (fav) { favoriteName = fav.name || null; spread = Math.abs(Number(fav.point)); }
    else if ([o1,o2].every(o => typeof o.point === "number" && Number(o.point) === 0)) { spread = 0; }
  }
  if (totals?.outcomes?.length) {
    const over  = totals.outcomes.find(o => /^over$/i.test(o.name || ""));
    const under = totals.outcomes.find(o => /^under$/i.test(o.name || ""));
    const pick = over || under || totals.outcomes[0];
    if (pick && typeof pick.point === "number") overUnder = Number(pick.point);
  }
  return { favoriteName, spread, overUnder, provider };
}

/* ---------- apply to DB ---------- */
async function updateOdds(client, gameId, odds, minWeekGuard) {
  // NEW: guard is based on MIN_WEEK, not currentWeek
  const guardWeek = ALLOW_PAST ? "" : "AND week >= $6";
  const guardKick = ALLOW_PAST ? "" : "AND kickoff > now()";

  const favorite = odds.favoriteName || null;
  const spread   = odds.spread != null ? Number(odds.spread) : null;
  const ou       = odds.overUnder != null ? Number(odds.overUnder) : null;
  const src      = odds.provider || "Unknown";

  const sql = `
    UPDATE games
       SET line_favorite   = $1,
           line_spread     = $2,
           line_over_under = $3,
           line_source     = $4,
           line_updated_at = now(),
           favorite        = COALESCE($1, favorite),
           spread          = COALESCE($2, spread)
     WHERE id = $5
       ${guardWeek}
       ${guardKick}
  `;
  const params = ALLOW_PAST ? [favorite, spread, ou, src, gameId]
                            : [favorite, spread, ou, src, gameId, minWeekGuard];
  const res = await client.query(sql, params);
  return res.rowCount;
}

/* ---------- main ---------- */
async function main() {
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false }});
  await client.connect();
  await ensureOddsColumns(client);

  const currentWeek = await getCurrentWeek(client);

  // decide which weeks to target
  let targetWeeks = [];
  if (ONLY_WEEK) {
    targetWeeks = [ONLY_WEEK];
  } else if (DO_ALL) {
    targetWeeks = await weeksCurrentAndFuture(client, MIN_WEEK || currentWeek);
  } else {
    // if nothing passed, just do max(MIN_WEEK, currentWeek)
    targetWeeks = [Math.max(MIN_WEEK || 1, currentWeek)];
  }

  // explicit filter for safety
  targetWeeks = targetWeeks.filter((w) => w >= MIN_WEEK);
  console.log(`\nTarget weeks: ${targetWeeks.join(", ")}  (current=${currentWeek}, minWeek=${MIN_WEEK}, allowPast=${ALLOW_PAST ? "yes":"no"})`);

  let totalUpdated = 0, totalMissing = 0, totalUnmatched = 0;

  for (const w of targetWeeks) {
    const games = await dbGamesForWeek(client, w);
    console.log(`\n===== ODDS: Week ${w} =====`);
    console.log(`→ DB games: ${games.length}`);
    if (!games.length) continue;

    // build window around this week's kickoffs
    const times = games.map(g => new Date(g.kickoff).getTime()).filter(Number.isFinite);
    const minT = Math.min(...times), maxT = Math.max(...times);
    const fromIso = isoNoMs(minT - 36*3600_000);
    const toIso   = isoNoMs(maxT + 36*3600_000);

    let events = [];
    try {
      events = await fetchOddsForWindow(fromIso, toIso);
      console.log(`Fetched ${events.length || 0} events for window ${fromIso} → ${toIso}`);
    } catch (e) {
      console.error(`✖ Odds fetch failed for week ${w}: ${e.message}`);
      continue;
    }

    const byKey = new Map();
    for (const ev of events || []) {
      const home = ev.home_team, away = ev.away_team;
      if (!home || !away) continue;
      const chosen = chooseBookmaker(ev.bookmakers || []);
      const payload = extractLine(chosen);
      byKey.set(matchKey(home, away), payload);
      byKey.set(matchKey(away, home), payload);
    }

    const rows = [];
    for (const g of games) {
      const hit = byKey.get(matchKey(g.home_team, g.away_team));
      if (!hit) {
        totalUnmatched++; rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "UNMATCHED", ""]); continue;
      }
      if (hit.spread == null && hit.overUnder == null && !hit.favoriteName) {
        totalMissing++; rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "MISSING", hit.provider || ""]); continue;
      }

      const changed = await updateOdds(client, g.id, hit, MIN_WEEK);
      if (changed) {
        totalUpdated += changed;
        const line = (hit.favoriteName ? `${hit.favoriteName} -${hit.spread ?? 0}` : "Pick/Even") +
                     (hit.overUnder != null ? ` (O/U ${hit.overUnder})` : "");
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, line, hit.provider || ""]);
      } else {
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "SKIPPED (guard: started)", hit.provider || ""]);
      }
      await sleep(15);
    }

    if (rows.length) console.table(rows.map(([id, match, line, source]) => ({ id, match, line, source })));
  }

  console.log("\n=== Odds Summary ===");
  console.log(`Updated rows:   ${totalUpdated}`);
  console.log(`Missing odds:   ${totalMissing}`);
  console.log(`Unmatched:      ${totalUnmatched}`);

  await client.end();
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });
