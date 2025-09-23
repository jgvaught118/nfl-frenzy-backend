#!/usr/bin/env node
/* scripts/fetchScores.js
 * Node 18+ (global fetch). If fetch is missing, falls back to node-fetch.
 * npm i pg (and optionally node-fetch if you’re on older Node).
 *
 * USAGE:
 *   node scripts/fetchScores.js --week 3          # audit only
 *   node scripts/fetchScores.js --week 3 --fix    # ingest+audit+fix
 *   node scripts/fetchScores.js --all             # audit active/recent weeks
 *   node scripts/fetchScores.js --all --fix       # ingest+audit+fix
 *
 * ENV:
 *   RW_DB=postgresql://user:pass@host:port/db?sslmode=require  (REQUIRED)
 *   RAILWAY_URL=https://your-app.up.railway.app               (OPTIONAL for ingest)
 *   ADMIN_KEY=<admin-bearer-token>                             (OPTIONAL for ingest)
 */

const { Client } = require("pg");

// Fetch (Node 18+ has global fetch; else try node-fetch)
let fetchFn = global.fetch;
if (!fetchFn) {
  try { fetchFn = require("node-fetch"); }
  catch { console.error("❌ No fetch available. Run: npm i node-fetch (or use Node 18+)"); process.exit(2); }
}

/** ---------- ENV ---------- **/
const RW_DB = process.env.RW_DB;
const RAILWAY_URL = process.env.RAILWAY_URL || null;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

if (!RW_DB) {
  console.error("❌ Missing RW_DB env (Postgres URI).");
  process.exit(2);
}

/** ---------- CLI ---------- **/
const argv = process.argv.slice(2);
function getFlag(name) { return argv.includes(name); }
function getVal(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i+1] : undefined; }

const ONLY_WEEK   = getVal("--week") ? Number(getVal("--week")) : undefined;
const DO_ALL      = getFlag("--all");
const DO_FIX      = getFlag("--fix");
const SEASONTYPE  = getVal("--seasontype") ? Number(getVal("--seasontype")) : 2; // 2 = regular season
const YEAR        = getVal("--year") ? Number(getVal("--year")) : (() => {
  const d = new Date(); const y = d.getUTCFullYear(); const m = d.getUTCMonth()+1; // 1..12
  return m >= 8 ? y : y - 1; // NFL season year heuristic
})();

/** ---------- Helpers ---------- **/
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Keep letters AND digits so "49ers" keeps the "49"
const norm = (s) => String(s || "")
  .normalize("NFKD")
  .toLowerCase()
  .replace(/&/g, "and")
  .replace(/[^a-z0-9]/g, "");

async function postJSON(url, body, headers = {}) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`POST ${url} -> ${res.status} ${res.statusText} ${txt}`.trim());
  }
  return res.json().catch(() => ({}));
}

/** ---------- ESPN ---------- **/
async function fetchEspnWeek(week, year = YEAR, seasontype = SEASONTYPE) {
  // Using the “site” API variant—it’s the most stable for this payload shape.
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${year}&week=${week}&seasontype=${seasontype}`;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`ESPN ${r.status} ${r.statusText}`);
  const data = await r.json();

  const map = new Map();
  for (const ev of data?.events || []) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;

    // Completed/final only
    const st = comp?.status?.type || {};
    const done = !!st.completed || /post/i.test(st.state || st.name || "");
    if (!done) continue;

    const [c1, c2] = comp.competitors || [];
    if (!c1 || !c2) continue;

    const home = c1.homeAway === "home" ? c1 : c2;
    const away = c1.homeAway === "home" ? c2 : c1;

    const hName = home?.team?.displayName || home?.team?.name || home?.team?.location;
    const aName = away?.team?.displayName || away?.team?.name || away?.team?.location;
    if (!hName || !aName) continue;

    const hScore = home?.score != null ? Number(home.score) : null;
    const aScore = away?.score != null ? Number(away.score) : null;

    const payload = { espnHome: hName, espnAway: aName, espnHomeScore: hScore, espnAwayScore: aScore };
    map.set(`${norm(hName)}__${norm(aName)}`, payload);
    map.set(`${norm(aName)}__${norm(hName)}`, payload); // allow reverse match
  }
  return map;
}

/** ---------- DB ---------- **/
async function withClient(fn) {
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await fn(client); }
  finally { await client.end(); }
}

async function ingestWeek(week) {
  if (!RAILWAY_URL || !ADMIN_KEY) {
    console.log("⚠️  Ingest skipped (RAILWAY_URL or ADMIN_KEY not set).");
    return;
  }
  const url = new URL("/admin/scores/fetch-now", RAILWAY_URL).toString();
  const res = await postJSON(url, { week }, { Authorization: `Bearer ${ADMIN_KEY}` }).catch(e => {
    console.error(`  ✖ ingest week ${week}:`, e.message);
    return null;
  });
  if (res) console.log("  ✔ ingest:", res);
}

async function dbWeeksNeedingUpdate(client) {
  const { rows } = await client.query(`
    SELECT DISTINCT week
    FROM games
    WHERE kickoff < NOW()
      AND (home_score IS NULL OR away_score IS NULL)
    ORDER BY week
  `);
  return rows.map(r => Number(r.week));
}

async function dbAllStartedWeeks(client) {
  const { rows } = await client.query(`
    SELECT DISTINCT week
    FROM games
    WHERE kickoff < NOW()
    ORDER BY week
  `);
  return rows.map(r => Number(r.week));
}

async function dbRecentOrNullWeeks(client) {
  // Prefer recent weeks (last 8 days) OR any with NULLs
  const { rows } = await client.query(`
    SELECT DISTINCT week
    FROM games
    WHERE kickoff >= NOW() - INTERVAL '8 days'
       OR (home_score IS NULL OR away_score IS NULL)
    ORDER BY week
  `);
  return rows.map(r => Number(r.week));
}

async function dbGamesForWeek(client, week) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, home_score, away_score
     FROM games
     WHERE week = $1
     ORDER BY id`,
    [week]
  );
  return rows;
}

