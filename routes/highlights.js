// backend/routes/highlights.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

/** Helpers */
async function tableExists(table) {
  const q = await pool.query(`SELECT to_regclass($1) AS ref`, [`public.${table}`]);
  return !!q.rows[0].ref;
}

async function listColumns(table) {
  const q = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table]
  );
  return q.rows.map(r => r.column_name);
}

function firstExisting(cols, candidates) {
  return candidates.find(c => cols.includes(c)) || null;
}

async function fetchRow(table, weekCol, weekVal) {
  const q = await pool.query(
    `SELECT * FROM ${table} WHERE ${weekCol} = $1 ORDER BY id DESC LIMIT 1`,
    [weekVal]
  );
  return q.rows[0] || null;
}

/** Simple ping */
router.get('/highlights/ping', (_req, res) => {
  res.json({ ok: true, route: 'games/highlights' });
});

/**
 * GET /games/highlights/:week
 * Returns { week, gotw, potw }
 *  - gotw: game of the week (teams, start_time, any points/multiplier/tiebreaker available)
 *  - potw: player of the week (player, team, stat, value)
 * Tries to adapt to different column names by introspecting the schema.
 * Add ?debug=1 to see detected columns and raw rows.
 */
router.get('/highlights/:week', async (req, res) => {
  const week = Math.max(1, parseInt(req.params.week, 10) || 1);
  const debug = String(req.query.debug || '') === '1';

  const out = { week, gotw: null, potw: null };
  const dbg = { gotwColumns: null, potwColumns: null, gotwRaw: null, potwRaw: null };

  try {
    /** ---------------------- GOTW (game_of_the_week) ---------------------- */
    if (await tableExists('game_of_the_week')) {
      const gc = await listColumns('game_of_the_week');
      dbg.gotwColumns = gc;

      // Which column holds 'week'?
      const weekCol = firstExisting(gc, ['week', 'wk']);
      if (weekCol) {
        const row = await fetchRow('game_of_the_week', weekCol, week);
        dbg.gotwRaw = row;

        if (row) {
          // If the table stores a game_id, join games to get teams/time.
          const gameIdCol = firstExisting(gc, ['game_id', 'gid', 'game']);
          if (gameIdCol && row[gameIdCol] != null) {
            const gq = await pool.query(
              `SELECT id, week, home_team, away_team, start_time
                 FROM games
                WHERE id = $1
                LIMIT 1`,
              [row[gameIdCol]]
            );
            const g = gq.rows[0] || null;

            const pointsCol = firstExisting(gc, [
              'points', 'bonus_points', 'multiplier', 'tiebreaker_points', 'prediction_points'
            ]);

            out.gotw = g
              ? {
                  game_id: g.id,
                  week: g.week,
                  home_team: g.home_team,
                  away_team: g.away_team,
                  start_time: g.start_time,
                  points: pointsCol ? row[pointsCol] : null,
                }
              : null;
          } else {
            // Else: maybe teams are stored directly on game_of_the_week
            const homeCol = firstExisting(gc, ['home_team', 'home', 'home_name']);
            const awayCol = firstExisting(gc, ['away_team', 'away', 'away_name']);
            const timeCol = firstExisting(gc, ['start_time', 'kickoff', 'game_time']);
            const pointsCol = firstExisting(gc, [
              'points', 'bonus_points', 'multiplier', 'tiebreaker_points', 'prediction_points'
            ]);

            if (homeCol && awayCol) {
              out.gotw = {
                game_id: null,
                week,
                home_team: row[homeCol],
                away_team: row[awayCol],
                start_time: timeCol ? row[timeCol] : null,
                points: pointsCol ? row[pointsCol] : null,
              };
            }
          }
        }
      }
    }

    /** ---------------------- POTW (player_of_the_week) -------------------- */
    if (await tableExists('player_of_the_week')) {
      const pc = await listColumns('player_of_the_week');
      dbg.potwColumns = pc;

      const weekCol = firstExisting(pc, ['week', 'wk']);
      if (weekCol) {
        const row = await fetchRow('player_of_the_week', weekCol, week);
        dbg.potwRaw = row;

        if (row) {
          const playerCol = firstExisting(pc, ['player_name', 'player', 'name']);
          const teamCol = firstExisting(pc, ['team', 'team_name']);
          const statCol = firstExisting(pc, ['stat_type', 'stat', 'category']);
          const valueCol = firstExisting(pc, [
            'value', 'yards', 'points', 'projection', 'predicted_yards', 'predicted_value'
          ]);

          out.potw = {
            player: playerCol ? row[playerCol] : null,
            team: teamCol ? row[teamCol] : null,
            stat: statCol ? row[statCol] : null,
            value: valueCol ? row[valueCol] : null,
            week
          };
        }
      }
    }

    // If the frontend wants extra context:
    if (debug) return res.json({ ok: true, data: out, debug: dbg });

    return res.json({ ok: true, data: out });
  } catch (err) {
    console.error('[highlights] failed', err);
    return res.status(500).json({ error: 'Failed to load highlights' });
  }
});

module.exports = router;
