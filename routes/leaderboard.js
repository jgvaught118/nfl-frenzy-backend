// backend/routes/leaderboard.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

/* -----------------------------------------------------------------------------
 * Config: double-points weeks (applies to base AND GOTW/POTW bonuses)
 * --------------------------------------------------------------------------- */
const DOUBLE_WEEKS = String(process.env.DOUBLE_WEEKS || "13,17")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

const isDoubleWeek = (w) => DOUBLE_WEEKS.includes(Number(w));

/* -----------------------------------------------------------------------------
 * Helpers: games, GOTW totals, POTW yards, etc.
 * --------------------------------------------------------------------------- */
async function getGamesIndex() {
  const { rows } = await pool.query(
    `SELECT week, home_team, away_team, home_score, away_score, favorite
       FROM games`
  );
  const byWeek = new Map();
  for (const g of rows) {
    if (!byWeek.has(g.week)) byWeek.set(g.week, []);
    byWeek.get(g.week).push(g);
  }
  return byWeek;
}

/** Prefer explicit answer in game_of_the_week.game_total_points; else sum final scores */
async function getGotwActualTotals(gamesByWeek) {
  const gotwMap = new Map(); // week -> { home_team, away_team, actual_total|null }
  const { rows } = await pool.query(
    `SELECT week, home_team, away_team, game_total_points
       FROM game_of_the_week`
  );

  for (const r of rows) {
    let actual = null;
    if (r.game_total_points !== null && typeof r.game_total_points !== "undefined") {
      actual = Number(r.game_total_points);
    } else {
      const games = gamesByWeek.get(r.week) || [];
      const match = games.find(
        (g) => g.home_team === r.home_team && g.away_team === r.away_team
      );
      if (
        match &&
        match.home_score !== null &&
        typeof match.home_score !== "undefined" &&
        match.away_score !== null &&
        typeof match.away_score !== "undefined"
      ) {
        actual = Number(match.home_score) + Number(match.away_score);
      }
    }
    gotwMap.set(r.week, {
      home_team: r.home_team,
      away_team: r.away_team,
      actual_total: Number.isFinite(actual) ? actual : null,
    });
  }
  return gotwMap;
}

/** POTW official yards per week (nullable until you enter it) */
async function getPotwYards() {
  const map = new Map(); // week -> yards|null
  const { rows } = await pool.query(
    `SELECT week, player_total_yards FROM player_of_the_week`
  );
  for (const r of rows) {
    const val =
      r.player_total_yards === null || typeof r.player_total_yards === "undefined"
        ? null
        : Number(r.player_total_yards);
    map.set(r.week, Number.isFinite(val) ? val : null);
  }
  return map;
}

function winnerAndFavorite(g, team) {
  if (!g) return { winner: null, favorite: null };
  const scoresKnown =
    g.home_score !== null &&
    typeof g.home_score !== "undefined" &&
    g.away_score !== null &&
    typeof g.away_score !== "undefined";

  let winner = null;
  if (scoresKnown) {
    if (Number(g.home_score) > Number(g.away_score)) winner = g.home_team;
    else if (Number(g.away_score) > Number(g.home_score)) winner = g.away_team;
    else winner = null; // tie (rare)
  }
  return { winner, favorite: g.favorite || null };
}

/* -----------------------------------------------------------------------------
 * Core computation: one week’s scoring with doubles + GOTW podium + POTW exact
 * --------------------------------------------------------------------------- */
