// routes/picks.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateToken = require("../middleware/authMiddleware"); // attaches req.user = { user_id, ... }

/* ============================
   Helpers
============================ */
function getRequestedUserId(req) {
  const raw = req.query.user_id ?? req.body.user_id;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function ensureSelf(req, res, next) {
  const requested = getRequestedUserId(req);
  const tokenUserId = req.user?.user_id;

  if (!requested) return res.status(400).json({ error: "user_id is required" });
  if (!tokenUserId) return res.status(401).json({ error: "Unauthorized" });
  if (requested !== tokenUserId) {
    return res.status(403).json({ error: "Forbidden: cannot access another user’s data" });
  }
  req.requested_user_id = requested;
  next();
}

// Optional: double points toggle for certain weeks
function weekMultiplier(week) {
  return (week === 13 || week === 17) ? 2 : 1;
}

/**
 * Compute the Sunday 11:00 AM America/Phoenix unlock moment for a given week.
 * Approach:
 * - Find the earliest SUNDAY game for that week using games.start_time (stored in UTC).
 * - Use that date's Y-M-D, then set unlock to 18:00:00 UTC (which is 11:00 AM AZ; AZ is UTC-7 year-round).
 * - If no Sunday game is found, we consider it unlocked (return null).
 */
async function getWeekUnlockUTC(week) {
  const r = await pool.query(
    `SELECT start_time
     FROM games
     WHERE week = $1 AND EXTRACT(DOW FROM start_time) = 0
     ORDER BY start_time ASC
     LIMIT 1`,
    [week]
  );
  if (!r.rows.length) return null;
  const sundayUTC = new Date(r.rows[0].start_time);
  const unlockUTC = new Date(Date.UTC(sundayUTC.getUTCFullYear(), sundayUTC.getUTCMonth(), sundayUTC.getUTCDate(), 18, 0, 0)); // 18:00 UTC = 11:00 AM AZ
  return unlockUTC;
}

/* ============================
   Submit / Upsert a Pick (Protected)
   - POST /picks/submit  (primary)
   - POST /picks/        (back-compat)
============================ */
async function submitPickHandler(req, res) {
  try {
    const { team, potw_prediction, gotw_prediction, week } = req.body;
    const user_id = req.user?.user_id;

    if (!user_id) return res.status(401).json({ error: "Unauthorized" });
    if (!Number.isFinite(Number(week)) || Number(week) < 1) {
      return res.status(400).json({ error: "Invalid or missing week" });
    }
    if (!team || typeof team !== "string") {
      return res.status(400).json({ error: "team is required" });
    }

    const w = Number(week);
    const potw = (potw_prediction === "" || potw_prediction === undefined) ? null : Number(potw_prediction);
    const gotw = (gotw_prediction === "" || gotw_prediction === undefined) ? null : Number(gotw_prediction);

    const result = await pool.query(
      `INSERT INTO picks (user_id, week, team, potw_prediction, gotw_prediction)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, week)
       DO UPDATE SET team = EXCLUDED.team,
                     potw_prediction = EXCLUDED.potw_prediction,
                     gotw_prediction = EXCLUDED.gotw_prediction
       RETURNING id, user_id, week, team, potw_prediction, gotw_prediction`,
      [user_id, w, team, potw, gotw]
    );

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error submitting pick:", err);
    return res.status(500).json({ error: "Failed to submit pick" });
  }
}
router.post("/submit", authenticateToken, submitPickHandler);
router.post("/", authenticateToken, submitPickHandler);

/* ============================
   Private Picks (Protected)
============================ */
router.get("/season/private", authenticateToken, ensureSelf, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT week, team, potw_prediction, gotw_prediction
       FROM picks
       WHERE user_id = $1
       ORDER BY week ASC`,
      [req.requested_user_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching season picks:", err);
    return res.status(500).json({ error: "Failed to fetch season picks" });
  }
});

router.get("/week/:week/private", authenticateToken, ensureSelf, async (req, res) => {
  const week = Number(req.params.week);
  if (!Number.isFinite(week)) {
    return res.status(400).json({ error: "Invalid week" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT week, team, potw_prediction, gotw_prediction
       FROM picks
       WHERE week = $1 AND user_id = $2`,
      [week, req.requested_user_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching private picks:", err);
    return res.status(500).json({ error: "Failed to fetch private picks" });
  }
});

