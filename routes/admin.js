// backend/routes/admin.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateToken = require("../middleware/authMiddleware");

/**
 * Admin guard:
 *  - requires a valid JWT (authenticateToken)
 *  - and users.is_admin = true
 */
async function ensureAdmin(req, res, next) {
  try {
    if (!req.user?.user_id) return res.status(401).json({ error: "Unauthorized" });
    const u = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.user_id]);
    if (!u.rows.length || !u.rows[0].is_admin) {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }
    next();
  } catch (e) {
    console.error("ensureAdmin error:", e);
    res.status(500).json({ error: "Internal error (admin check)" });
  }
}

/* -------------------------------------------------------------------------- */
/*                  Detect the real kickoff column in `games`                  */
/* -------------------------------------------------------------------------- */

const CANDIDATE_KICKOFF_COLS = ["kickoff", "start_time", "kickoff_time"];
let KICKOFF_COL = null; // cache

async function detectKickoffColumn() {
  if (KICKOFF_COL) return KICKOFF_COL;
  const q = `
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'games'
       AND column_name = ANY($1::text[])
  `;
  const r = await pool.query(q, [CANDIDATE_KICKOFF_COLS]);
  // Preserve our preference order: kickoff > start_time > kickoff_time
  for (const cand of CANDIDATE_KICKOFF_COLS) {
    if (r.rows.some(row => row.column_name === cand)) {
      KICKOFF_COL = cand;
      break;
    }
  }
  if (!KICKOFF_COL) {
    throw new Error(
      "No suitable kickoff column found on games. Expected one of: " +
      CANDIDATE_KICKOFF_COLS.join(", ")
    );
  }
  return KICKOFF_COL;
}

/** Earliest SUNDAY kickoff (UTC) for a week — uses the detected column */
async function firstSundayKickoffUTC(week) {
  const col = await detectKickoffColumn();
  // Safe: `col` is picked from a known whitelist, not user input
  const sql = `
    SELECT ${col} AS ko
      FROM games
     WHERE week = $1
       AND EXTRACT(DOW FROM ${col}) = 0
     ORDER BY ${col} ASC
     LIMIT 1
  `;
  const r = await pool.query(sql, [week]);
  if (!r.rows.length || !r.rows[0].ko) return null;
  return new Date(r.rows[0].ko);
}

/* -------------------------------------------------------------------------- */
/*                              CURRENT WEEK API                               */
/* -------------------------------------------------------------------------- */

/**
 * GET /admin/current_week
 * Returns { current_week, is_locked }
 *
 * current_week = latest GOTW week or 1 if none.
 * is_locked = now >= first Sunday kickoff for that week (using detected column).
 */
router.get("/current_week", async (_req, res) => {
  try {
    const gotw = await pool.query(
      `SELECT week FROM game_of_the_week ORDER BY week DESC LIMIT 1`
    );
    const currentWeek = gotw.rows.length ? Number(gotw.rows[0].week) : 1;

    let is_locked = false;
    try {
      const sundayUTC = await firstSundayKickoffUTC(currentWeek);
      if (sundayUTC) {
        is_locked = new Date() >= sundayUTC;
      } else {
        // Fallback: next Sunday 12:00 local (best-effort if schedule missing)
        const now = new Date();
        const kickoffTime = new Date();
        const today = now.getDay();              // 0=Sun
        const daysUntilSunday = (7 - today) % 7; // 0 if today Sun
        kickoffTime.setDate(now.getDate() + daysUntilSunday);
        kickoffTime.setHours(12, 0, 0, 0);
        is_locked = now >= kickoffTime;
      }
    } catch (e) {
      console.warn("current_week lock calc fallback:", e.message);
    }

    res.json({ current_week: currentWeek, is_locked });
  } catch (error) {
    console.error("Error fetching current week:", error);
    res.status(500).json({ error: "Failed to fetch current week" });
  }
});

/* -------------------------------------------------------------------------- */
/*                        WEEK DETAILS (public/unauth OK)                      */
/* -------------------------------------------------------------------------- */

/**
 * GET /admin/week/:week/details
 * Returns:
 * {
 *   week,
 *   gotw: { home_team, away_team, game_total_points } | null,
 *   potw: { player_total_yards, player_name?, team? } | null,
 *   first_sunday_kickoff: ISO|null,
 *   locked: boolean
 * }
 *
 * POTW is schema-tolerant: we try rich columns and fall back to yards-only if needed.
 */