async function computeWeekTable(week) {
  const w = Number(week);

  // data
  const gamesByWeek = await getGamesIndex();
  const gotwMap = await getGotwActualTotals(gamesByWeek);
  const potwMap = await getPotwYards();

  // picks joined to users for names + submission timestamps for tiebreaker
  const { rows: picks } = await pool.query(
    `SELECT
        p.user_id, p.week, p.team, p.gotw_prediction, p.potw_prediction, p.created_at,
        u.first_name, u.last_name, u.name, u.email
       FROM picks p
       JOIN users u ON u.id = p.user_id
      WHERE p.week = $1`,
    [w]
  );

  const weekGames = gamesByWeek.get(w) || [];
  const gameForTeam = (team) => weekGames.find((gm) => gm.home_team === team || gm.away_team === team);

  // Prepare GOTW podium
  const gotw = gotwMap.get(w);
  const gotwActual = gotw?.actual_total ?? null;
  const potwOfficial = potwMap.get(w);

  const contenders = [];
  if (gotwActual !== null) {
    for (const p of picks) {
      const gPred =
        p.gotw_prediction === null || typeof p.gotw_prediction === "undefined"
          ? null
          : Number(p.gotw_prediction);
      if (gPred === null) continue;

      const diff = Math.abs(gPred - Number(gotwActual));
      // tie-breaker 1: smaller POTW diff (if official available); missing => Infinity
      let potwDiff = Number.POSITIVE_INFINITY;
      if (potwOfficial !== null && typeof potwOfficial !== "undefined") {
        const pp =
          p.potw_prediction === null || typeof p.potw_prediction === "undefined"
            ? null
            : Number(p.potw_prediction);
        if (pp !== null) potwDiff = Math.abs(pp - Number(potwOfficial));
      }

      contenders.push({
        user_id: p.user_id,
        diff,
        potwDiff,
        created_at: p.created_at, // tie-breaker 2: earlier submission wins
      });
    }

    contenders.sort((a, b) => {
      if (a.diff !== b.diff) return a.diff - b.diff;
      if (a.potwDiff !== b.potwDiff) return a.potwDiff - b.potwDiff;
      // earlier submission (lower timestamp) wins
      const at = a.created_at ? new Date(a.created_at).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.created_at ? new Date(b.created_at).getTime() : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.user_id - b.user_id; // stable final tie-breaker
    });
  }

  const podium = contenders.slice(0, 3).map((c, i) => ({
    user_id: c.user_id,
    award: [3, 2, 1][i],
  }));

  // POTW exact
  const potwExact = [];
  if (potwOfficial !== null && typeof potwOfficial !== "undefined") {
    for (const p of picks) {
      const pp =
        p.potw_prediction === null || typeof p.potw_prediction === "undefined"
          ? null
          : Number(p.potw_prediction);
      if (pp !== null && Number(pp) === Number(potwOfficial)) {
        potwExact.push({ user_id: p.user_id, award: 3 });
      }
    }
  }

  // Scoring factor
  const factor = isDoubleWeek(w) ? 2 : 1;

  // Aggregate per user
  const byUser = new Map();
  function ensure(u, proto) {
    if (!byUser.has(u)) {
      byUser.set(u, {
        user_id: u,
        name:
          proto.first_name ||
          proto.name ||
          `User ${u}`,
        email: proto.email || null,
        base_points: 0,
        gotw_points: 0,
        potw_points: 0,
        total_points: 0,
        correct_favorites: 0,
        correct_underdogs: 0,
        factor,
      });
    }
    return byUser.get(u);
  }

  // base pick points (+1 fav, +2 dog) with factor
  for (const p of picks) {
    const g = gameForTeam(p.team);
    const { winner, favorite } = winnerAndFavorite(g, p.team);
    const row = ensure(p.user_id, p);

    if (winner && p.team === winner) {
      if (favorite && favorite === p.team) {
        row.base_points += 1 * factor;
        row.correct_favorites += 1;
      } else {
        row.base_points += 2 * factor;
        row.correct_underdogs += 1;
      }
    }
  }

  // GOTW podium with factor (3/2/1)
  for (const a of podium) {
    const r = byUser.get(a.user_id);
    if (r) r.gotw_points += a.award * factor;
  }

  // POTW exact +3 with factor
  for (const a of potwExact) {
    const r = byUser.get(a.user_id);
    if (r) r.potw_points += a.award * factor;
  }

  // finalize totals
  const rows = Array.from(byUser.values()).map((r) => ({
    ...r,
    total_points: r.base_points + r.gotw_points + r.potw_points,
  }));

  rows.sort((a, b) => b.total_points - a.total_points || a.name.localeCompare(b.name));

  return {
    week: w,
    factor,
    gotw_actual: gotwActual,
    potw_actual: potwOfficial,
    podium,      // [{user_id, award}]
    potw_exact: potwExact, // [{user_id, award:3}]
    rows,        // per-user breakdown
  };
}

