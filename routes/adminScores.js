// backend/routes/adminScores.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../db");

/** Require shared secret in Authorization: Bearer <SCORES_ADMIN_KEY> */
function requireAdminKey(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== process.env.SCORES_ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/** Abbrev -> full team name mapping to match your DB “games.home_team / away_team” values */
const TEAM_FULL = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB:  "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC:  "Kansas City Chiefs",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LV:  "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE:  "New England Patriots",
  NO:  "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF:  "San Francisco 49ers",
  TB:  "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
};

/** Simple current week fallback if not supplied */
function getCurrentWeekNumber() {
  // Keep simple; you already have /admin/current_week. If needed we could call it.
  // For manual calls without a body, default to 1.
  return 1;
}

/**
 * POST /admin/scores/fetch-now
 * Body or query: { week: <1-18> }
 * Pulls scores from sportsdata.io and updates the `games` table for that week.
 */
router.post("/fetch-now", requireAdminKey, async (req, res) => {
  try {
    const season = 2025; // adjust if your DB is a different season
    const week = Number(req.body?.week ?? req.query?.week ?? getCurrentWeekNumber());

    if (!Number.isFinite(week) || week < 1 || week > 18) {
      return res.status(400).json({ error: "Invalid week" });
    }

    if (!process.env.SPORTSDATA_API_KEY) {
      return res.status(500).json({ error: "SPORTSDATA_API_KEY not configured" });
    }
    if ((process.env.SCORES_PROVIDER || "").toLowerCase() !== "sportsdataio") {
      // not strictly required, but nice to sanity check
      console.warn("SCORES_PROVIDER is not 'sportsdataio'—continuing anyway.");
    }

    const apiKey = process.env.SPORTSDATA_API_KEY;
    // Sportsdata.io docs: v3/nfl/scores/json/ScoresByWeek/{season}/{week}
    // season format "2025REG"
    const seasonParam = `${season}REG`;
    const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${seasonParam}/${week}?key=${apiKey}`;

    const { data } = await axios.get(url, { timeout: 20000 });
    if (!Array.isArray(data)) {
      return res.status(502).json({ error: "Unexpected provider response format" });
    }

    let updated = 0;
    const details = [];

    for (const g of data) {
      // Only update games that have scores (Final or in-progress with non-null)
      const hs = Number.isFinite(Number(g.HomeScore)) ? Number(g.HomeScore) : null;
      const as = Number.isFinite(Number(g.AwayScore)) ? Number(g.AwayScore) : null;

      if (hs === null || as === null) continue; // skip games with no scores yet

      const homeFull = TEAM_FULL[g.HomeTeam];
      const awayFull = TEAM_FULL[g.AwayTeam];

      if (!homeFull || !awayFull) {
        details.push({
          status: "skip",
          reason: "team_map_missing",
          homeAbbrev: g.HomeTeam,
          awayAbbrev: g.AwayTeam,
        });
        continue;
      }

      // Update by exact match on week + home/away names
      const sql =
        "UPDATE games SET home_score=$1, away_score=$2 WHERE week=$3 AND home_team=$4 AND away_team=$5";
      const params = [hs, as, week, homeFull, awayFull];

      const result = await pool.query(sql, params);
      if (result.rowCount > 0) {
        updated += result.rowCount;
        details.push({
          status: "ok",
          week,
          home_team: homeFull,
          away_team: awayFull,
          home_score: hs,
          away_score: as,
        });
      } else {
        // If there’s a mismatch, capture it (useful for debugging DB names)
        details.push({
          status: "no_match_in_db",
          week,
          home_team: homeFull,
          away_team: awayFull,
          home_score: hs,
          away_score: as,
        });
      }
    }

    return res.json({ week, updated, details });
  } catch (err) {
    console.error("POST /admin/scores/fetch-now error:", err?.response?.data || err);
    return res.status(500).json({ error: "Failed to fetch or update scores" });
  }
});

module.exports = router;