router.get("/week/:week/details", async (req, res) => {
  const week = Number(req.params.week);
  if (!Number.isFinite(week) || week < 1) return res.status(400).json({ error: "Invalid week" });

  try {
    const gotwQ = await pool.query(
      `SELECT home_team, away_team, game_total_points
         FROM game_of_the_week
        WHERE week = $1
        LIMIT 1`,
      [week]
    );

    // POTW: try rich (name/team/yards), else fallback to yards-only
    let potw = null;
    try {
      const potwRich = await pool.query(
        `SELECT player_total_yards, player_name, team
           FROM player_of_the_week
          WHERE week = $1
          LIMIT 1`,
        [week]
      );
      potw = potwRich.rows[0] || null;
    } catch (err) {
      if (err && err.code === "42703") {
        const potwSimple = await pool.query(
          `SELECT player_total_yards
             FROM player_of_the_week
            WHERE week = $1
            LIMIT 1`,
          [week]
        );
        potw = potwSimple.rows[0] || null;
      } else {
        throw err;
      }
    }

    const sundayUTC = await firstSundayKickoffUTC(week);
    const now = new Date();

    res.json({
      week,
      gotw: gotwQ.rows[0] || null,
      potw,
      first_sunday_kickoff: sundayUTC ? sundayUTC.toISOString() : null,
      locked: sundayUTC ? now >= sundayUTC : false,
    });
  } catch (error) {
    console.error("Error fetching week details:", error);
    res.status(500).json({ error: "Failed to fetch week details" });
  }
});

/* -------------------------------------------------------------------------- */
/*                         ADMIN: SET / UPDATE GOTW                            */
/* -------------------------------------------------------------------------- */

/**
 * PUT /admin/week/:week/gotw
 * Body: { home_team, away_team, game_total_points|null }
 * - Validates that the matchup exists in games for that week.
 * - Upserts the GOTW row.
 */
router.put("/week/:week/gotw", authenticateToken, ensureAdmin, async (req, res) => {
  const week = Number(req.params.week);
  const { home_team, away_team, game_total_points } = req.body || {};
  if (!Number.isFinite(week) || week < 1) return res.status(400).json({ error: "Invalid week" });
  if (!home_team || !away_team) return res.status(400).json({ error: "home_team and away_team are required" });

  try {
    // Validate matchup exists for this week
    const match = await pool.query(
      `SELECT 1 FROM games WHERE week = $1 AND home_team = $2 AND away_team = $3 LIMIT 1`,
      [week, home_team, away_team]
    );
    if (!match.rows.length) {
      return res.status(400).json({ error: "No such matchup (home vs away) for this week" });
    }

    const q = `
      INSERT INTO game_of_the_week (week, home_team, away_team, game_total_points)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (week) DO UPDATE
      SET home_team = EXCLUDED.home_team,
          away_team = EXCLUDED.away_team,
          game_total_points = EXCLUDED.game_total_points
      RETURNING week, home_team, away_team, game_total_points
    `;
    const ins = await pool.query(q, [week, home_team, away_team, game_total_points ?? null]);
    res.json({ ok: true, gotw: ins.rows[0] });
  } catch (error) {
    console.error("PUT /admin/week/:week/gotw error:", error);
    res.status(500).json({ error: "Failed to save GOTW" });
  }
});

/* -------------------------------------------------------------------------- */
/*                         ADMIN: SET / UPDATE POTW                            */
/* -------------------------------------------------------------------------- */

/**
 * PUT /admin/week/:week/potw
 * Body: { player_total_yards, player_name?, team? }
 * - If a row exists: updates yards only (keeps existing name/team).
 * - If not: tries rich insert (name/team/yards) with safe defaults,
 *   and if columns don't exist, falls back to yards-only insert.
 */