/* -----------------------------------------------------------------------------
 * Weekly endpoint (new): GET /leaderboard/week/:week
 * Returns breakdown including base/gotw/potw/factor and totals.
 * Also includes a "rows" key for compatibility with prior UIs.
 * --------------------------------------------------------------------------- */
router.get("/week/:week", async (req, res) => {
  try {
    const w = Number(req.params.week || req.query.week || 1);
    const table = await computeWeekTable(w);
    // Return both raw array and wrapper to be resilient to existing frontends
    res.json({ week: table.week, factor: table.factor, gotw_actual: table.gotw_actual, potw_actual: table.potw_actual, podium: table.podium, potw_exact: table.potw_exact, rows: table.rows, data: table.rows });
  } catch (err) {
    console.error("GET /leaderboard/week/:week error:", err);
    res.status(500).json({ error: "Failed to compute weekly leaderboard" });
  }
});

/* -----------------------------------------------------------------------------
 * Overall endpoint (kept): GET /leaderboard/overall
 * Sums week tables across all weeks found in picks.
 * Returns { standings: [...] } for backward compatibility.
 * --------------------------------------------------------------------------- */
router.get("/overall", async (req, res) => {
  try {
    const { rows: weekListRows } = await pool.query(
      `SELECT DISTINCT week FROM picks ORDER BY week ASC`
    );
    const weeks = weekListRows.map((r) => Number(r.week));

    // accumulate across weeks
    const byUser = new Map();
    for (const w of weeks) {
      const table = await computeWeekTable(w);
      for (const row of table.rows) {
        if (!byUser.has(row.user_id)) {
          byUser.set(row.user_id, {
            user_id: row.user_id,
            display_name: row.name || `User ${row.user_id}`,
            total_points: 0,
            correct_favorites: 0,
            correct_underdogs: 0,
            weeks_scored: 0,
            gotw_firsts: 0, // we can approximate as podium gold counts
            potw_exact: 0,
          });
        }
        const agg = byUser.get(row.user_id);
        agg.total_points += row.total_points;
        agg.correct_favorites += row.correct_favorites;
        agg.correct_underdogs += row.correct_underdogs;
        if (row.total_points > 0) agg.weeks_scored += 1;
      }

      // count GOTW golds for tie-break info (not used in scoring here)
      for (const podium of table.podium) {
        if (podium.award === 3) {
          const agg = byUser.get(podium.user_id);
          if (agg) agg.gotw_firsts += 1;
        }
      }
      for (const ex of table.potw_exact) {
        const agg = byUser.get(ex.user_id);
        if (agg) agg.potw_exact += 1;
      }
    }

    const standings = Array.from(byUser.values()).sort((a, b) => {
      if (b.total_points !== a.total_points) return b.total_points - a.total_points;
      if (b.gotw_firsts !== a.gotw_firsts) return b.gotw_firsts - a.gotw_firsts;
      if (b.potw_exact !== a.potw_exact) return b.potw_exact - a.potw_exact;
      return (a.display_name || "").localeCompare(b.display_name || "");
    });

    res.json({ standings });
  } catch (err) {
    console.error("GET /leaderboard/overall error:", err);
    res.status(500).json({ error: "Failed to compute overall leaderboard" });
  }
});

module.exports = router;
