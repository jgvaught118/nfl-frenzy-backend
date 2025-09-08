// backend/routes/scores.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// IMPORTANT: match the actual filename exactly (Linux is case-sensitive).
// If your file is services/score.Ingestor.js, this require must be:
const { fetchAndIngest } = require("../services/score.Ingestor");

// Very light admin gate using a shared secret. If you already have JWT admin
// middleware, you can swap this out.
function requireAdmin(req, res, next) {
  const key = process.env.SCORES_ADMIN_KEY;
  const header = req.headers.authorization || "";
  if (!key) return res.status(500).json({ error: "SCORES_ADMIN_KEY not set" });
  if (header === `Bearer ${key}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Simple health ping
router.get("/health", (_req, res) => {
  res.json({ ok: true, route: "/admin/scores" });
});

// POST /admin/scores/fetch-now  { week?: number | "current", seasonYear?: number }
router.post("/fetch-now", requireAdmin, async (req, res) => {
  try {
    let { week, seasonYear } = req.body || {};

    // Derive a reasonable default week if not provided
    if (!week || week === "current") {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(week),1) AS wk FROM games WHERE kickoff IS NOT NULL`
      );
      week = Number(rows?.[0]?.wk || 1);
    } else {
      week = Number(week);
    }

    const result = await fetchAndIngest({ week, seasonYear });
    res.json({ ok: true, week, ...result });
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
         FROM games
        WHERE week = $1
        ORDER BY id`,
      [week]
    );
    res.json({ week, games: rows });
  } catch (e) {
    console.error("status error:", e);
    res.status(500).json({ error: "Failed to get status" });
  }
});

module.exports = router;
