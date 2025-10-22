// scripts/fetchOdds.js
// Node 18+ (uses global fetch)
// npm i pg
/* eslint-disable no-console */

const { Client } = require("pg");

/** ---------- Config & CLI ---------- **/

const { RW_DB, ODDS_API_KEY } = process.env;
if (!RW_DB) {
  console.error("Missing env: RW_DB");
  process.exit(2);
}
if (!ODDS_API_KEY) {
  console.error("Missing env: ODDS_API_KEY (The Odds API key)");
  process.exit(2);
}

const args = process.argv.slice(2);
const ARG = (flag) => args.includes(flag);
const getVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// Flags:
//   --week 3            -> process week 3 only
//   --all               -> process current week + future weeks
//   --maxWeeks 2        -> limit number of future weeks (default 3 when --all)
//   --allow-past        -> (testing only) allow writes to past weeks (normally blocked)
//   --minWeek 8         -> clamp processing to this week or later (also respected via env MIN_WEEK)
const ONLY_WEEK  = getVal("--week") ? Number(getVal("--week")) : undefined;
const DO_ALL     = ARG("--all");
const MAX_WEEKS  = Number(getVal("--maxWeeks") || 3);
const ALLOW_PAST = ARG("--allow-past");
const MIN_WEEK   = Number(getVal("--minWeek") || process.env.MIN_WEEK || 0);

/** ---------- Helpers ---------- **/

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Odds API (Caesars) docs: v4 odds endpoint
 * sports=americanfootball_nfl, regions=us, markets=spreads,totals, bookmakers=caesars
 */
async function fetchCaesarsWeekOddsUsingOddsAPI() {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url =
    `${base}?regions=us&markets=spreads,totals&oddsFormat=american&bookmakers=caesars&dateFormat=iso&apiKey=${encodeURIComponent(
      ODDS_API_KEY
    )}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`The Odds API failed ${res.status} ${txt}`.trim());
  }

  const events = await res.json();
  const out = new Map();

  for (const ev of events || []) {
    const homeName = ev.home_team;
    const awayName = ev.away_team;
    if (!homeName || !awayName) continue;

    const caesars =
      (ev.bookmakers || []).find(
        (b) => b.key?.toLowerCase() === "caesars" || /caesars/i.test(b.name || "")
      ) || null;
    if (!caesars) continue;

    const spreads = (caesars.markets || []).find((m) => m.key === "spreads");
    const totals  = (caesars.markets || []).find((m) => m.key === "totals");

    let favoriteSide = null;
    let favoriteName = null;
    let spread = null;
    let overUnder = null;
    const provider = "Caesars";

    // Parse spreads
    if (spreads?.outcomes?.length >= 2) {
      const o1 = spreads.outcomes[0];
      const o2 = spreads.outcomes[1];
      // favorite typically has negative handicap (point)
      const fav = [o1, o2].find((o) => typeof o.point === "number" && o.point < 0) || null;
      if (fav) {
        favoriteName = fav.name || null;
        spread = Math.abs(Number(fav.point));
      } else {
        const zero = [o1, o2].every((o) => typeof o.point === "number" && Number(o.point) === 0);
        if (zero) {
          favoriteName = null;
          spread = 0;
        }
      }
    }

    // Parse totals
    if (totals?.outcomes?.length >= 1) {
      const over  = totals.outcomes.find((o) => /^over$/i.test(o.name || ""));
      const under = totals.outcomes.find((o) => /^under$/i.test(o.name || ""));
      const pick  = over || under || totals.outcomes[0];
      if (pick && typeof pick.point === "number") overUnder = Number(pick.point);
    }

    // Map favorite to home/away (optional but nice to have)
    if (favoriteName) {
      const favN = norm(favoriteName);
      const hN = norm(homeName);
      const aN = norm(awayName);
      if (favN === hN) favoriteSide = "home";
      else if (favN === aN) favoriteSide = "away";
    }

    const payload = {
      espnHome: { name: homeName, abbr: null }, // keep shape consistent with scores script
      espnAway: { name: awayName, abbr: null },
      provider,
      overUnder,
      favoriteSide: favoriteSide || null,
      favoriteName: favoriteName || null,
      spread: typeof spread === "number" ? spread : null,
    };

    const k1 = `${norm(homeName)}__${norm(awayName)}`;
    const k2 = `${norm(awayName)}__${norm(homeName)}`;
    out.set(k1, payload);
    out.set(k2, payload);
  }

  return out;
}

/** ---------- DB helpers ---------- **/

async function ensureOddsColumns(client) {
  await client.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS line_favorite    text,
      ADD COLUMN IF NOT EXISTS line_spread      numeric,
      ADD COLUMN IF NOT EXISTS line_over_under  numeric,
      ADD COLUMN IF NOT EXISTS line_source      text,
      ADD COLUMN IF NOT EXISTS line_updated_at  timestamptz;
  `);
}

