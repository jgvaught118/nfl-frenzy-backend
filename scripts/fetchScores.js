#!/usr/bin/env node
/**
 * fetchScores.js
 * - Calls your backend ingest endpoint /admin/scores/fetch-now for one or more weeks
 * - Cross-checks DB scores vs ESPN (by week/year) and reports mismatches
 * - With --fix, updates DB scores to match ESPN for finals (handles swapped home/away)
 *
 * Usage:
 *   node scripts/fetchScores.js --week 3           # audit only (no DB writes)
 *   node scripts/fetchScores.js --week 3 --fix     # ingest + audit + fix DB
 *   node scripts/fetchScores.js --all              # audit likely-active weeks
 *   node scripts/fetchScores.js --all --fix        # ingest + audit + fix
 *
 * Env:
 *   RW_DB        = postgres connection string
 *   RAILWAY_URL  = https://<your-backend>.up.railway.app
 *   ADMIN_KEY    = <admin bearer token>
 */

const { Pool } = require('pg');
const { URL } = require('url');

let fetchFn = global.fetch;
if (!fetchFn) {
  try { fetchFn = require('node-fetch'); } catch { /* Node >=18 has fetch */ }
}
if (!fetchFn) {
  console.error('❌ No fetch available. Install node-fetch: npm i node-fetch');
  process.exit(1);
}

const RW_DB = process.env.RW_DB;
const RAILWAY_URL = process.env.RAILWAY_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!RW_DB) {
  console.error('❌ RW_DB env var is required (postgres connection string).');
  process.exit(1);
}

const pool = new Pool({ connectionString: RW_DB });

function parseArgs(argv) {
  const args = { all: false, fix: false, week: null, year: null, seasontype: 2 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--fix') args.fix = true;
    else if (a === '--week') { args.week = parseInt(argv[++i], 10); }
    else if (a === '--year') { args.year = parseInt(argv[++i], 10); }
    else if (a === '--seasontype') { args.seasontype = parseInt(argv[++i], 10); }
  }
  return args;
}

async function withClient(fn) {
  const client = await pool.connect();
  try { return await fn(client); }
  finally { client.release(); }
}

async function ingestWeek(week) {
  if (!RAILWAY_URL || !ADMIN_KEY) {
    console.warn('⚠️ Skipping ingest: RAILWAY_URL or ADMIN_KEY not set.');
    return null;
  }
  const url = new URL('/admin/scores/fetch-now', RAILWAY_URL).toString();
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ week }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(`⚠️ Ingest week ${week} non-200: ${res.status} ${res.statusText} ${txt}`);
    return null;
  }
  const json = await res.json().catch(() => ({}));
  console.log('✔ ingest ok', json);
  return json;
}

function normalizeTeam(s) {
  return String(s || '').trim().toUpperCase();
}

async function espnWeekScores(year, week, seasontype = 2) {
  // ESPN scoreboard (regular season = seasontype:2)
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${year}&week=${week}&seasontype=${seasontype}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`ESPN fetch failed ${res.status} ${res.statusText}`);
  const data = await res.json();

  const finals = [];
  for (const ev of data.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;

    const status = comp.status || ev.status || {};
    const st = (status.type || {}).state || (status.type || {}).name || '';
    const completed = (status.type && status.type.completed) || /post/i.test(st);

    // We only trust finals
    if (!completed) continue;

    const [c1, c2] = comp.competitors || [];
    if (!c1 || !c2) continue;
    const home = c1.homeAway === 'home' ? c1 : c2;
    const away = c1.homeAway === 'home' ? c2 : c1;

    const homeName = home.team && (home.team.displayName || home.team.name);
    const awayName = away.team && (away.team.displayName || away.team.name);
    const homeScore = Number(home.score);
    const awayScore = Number(away.score);

    if (!homeName || !awayName) continue;

    finals.push({
      home_team: homeName,
      away_team: awayName,
      home_score: isFinite(homeScore) ? homeScore : null,
      away_score: isFinite(awayScore) ? awayScore : null,
    });
  }

  return finals;
}