router.put("/week/:week/potw", authenticateToken, ensureAdmin, async (req, res) => {
  const week = Number(req.params.week);
  let { player_total_yards, player_name, team } = req.body || {};
  if (!Number.isFinite(week) || week < 1) return res.status(400).json({ error: "Invalid week" });

  // normalize yards
  if (player_total_yards === "" || typeof player_total_yards === "undefined") {
    player_total_yards = null;
  } else if (player_total_yards !== null) {
    const n = Number(player_total_yards);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "player_total_yards must be a non-negative number or null" });
    }
    player_total_yards = n;
  }

  try {
    const existing = await pool.query(
      `SELECT week FROM player_of_the_week WHERE week = $1`,
      [week]
    );

    if (existing.rows.length) {
      // Update yards only
      const upd = await pool.query(
        `UPDATE player_of_the_week
            SET player_total_yards = $2
          WHERE week = $1
        RETURNING week, player_total_yards`,
        [week, player_total_yards]
      );
      return res.json({ ok: true, potw: upd.rows[0] });
    } else {
      // Try rich insert first (name/team/yards). Defaults avoid NOT NULL violations if present.
      const nameVal = player_name ?? "TBD";
      const teamVal = team ?? "TBD";
      try {
        const insRich = await pool.query(
          `INSERT INTO player_of_the_week (week, player_name, team, player_total_yards)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (week) DO UPDATE
             SET player_name = EXCLUDED.player_name,
                 team = EXCLUDED.team,
                 player_total_yards = EXCLUDED.player_total_yards
           RETURNING week, player_total_yards, player_name, team`,
          [week, nameVal, teamVal, player_total_yards]
        );
        return res.json({ ok: true, potw: insRich.rows[0] });
      } catch (err) {
        if (err && err.code === "42703") {
          // Column(s) missing -> fallback to yards-only row
          const insSimple = await pool.query(
            `INSERT INTO player_of_the_week (week, player_total_yards)
             VALUES ($1, $2)
             ON CONFLICT (week) DO UPDATE
               SET player_total_yards = EXCLUDED.player_total_yards
             RETURNING week, player_total_yards`,
            [week, player_total_yards]
          );
          return res.json({ ok: true, potw: insSimple.rows[0] });
        }
        throw err;
      }
    }
  } catch (error) {
    console.error("PUT /admin/week/:week/potw error:", error);
    res.status(500).json({ error: "Failed to save POTW" });
  }
});

/* -------------------------------------------------------------------------- */
/*                 (Optional) Legacy POST endpoints you had                   */
/* -------------------------------------------------------------------------- */

router.post("/game-of-the-week", async (req, res) => {
  try {
    const { week, home_team, away_team, game_total_points } = req.body;
    if (!week || !home_team || !away_team || game_total_points === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const result = await pool.query(
      `INSERT INTO game_of_the_week (week, home_team, away_team, game_total_points)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (week) DO UPDATE
       SET home_team = EXCLUDED.home_team,
           away_team = EXCLUDED.away_team,
           game_total_points = EXCLUDED.game_total_points
       RETURNING *`,
      [week, home_team, away_team, game_total_points]
    );
    res.status(201).json({ message: "Game of the Week set", data: result.rows[0] });
  } catch (error) {
    console.error("Error setting Game of the Week:", error);
    res.status(500).json({ error: "Failed to set Game of the Week" });
  }
});

router.post("/player-of-the-week", async (req, res) => {
  try {
    const { week, player_name, team, player_total_yards } = req.body;
    if (!week || player_total_yards === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    try {
      const result = await pool.query(
        `INSERT INTO player_of_the_week (week, player_name, team, player_total_yards)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (week) DO UPDATE
           SET player_name = EXCLUDED.player_name,
               team = EXCLUDED.team,
               player_total_yards = EXCLUDED.player_total_yards
         RETURNING *`,
        [week, player_name ?? "TBD", team ?? "TBD", player_total_yards]
      );
      return res.status(201).json({ message: "Player of the Week set", data: result.rows[0] });
    } catch (err) {
      if (err && err.code === "42703") {
        const fallback = await pool.query(
          `INSERT INTO player_of_the_week (week, player_total_yards)
           VALUES ($1, $2)
           ON CONFLICT (week) DO UPDATE
             SET player_total_yards = EXCLUDED.player_total_yards
           RETURNING *`,
          [week, player_total_yards]
        );
        return res.status(201).json({ message: "Player of the Week set (yards only)", data: fallback.rows[0] });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error setting Player of the Week:", error);
    res.status(500).json({ error: "Failed to set Player of the Week" });
  }
});

module.exports = router;
