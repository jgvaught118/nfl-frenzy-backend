// backend/routes/scores.js
const express = require("express");
const router = express.Router();
const { fetchAndIngest } = require("../services/scoreIngestor");
const pool = require("../db");

// --- very light admin gate (reuse your auth if you have it) ---
function requireAdmin(req, res, next) {
  // If you already have auth middleware, use that instead:
  const header = req.headers.authorization || "";
  // Optional: trust your existing JWT and user.is_admin
  // For now, allow hitting this only if a special key is present:
  const key = process.env.SCORES_ADMIN_KEY;
  if (!key) return res.status(500).json({ error: "SCORES_ADMIN_KEY not set" });
  if (header === `Bearer ${key}`) return next();
  return res.status(403).json({ error: "Forbidden" });
}

// POST /admin/scores/fetch-now {week?, seasonYear?}
router.post("/fetch-now", requireAdmin, async (req, res) => {
  try {
    let { week, seasonYear } = req.body || {};
    if (!week) {
      // derive current week from your admin/current_week or DB (fallback = 1)
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(week),1) AS wk FROM games WHERE kickoff IS NOT NULL`
      );
      week = Number(rows[0]?.wk || 1);
    }
    const result = await fetchAndIngest({ week: Number(week), seasonYear });
    res.json({ ok: true, week: Number(week), ...result });
  } catch (e) {
    console.error("fetch-now error:", e);
    res.status(500).json({ error: e.message || "Failed to fetch scores" });
  }
});

// GET /admin/scores/status?week=1
router.get("/status", requireAdmin, async (req, res) => {
  try {
    const week = Number(req.query.week || 1);
    const { rows } = await pool.query(
      `SELECT id, home_team, away_team, home_score, away_score
       FROM games WHERE week = $1 ORDER BY id`, [week]
    );
    res.json({ week, games: rows });
  } catch (e) {
    console.error("status error:", e);
    res.status(500).json({ error: "Failed to get status" });
  }
});

module.exports = router;
