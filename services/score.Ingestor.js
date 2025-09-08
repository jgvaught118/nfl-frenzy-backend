// backend/services/score.Ingestor.js
const pool = require("../db");
// NOTE: filename is scores.ProviderFactory.js (case-sensitive)
const { getProvider } = require("./scores.ProviderFactory");

/** Best-guess current NFL season year (e.g. Sep 2025 -> 2025, Feb 2026 -> 2025) */
function normalizeSeasonYear(seasonYear) {
  if (Number.isFinite(Number(seasonYear))) return Number(seasonYear);
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0=Jan
  // NFL “regular” season starts ~Sep; anything before July -> use previous year
  return m >= 6 ? y : y - 1;
}

/**
 * Fetch remote scores for a week and upsert them into `games`.
 * Expects your `games` rows to already exist (seeded with matchups).
 */
async function fetchAndIngest({ week, seasonYear }) {
  const provider = getProvider();
  const season = normalizeSeasonYear(seasonYear);
  const wk = Number(week);

  const games = await provider.fetchWeekScores({ week: wk, seasonYear: season });

  let updated = 0;
  for (const g of games) {
    // Each item must have these normalized keys
    const {
      week,
      home_team,
      away_team,
      home_score, // number | null
      away_score, // number | null
      kickoff,    // ISO string | null
    } = g;

    const res = await pool.query(
      `UPDATE games
         SET home_score = $1,
             away_score = $2,
             kickoff    = COALESCE(kickoff, $3)
       WHERE week = $4 AND home_team = $5 AND away_team = $6`,
      [home_score, away_score, kickoff, week, home_team, away_team]
    );

    if (res.rowCount > 0) updated += 1;
  }

  return { updated, seasonYear: season, week: wk };
}

module.exports = { fetchAndIngest };