async function dbWeekGames(client, week) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, home_score, away_score
     FROM games WHERE week = $1`, [week]
  );
  return rows;
}

function compareDbVsEspn(dbGames, espnFinals) {
  // index ESPN by unordered matchup key A|B for quick lookup
  const idx = new Map();
  for (const e of espnFinals) {
    const k1 = `${normalizeTeam(e.home_team)}|${normalizeTeam(e.away_team)}`;
    const k2 = `${normalizeTeam(e.away_team)}|${normalizeTeam(e.home_team)}`;
    idx.set(k1, e);
    idx.set(k2, e); // allow reverse lookup
  }

  const mismatches = [];
  const unmatched = [];

  for (const g of dbGames) {
    const key = `${normalizeTeam(g.home_team)}|${normalizeTeam(g.away_team)}`;
    const e = idx.get(key);
    if (!e) {
      unmatched.push(g);
      continue;
    }
    // Map ESPN scores into DB's orientation
    let shouldHome, shouldAway;
    if (normalizeTeam(e.home_team) === normalizeTeam(g.home_team)) {
      shouldHome = e.home_score; shouldAway = e.away_score;
    } else {
      // swapped
      shouldHome = e.away_score; shouldAway = e.home_score;
    }

    const homeDiff = g.home_score !== shouldHome;
    const awayDiff = g.away_score !== shouldAway;
    if (homeDiff || awayDiff) {
      mismatches.push({
        id: g.id,
        home_team: g.home_team, away_team: g.away_team,
        db_home: g.home_score, db_away: g.away_score,
        shouldHome, shouldAway
      });
    }
  }

  return { mismatches, unmatched };
}

async function applyFixes(client, week, fixes) {
  if (fixes.length === 0) return 0;
  const q = `
    UPDATE games SET home_score = $1, away_score = $2
    WHERE id = $3 AND week = $4
  `;
  let n = 0;
  await client.query('BEGIN');
  try {
    for (const f of fixes) {
      await client.query(q, [f.shouldHome, f.shouldAway, f.id, week]);
      n++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return n;
}

async function weeksToProcess(args) {
  if (args.week) return [args.week];

  if (args.all) {
    // Heuristic: any weeks with recent games or missing scores
    return await withClient(async (client) => {
      const { rows } = await client.query(`
        SELECT DISTINCT week
        FROM games
        WHERE (home_score IS NULL OR away_score IS NULL)
           OR kickoff >= NOW() - INTERVAL '4 days'
        ORDER BY week
      `);
      if (rows.length) return rows.map(r => Number(r.week));
      // Fallback: current regular season range
      return Array.from({ length: 18 }, (_, i) => i + 1);
    });
  }

  // Default to current or recent week based on DB content
  return await withClient(async (client) => {
    const { rows } = await client.query(`
      SELECT week
      FROM games
      WHERE kickoff >= NOW() - INTERVAL '8 days'
      ORDER BY week DESC
      LIMIT 1
    `);
    if (rows.length) return [Number(rows[0].week)];
    return [1]; // fallback
  });
}

async function dbSeasonYearFallback() {
  // Try to read a year from most recent game
  try {
    const { rows } = await withClient(c => c.query(`SELECT EXTRACT(YEAR FROM NOW())::int AS y`));
    return rows[0].y;
  } catch {
    return new Date().getFullYear();
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const year = args.year || await dbSeasonYearFallback();

  const weeks = await weeksToProcess(args);
  if (!weeks.length) {
    console.log('No weeks to process.');
    process.exit(0);
  }

  let totalMismatches = 0;
  let totalUnmatched = 0;
  let totalFixed = 0;

  for (const week of weeks) {
    console.log(`\n===== WEEK ${week} (year ${year}) =====`);

    if (args.fix) {
      await ingestWeek(week); // harmless if ADMIN envs are missing
    }

    const espn = await espnWeekScores(year, week, args.seasontype);
    const dbGames = await withClient(c => dbWeekGames(c, week));
    const { mismatches, unmatched } = compareDbVsEspn(dbGames, espn);

    console.log(`→ Finals from ESPN: ${espn.length}`);
    console.log(`→ DB games: ${dbGames.length}`);
    console.log(`→ Mismatches: ${mismatches.length}`);
    if (mismatches.length) {
      console.table(mismatches.map(m => ({
        id: m.id,
        match: `${m.home_team} vs ${m.away_team}`,
        db: `${m.db_home}-${m.db_away}`,
        should: `${m.shouldHome}-${m.shouldAway}`
      })));
    }
    if (unmatched.length) {
      console.log(`→ Unmatched (team-name mismatch): ${unmatched.length}`);
      console.table(unmatched.map(u => ({
        id: u.id,
        home_team: u.home_team,
        away_team: u.away_team
      })));
    }

    if (args.fix && mismatches.length) {
      const fixed = await withClient(c => applyFixes(c, week, mismatches));
      console.log(`✔ Updated ${fixed} game row(s) in DB for week ${week}`);
      totalFixed += fixed;
    }

    totalMismatches += mismatches.length;
    totalUnmatched += unmatched.length;
  }

  console.log('\n=== Summary ===');
  console.log(`Weeks processed: ${weeks.join(', ')}`);
  console.log(`Total mismatches: ${totalMismatches}`);
  console.log(`Total unmatched:  ${totalUnmatched}`);
  if (args.fix) console.log(`Total rows fixed: ${totalFixed}`);

  // Exit non-zero for CI if audit found issues and not fixing
  if (!args.fix && (totalMismatches > 0 || totalUnmatched > 0)) {
    process.exit(2);
  }
})().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