async function getCurrentWeek(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS current_week
    FROM games;
  `);
  return Number(rows[0].current_week);
}

async function weeksCurrentAndFuture(client, currentWeek) {
  const { rows } = await client.query(
    `SELECT DISTINCT week FROM games WHERE week >= $1 ORDER BY week`,
    [currentWeek]
  );
  return rows.map((r) => Number(r.week));
}

async function dbGamesForWeek(client, week) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
       FROM games
      WHERE week = $1
      ORDER BY kickoff, id`,
    [week]
  );
  return rows;
}

async function updateOdds(client, gameId, odds, currentWeek) {
  // Protect past weeks + games already started (unless --allow-past)
  const guardWeek = ALLOW_PAST ? "" : "AND week >= $6";
  const guardKick = ALLOW_PAST ? "" : "AND kickoff > now()";

  const favorite = odds.favoriteName || null;
  const spread   = odds.spread != null ? Number(odds.spread) : null;
  const ou       = odds.overUnder != null ? Number(odds.overUnder) : null;
  const src      = odds.provider || "Caesars";

  const sql = `
    UPDATE games
       SET line_favorite   = $1,
           line_spread     = $2,
           line_over_under = $3,
           line_source     = $4,
           line_updated_at = now()
     WHERE id = $5
       ${guardWeek}
       ${guardKick}
  `;

  const params = ALLOW_PAST
    ? [favorite, spread, ou, src, gameId]
    : [favorite, spread, ou, src, gameId, currentWeek];

  const res = await client.query(sql, params);
  return res.rowCount;
}

/** ---------- Runner ---------- **/

async function main() {
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await ensureOddsColumns(client);

  const currentWeek = await getCurrentWeek(client);

  // If a specific week is requested but it's below MIN_WEEK, skip safely (unless allow-past)
  if (ONLY_WEEK && ONLY_WEEK < (MIN_WEEK || 0) && !ALLOW_PAST) {
    console.log(`Skipping week ${ONLY_WEEK}: below MIN_WEEK=${MIN_WEEK}`);
    await client.end();
    return;
  }

  let targetWeeks = [];
  if (ONLY_WEEK) {
    targetWeeks = [ONLY_WEEK];
  } else if (DO_ALL) {
    const allW = await weeksCurrentAndFuture(client, currentWeek);
    const start = Math.max(currentWeek, MIN_WEEK || 0);
    const filtered = allW.filter((w) => w >= start);
    targetWeeks = filtered.slice(0, Math.max(1, MAX_WEEKS));
  } else {
    // Default: just the current week, but respect MIN_WEEK (never go below it)
    const start = Math.max(currentWeek, MIN_WEEK || 0);
    targetWeeks = [start];
  }

  console.log(
    `\nTarget weeks: ${targetWeeks.join(", ")} ${ALLOW_PAST ? "(allow-past ON)" : ""} ` +
    `(current=${currentWeek}, minWeek=${MIN_WEEK || 0})`
  );

  let totalUpdated = 0;
  let totalMissing = 0;
  let totalUnmatched = 0;

  // Get a full Caesars snapshot once; we'll match per week locally
  let caesars;
  try {
    caesars = await fetchCaesarsWeekOddsUsingOddsAPI();
  } catch (e) {
    console.error(`✖ Caesars fetch failed: ${e.message}`);
    throw e;
  }

  for (const w of targetWeeks) {
    console.log(`\n===== ODDS: Week ${w} =====`);
    const games = await dbGamesForWeek(client, w);
    console.log(`→ DB games: ${games.length}`);

    const rowChanges = [];

    for (const g of games) {
      const key = `${norm(g.home_team)}__${norm(g.away_team)}`;
      const hit = caesars.get(key);

      if (!hit) {
        totalUnmatched++;
        rowChanges.push([g.id, `${g.home_team} vs ${g.away_team}`, "UNMATCHED"]);
        continue;
      }

      if (hit.spread == null && hit.overUnder == null) {
        totalMissing++;
        rowChanges.push([g.id, `${g.home_team} vs ${g.away_team}`, "MISSING"]);
        continue;
      }

      const changed = await updateOdds(client, g.id, hit, currentWeek);
      if (changed) {
        totalUpdated += changed;
        const should =
          (hit.favoriteName ? `${hit.favoriteName} -${hit.spread ?? 0}` : "Pick/Even") +
          (hit.overUnder != null ? ` (O/U ${hit.overUnder})` : "");
        rowChanges.push([g.id, `${g.home_team} vs ${g.away_team}`, should, hit.provider || ""]);
      } else {
        rowChanges.push([g.id, `${g.home_team} vs ${g.away_team}`, "SKIPPED (guard)"]);
      }
      await sleep(20);
    }

    if (rowChanges.length) {
      const toTable = rowChanges.map(([id, match, line, src]) => ({
        id,
        match,
        line,
        source: src || "",
      }));
      console.table(toTable);
    }
  }

  console.log("\n=== Odds Summary ===");
  console.log(`Updated rows:   ${totalUpdated}`);
  console.log(`Missing odds:   ${totalMissing}`);
  console.log(`Unmatched teams:${totalUnmatched}`);

  await client.end();

  // Exit non-zero if we had unmatched (useful for CI alerting)
  if (totalUnmatched > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
