// routes/publicGames.js
const express = require("express");
const router = express.Router();
const { Pool } = require("pg");

// Reuse DATABASE_URL (Railway provides this); fall back to RW_DB if you prefer.
const connectionString = process.env.DATABASE_URL || process.env.RW_DB;
if (!connectionString) {
  throw new Error("Missing DATABASE_URL (or RW_DB).");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// GET /public/games?week=8
router.get("/games", async (req, res) => {
  try {
    const week = Number(req.query.week);
    const client = await pool.connect();

    // If no week provided, use current (highest week with kickoff <= now()).
    const currentWeekSql = `
      SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS current_week
      FROM games;
    `;

    const targetWeek =
      Number.isFinite(week) && week > 0
        ? week
        : Number((await client.query(currentWeekSql)).rows[0].current_week);

    const { rows } = await client.query(
      `
      SELECT id, week, kickoff,
             home_team, away_team,
             line_favorite, line_spread, line_over_under, line_source, line_updated_at
      FROM games
      WHERE week = $1
      ORDER BY id
      `,
      [targetWeek]
    );

    client.release();
    res.json(rows);
  } catch (err) {
    console.error("GET /public/games failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