async function updateGameScores(client, id, home, away, week) {
  await client.query(`UPDATE games SET home_score=$1, away_score=$2 WHERE id=$3 AND week=$4`, [home, away, id, week]);
}

/** ---------- Compare ---------- **/
function compare(dbGame, espnMap) {
  const k = `${norm(dbGame.home_team)}__${norm(dbGame.away_team)}`;
  const e = espnMap.get(k);
  if (!e) return { unmatched: true };

  const dbHomeIsEspnHome = norm(dbGame.home_team) === norm(e.espnHome);
  const shouldHome = dbHomeIsEspnHome ? e.espnHomeScore : e.espnAwayScore;
  const shouldAway = dbHomeIsEspnHome ? e.espnAwayScore : e.espnHomeScore;

  const mismatch =
    (dbGame.home_score ?? null) !== (shouldHome ?? null) ||
    (dbGame.away_score ?? null) !== (shouldAway ?? null);

  return {
    unmatched: false,
    mismatch,
    shouldHome,
    shouldAway,
    espnPair: { home: e.espnHome, away: e.espnAway }
  };
}

/** ---------- Main ---------- **/
(async () => {
  const weeks = await withClient(async (client) => {
    if (ONLY_WEEK) return [ONLY_WEEK];
    if (DO_ALL) return await dbAllStartedWeeks(client);
    // default: just recent or any with NULLs
    return await dbRecentOrNullWeeks(client);
  });

  if (!weeks.length) {
    console.log("No weeks to process. Done.");
    return;
  }

  let totalMismatch = 0;
  let totalUnmatched = 0;
  let totalFixed = 0;

  for (const week of weeks) {
    console.log(`\n===== WEEK ${week} (year ${YEAR}, type ${SEASONTYPE}) =====`);

    // Optional ingest if fixing (so we always compare against your latest feed)
    if (DO_FIX) {
      await ingestWeek(week);
      await sleep(500);
    }

    const espn = await fetchEspnWeek(week).catch(e => {
      console.error(`  ✖ ESPN fetch week ${week}:`, e.message);
      return null;
    });
    if (!espn) continue;

    await withClient(async (client) => {
      const games = await dbGamesForWeek(client, week);

      const mismatches = [];
      const unmatched = [];

      for (const g of games) {
        const cmp = compare(g, espn);
        if (cmp.unmatched) {
          unmatched.push({ id: g.id, home_team: g.home_team, away_team: g.away_team });
          continue;
        }
        if (cmp.mismatch) {
          mismatches.push({
            id: g.id,
            match: `${g.home_team} vs ${g.away_team}`,
            db: `${g.home_score ?? "∅"}-${g.away_score ?? "∅"}`,
            should: `${cmp.shouldHome}-${cmp.shouldAway}`,
            shouldHome: cmp.shouldHome,
            shouldAway: cmp.shouldAway
          });
        }
      }

      console.log(`→ DB rows: ${games.length}`);
      console.log(`→ Mismatches: ${mismatches.length}`);
      if (mismatches.length) console.table(mismatches.map(m => ({ id: m.id, match: m.match, db: m.db, should: m.should })));

      console.log(`→ Unmatched: ${unmatched.length}`);
      if (unmatched.length) console.table(unmatched);

      totalMismatch += mismatches.length;
      totalUnmatched += unmatched.length;

      if (DO_FIX && mismatches.length) {
        await client.query("BEGIN");
        try {
          for (const m of mismatches) {
            await updateGameScores(client, m.id, m.shouldHome, m.shouldAway, week);
          }
          await client.query("COMMIT");
          totalFixed += mismatches.length;
          console.log(`✔ Updated ${mismatches.length} game(s) for week ${week}`);
        } catch (e) {
          await client.query("ROLLBACK");
          console.error(`  ✖ Failed to update week ${week}:`, e.message);
        }
      }
    });
  }

  console.log("\n=== Summary ===");
  console.log(`Weeks processed: ${weeks.join(", ")}`);
  console.log(`Total mismatches: ${totalMismatch}`);
  console.log(`Total unmatched:  ${totalUnmatched}`);
  if (DO_FIX) console.log(`Total fixed:     ${totalFixed}`);

  // If auditing only and we found issues, exit non-zero (useful for CI/alerts)
  if (!DO_FIX && (totalMismatch > 0 || totalUnmatched > 0)) process.exit(1);
})().catch(err => {
  console.error("Fatal:", err?.message || err);
  process.exit(2);
});
