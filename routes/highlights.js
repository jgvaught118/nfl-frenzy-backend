// backend/routes/highlights.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// Quick ping for sanity
router.get('/highlights/ping', (req, res) => {
  res.json({ ok: true, route: 'games/highlights' });
});

// GET /games/highlights/:week
router.get('/highlights/:week', async (req, res) => {
  try {
    const week = Number(req.params.week) || 1;

    // --- GOTW ---
    // Expect game_of_the_week to have (id, week, game_id)
    const gotwQ = await pool.query(
      `
      SELECT 
        gow.id AS gotw_id,
        gow.week,
        gow.game_id,
        g.home_team,
        g.away_team,
        g.start_time
      FROM game_of_the_week gow
      JOIN games g ON g.id = gow.game_id
      WHERE gow.week = $1
      LIMIT 1
      `,
      [week]
    );
    const gotw = gotwQ.rows[0] || null;

    // --- POTW ---
    // We don't assume exact columns: select * and map safely in JS.
    const potwQ = await pool.query(
      `SELECT * FROM player_of_the_week WHERE week = $1 LIMIT 1`,
      [week]
    );
    const rawPotw = potwQ.rows[0] || null;

    const potw = rawPotw
      ? {
          potw_id: rawPotw.id,
          week: rawPotw.week,
          player_id: rawPotw.player_id ?? null,
          player_name:
            rawPotw.player_name ??
            rawPotw.name ??
            null,
          team: rawPotw.team ?? null,
          position: rawPotw.position ?? null,
          stat_category: rawPotw.stat_category ?? null,
        }
      : null;

    return res.json({ week, gotw, potw });
  } catch (err) {
    console.error('GET /games/highlights/:week failed:', err);
    return res.status(500).json({ error: 'Failed to load highlights' });
  }
});

module.exports = router;