/* ============================
   Public Picks (Unlocked Sunday 11:00 AM AZ)
   GET /picks/week/:week/public
============================ */
router.get("/week/:week/public", async (req, res) => {
  const week = Number(req.params.week);
  const QA_MODE = process.env.QA_MODE === "true";

  if (!Number.isFinite(week)) {
    return res.status(400).json({ error: "Invalid week" });
  }

  try {
    // Gate public view until Sunday 11:00 AM AZ for that week
    const unlockUTC = await getWeekUnlockUTC(week);
    if (unlockUTC) {
      const nowUTC = new Date();
      if (nowUTC < unlockUTC) {
        return res.json({
          qa_mode: QA_MODE,
          locked: true,
          unlock_at_iso: unlockUTC.toISOString(),
          picks: []
        });
      }
    }

    // Pull all data to compute correctness, fav/dog, GOTW/POTW points
    const { rows } = await pool.query(
      `SELECT 
          p.week, p.team, p.potw_prediction, p.gotw_prediction,
          u.first_name,
          g.home_team, g.away_team, g.home_score, g.away_score,
          g.favorite, g.spread,
          gotw.home_team AS gotw_home, gotw.away_team AS gotw_away, gotw.game_total_points,
          potw.player_total_yards
       FROM picks p
       JOIN users u ON p.user_id = u.id
       JOIN games g ON p.week = g.week AND (p.team = g.home_team OR p.team = g.away_team)
       LEFT JOIN game_of_the_week gotw ON gotw.week = p.week
       LEFT JOIN player_of_the_week potw ON potw.week = p.week
       WHERE p.week = $1`,
      [week]
    );

    if (!rows.length) {
      return res.json({ qa_mode: QA_MODE, locked: false, picks: [] });
    }

    // GOTW actual total if available
    let gotwActualTotal = null;
    if (rows[0].gotw_home && rows[0].gotw_away) {
      const gotwGame = rows.find(r => r.home_team === r.gotw_home && r.away_team === r.gotw_away);
      if (gotwGame && gotwGame.home_score != null && gotwGame.away_score != null) {
        gotwActualTotal = gotwGame.home_score + gotwGame.away_score;
      }
    }

    // POTW actual yards (for tiebreakers + exact bonus)
    const potwActualYards = rows[0].player_total_yards ?? null;

    // Rank GOTW (closest to actual total; tie → closest POTW yards)
    const gotwRanksByName = {};
    if (gotwActualTotal !== null) {
      const gotwPicks = rows.map(r => ({
        first_name: r.first_name,
        diff: Math.abs((r.gotw_prediction ?? Number.POSITIVE_INFINITY) - gotwActualTotal),
        potw_diff: (potwActualYards != null && r.potw_prediction != null)
          ? Math.abs(r.potw_prediction - potwActualYards)
          : Number.POSITIVE_INFINITY
      }));
      gotwPicks.sort((a, b) => (a.diff - b.diff) || (a.potw_diff - b.potw_diff));
      let rank = 1;
      gotwPicks.forEach((p, i) => {
        if (i > 0) {
          const prev = gotwPicks[i - 1];
          if (!(p.diff === prev.diff && p.potw_diff === prev.potw_diff)) rank = i + 1;
        }
        gotwRanksByName[p.first_name] = rank; // 1-based
      });
    }

    // Compute points per pick
    const mult = weekMultiplier(week);
    let picksWithPoints = rows.map(r => {
      // winner?
      let isCorrectPick = false;
      if (r.home_score != null && r.away_score != null && r.home_score !== r.away_score) {
        const winner = r.home_score > r.away_score ? r.home_team : r.away_team;
        isCorrectPick = (r.team === winner);
      }

      // favorite vs dog?
      const isFavorite = r.favorite ? (r.team === r.favorite) : null;

      // base pick points
      let basePickPoints = 0;
      if (isCorrectPick) basePickPoints = (isFavorite === true) ? 1 : 2;

      // GOTW points
      const rank = gotwRanksByName[r.first_name] || null;
      let gotwPoints = 0;
      if (rank === 1) gotwPoints = 3;
      else if (rank === 2) gotwPoints = 2;
      else if (rank === 3) gotwPoints = 1;

      // POTW exact +3
      const potwExact = (potwActualYards != null && r.potw_prediction != null)
        ? (Number(r.potw_prediction) === Number(potwActualYards))
        : false;

      const totalPoints = mult * (basePickPoints + gotwPoints + (potwExact ? 3 : 0));

      return {
        ...r,
        is_favorite: isFavorite,          // true/false/null
        is_correct_pick: isCorrectPick,   // boolean
        gotw_rank: rank,                  // 1/2/3/null
        potw_exact: potwExact,            // boolean
        total_points: totalPoints
      };
    });

    // Weekly winner (max points; tie → closest POTW)
    const maxPts = Math.max(...picksWithPoints.map(p => p.total_points));
    let top = picksWithPoints.filter(p => p.total_points === maxPts);
    if (top.length > 1) {
      top.sort((a, b) => {
        const aDiff = (potwActualYards != null && a.potw_prediction != null) ? Math.abs(a.potw_prediction - potwActualYards) : Number.POSITIVE_INFINITY;
        const bDiff = (potwActualYards != null && b.potw_prediction != null) ? Math.abs(b.potw_prediction - potwActualYards) : Number.POSITIVE_INFINITY;
        return aDiff - bDiff;
      });
    }
    const winnerNames = top.length ? [top[0].first_name] : [];
    picksWithPoints = picksWithPoints.map(p => ({ ...p, is_weekly_winner: winnerNames.includes(p.first_name) }));

    return res.json({ qa_mode: QA_MODE, locked: false, picks: picksWithPoints });
  } catch (err) {
    console.error("Error fetching public picks:", err);
    return res.status(500).json({ error: "Failed to fetch public picks" });
  }
});

module.exports = router;
