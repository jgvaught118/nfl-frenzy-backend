// backend/routes/leaderboard.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

/**
 * Helper: build a quick lookup for games by (week, home_team, away_team)
 */
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

/**
 * Helper: compute GOTW actual total for each week
 * Priority: explicit override (game_of_the_week.game_total_points) if not null,
 * otherwise from final box score (home_score + away_score) of the GOTW matchup.
 */
async function getGotwActualTotals(gamesByWeek) {
  const gotwMap = new Map(); // week -> { home_team, away_team, actual_total|null }
  const { rows } = await pool.query(
    `SELECT week, home_team, away_team, game_total_points
       FROM game_of_the_week`
  );

  for (const r of rows) {
    let actual = null;
    if (r.game_total_points !== null && typeof r.game_total_points !== "undefined") {
      // Admin override / explicit answer
      actual = Number(r.game_total_points);
    } else {
      // Try to compute from final scores
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

/**
 * Helper: POTW official yards per week (nullable until you enter it)
 */
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

/**
 * GET /leaderboard/overall
 * Returns season standings with total points per user.
 *
 * Scoring rules implemented here:
 *  - Team pick correct as FAVORITE = +1
 *  - Team pick correct as UNDERDOG = +2
 *  - GOTW: only rank 1 (closest to actual total, tie-broken by smaller POTW diff) = +3
 *  - POTW: exact match yards = +3
 *
 * Notes:
 *  - Weeks with missing scores/answers simply don't award those points yet.
 *  - This endpoint is public (no auth) so you can show it on the site.
 */
router.get("/overall", async (req, res) => {
  try {
    // Load data
    const gamesByWeek = await getGamesIndex();
    const gotwMap = await getGotwActualTotals(gamesByWeek);
    const potwMap = await getPotwYards();

    // Picks + users (we compute in JS for clarity)
    const { rows: picks } = await pool.query(
      `SELECT
          p.user_id, p.week, p.team, p.gotw_prediction, p.potw_prediction,
          u.first_name, u.last_name, u.name
         FROM picks p
         JOIN users u ON u.id = p.user_id
         ORDER BY p.week ASC`
    );

    // Pre-compute winners and favorite/underdog for each pick
    function winnerForWeekTeam(week, team) {
      const games = gamesByWeek.get(week) || [];
      const g = games.find(
        (gm) => gm.home_team === team || gm.away_team === team
      );
      if (!g) return { winner: null, favorite: null };
      if (
        g.home_score === null || typeof g.home_score === "undefined" ||
        g.away_score === null || typeof g.away_score === "undefined"
      ) {
        return { winner: null, favorite: g.favorite || null };
      }
      const winner =
        Number(g.home_score) > Number(g.away_score)
          ? g.home_team
          : Number(g.away_score) > Number(g.home_score)
          ? g.away_team
          : null; // tie (unlikely)
      return { winner, favorite: g.favorite || null };
    }

    // Build GOTW ranks per week when actual is available
    const gotwRanksByWeek = new Map(); // week -> Map(user_id -> rank)
    for (const [week, gotw] of gotwMap.entries()) {
      if (gotw.actual_total === null) continue;
      const weekPicks = picks.filter((p) => p.week === week);
      // Only consider those who made a GOTW prediction
      const contending = weekPicks
        .filter((p) => p.gotw_prediction !== null && typeof p.gotw_prediction !== "undefined")
        .map((p) => {
          const diff = Math.abs(Number(p.gotw_prediction) - Number(gotw.actual_total));
          // POTW tiebreaker uses closeness to POTW yards (smaller diff is better)
          const potwOfficial = potwMap.get(week);
          const potwDiff =
            potwOfficial === null || typeof potwOfficial === "undefined"
              ? Number.POSITIVE_INFINITY
              : Math.abs(Number(p.potw_prediction ?? Number.POSITIVE_INFINITY) - Number(potwOfficial));
          return { user_id: p.user_id, diff, potwDiff };
        });

      contending.sort((a, b) => {
        if (a.diff !== b.diff) return a.diff - b.diff;
        return a.potwDiff - b.potwDiff;
      });

      const rankMap = new Map();
      let rank = 1;
      contending.forEach((entry, i) => {
        if (i > 0) {
          const prev = contending[i - 1];
          if (!(entry.diff === prev.diff && entry.potwDiff === prev.potwDiff)) {
            rank = i + 1;
          }
        }
        rankMap.set(entry.user_id, rank);
      });
      gotwRanksByWeek.set(week, rankMap);
    }

    // Tally points per user
    const byUser = new Map(); // user_id -> aggregate
    function ensureUser(u) {
      if (!byUser.has(u)) {
        byUser.set(u, {
          user_id: u,
          first_name: null,
          last_name: null,
          name: null,
          total_points: 0,
          weeks_scored: new Set(),
          correct_favorites: 0,
          correct_underdogs: 0,
          gotw_firsts: 0,
          potw_exact: 0,
        });
      }
      return byUser.get(u);
    }

    for (const p of picks) {
      const agg = ensureUser(p.user_id);
      agg.first_name = p.first_name;
      agg.last_name = p.last_name;
      agg.name = p.name;

      let points = 0;

      // Team pick points
      const { winner, favorite } = winnerForWeekTeam(p.week, p.team);
      if (winner && p.team === winner) {
        if (favorite && favorite === p.team) {
          points += 1; // correct favorite
          agg.correct_favorites += 1;
        } else {
          points += 2; // correct underdog
          agg.correct_underdogs += 1;
        }
      }

      // GOTW rank = 1 → +3
      const ranks = gotwRanksByWeek.get(p.week);
      if (ranks && ranks.get(p.user_id) === 1) {
        points += 3;
        agg.gotw_firsts += 1;
      }

      // POTW exact yards → +3
      const potwOfficial = potwMap.get(p.week);
      if (
        potwOfficial !== null &&
        typeof potwOfficial !== "undefined" &&
        p.potw_prediction !== null &&
        typeof p.potw_prediction !== "undefined" &&
        Number(p.potw_prediction) === Number(potwOfficial)
      ) {
        points += 3;
        agg.potw_exact += 1;
      }

      if (points > 0) agg.weeks_scored.add(p.week);
      agg.total_points += points;
    }

    // Build final array, sort by total_points desc, then by gotw_firsts, then potw_exact
    const result = Array.from(byUser.values())
      .map((u) => ({
        user_id: u.user_id,
        display_name: u.first_name || u.name || `User ${u.user_id}`,
        total_points: u.total_points,
        weeks_scored: u.weeks_scored.size,
        correct_favorites: u.correct_favorites,
        correct_underdogs: u.correct_underdogs,
        gotw_firsts: u.gotw_firsts,
        potw_exact: u.potw_exact,
      }))
      .sort((a, b) => {
        if (b.total_points !== a.total_points) return b.total_points - a.total_points;
        if (b.gotw_firsts !== a.gotw_firsts) return b.gotw_firsts - a.gotw_firsts;
        if (b.potw_exact !== a.potw_exact) return b.potw_exact - a.potw_exact;
        return (a.display_name || "").localeCompare(b.display_name || "");
      });

    res.json({ standings: result });
  } catch (err) {
    console.error("GET /leaderboard/overall error:", err);
    res.status(500).json({ error: "Failed to compute overall leaderboard" });
  }
});

module.exports = router;
