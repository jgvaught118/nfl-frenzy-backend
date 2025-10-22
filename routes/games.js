// routes/games.js
/* eslint-disable no-console */
const express = require("express");
const router = express.Router();
const db = require("../db");

/**
 * GET /games/week/:week
 * Returns all games for a specific week.
 * Uses live line_* fields written by the odds sync job.
 * Response keeps the legacy keys "favorite" and "spread" so the frontend works unchanged.
 */
router.get("/week/:week", async (req, res, next) => {
  try {
    const week = Number(req.params.week);
    if (!Number.isFinite(week)) {
      return res.status(400).json({ error: "Invalid week" });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        week,
        home_team,
        away_team,
        kickoff,           -- correct column in your DB
        home_score,
        away_score,
        line_favorite,
        line_spread,
        line_over_under,
        line_source,
        line_updated_at
      FROM games
      WHERE week = $1
      ORDER BY kickoff, id;
      `,
      [week]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "No games found for this week" });
    }

    // Map DB -> API shape that the frontend already uses
    const payload = rows.map((r) => ({
      id: r.id,
      week: r.week,
      home_team: r.home_team,
      away_team: r.away_team,
      kickoff: r.kickoff,
      home_score: r.home_score,
      away_score: r.away_score,

      // legacy keys used by UI
      favorite: r.line_favorite ?? null,
      spread: r.line_spread != null ? String(r.line_spread) : null,

      // extra info (available if/when you want to show it)
      over_under: r.line_over_under != null ? String(r.line_over_under) : null,
      line_source: r.line_source || null,
      line_updated_at: r.line_updated_at || null,
    }));

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * (Deprecated) GET /games/update
 * Previously pulled odds directly. We now populate odds via the CI job (scripts/fetchOdds.js).
 * Return 410 Gone to avoid accidental usage.
 */
router.get("/update", (_req, res) => {
  res
    .status(410)
    .json({
      error: "Deprecated",
      message:
        "Odds are synced by CI (scripts/fetchOdds.js). This endpoint is disabled.",
    });
});

/**
 * GET /games/update-scores
 * Keeps your existing score update pathway (TheSportsDB) for now.
 * If you’ve replaced scores elsewhere, feel free to remove this route later.
 */
router.get("/update-scores", async (req, res) => {
  const fetch = (await import("node-fetch")).default;
  const apiKey = process.env.SPORTSDB_API_KEY || process.env.THESPORTSDB_API_KEY;

  if (!apiKey) {
    console.error("❌ SPORTSDB_API_KEY (or THESPORTSDB_API_KEY) is missing from env");
    return res.status(500).json({ error: "SPORTSDB_API_KEY is not set" });
  }

  const url = `https://www.thesportsdb.com/api/v1/json/${apiKey}/eventspastleague.php?id=4391`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data || !data.events) {
      console.error("❌ Invalid response from SportsDB:", data);
      return res.status(500).json({ error: "Invalid response from SportsDB" });
    }

    let updatedCount = 0;

    for (const event of data.events) {
      const homeTeam = event.strHomeTeam;
      const awayTeam = event.strAwayTeam;
      const homeScore = parseInt(event.intHomeScore, 10);
      const awayScore = parseInt(event.intAwayScore, 10);

      if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) {
        continue;
      }

      const result = await db.query(
        `
        UPDATE games
           SET home_score = $1, away_score = $2
         WHERE home_team = $3 AND away_team = $4
        `,
        [homeScore, awayScore, homeTeam, awayTeam]
      );

      if (result.rowCount > 0) updatedCount++;
    }

    return res.status(200).json({ message: `${updatedCount} games updated with final scores.` });
  } catch (error) {
    console.error("Error updating scores:", error);
    return res.status(500).json({ error: "Failed to update scores" });
  }
});

module.exports = router;
