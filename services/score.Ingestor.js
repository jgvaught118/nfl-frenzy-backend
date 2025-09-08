// backend/services/scoreIngestor.js
const pool = require("../db");
const { getProvider } = require("./scoresProviderFactory");

/**
 * Normalizes team names from provider to DB's canonical names.
 * Add more synonyms here if your provider uses short names.
 */
function normalizeTeam(t) {
  if (!t) return t;
  const m = {
    "NY Jets": "New York Jets",
    "NY Giants": "New York Giants",
    "LA Rams": "Los Angeles Rams",
    "LA Chargers": "Los Angeles Chargers",
    "Washington Football Team": "Washington Commanders",
    "WAS": "Washington Commanders",
    "ARI": "Arizona Cardinals",
    "SF": "San Francisco 49ers",
    "KC": "Kansas City Chiefs",
    "TB": "Tampa Bay Buccaneers",
    "NO": "New Orleans Saints",
    "JAX": "Jacksonville Jaguars",
    "GB": "Green Bay Packers",
    "NE": "New England Patriots",
    "LV": "Las Vegas Raiders",
    "LAC": "Los Angeles Chargers",
    "LAR": "Los Angeles Rams",
    // add any others you see from your provider feed
  };
  return m[t] || t;
}

/**
 * Upsert final (or in-progress) scores for a given week.
 * - providerScores: [{ home_team, away_team, home_score, away_score, status }]
 *   status should be one of: "in_progress" | "final" | "scheduled"
 */
async function upsertWeekScores(week, providerScores) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Load our week’s games once
    const { rows: games } = await client.query(
      `SELECT id, home_team, away_team FROM games WHERE week = $1`, [week]
    );

    let updated = 0, matched = 0;

    for (const ps of providerScores) {
      const home = normalizeTeam(ps.home_team);
      const away = normalizeTeam(ps.away_team);

      const match = games.find(
        (g) => g.home_team === home && g.away_team === away
      );
      if (!match) continue;
      matched++;

      // Only write numeric scores; ignore blank/undefined
      const hs = (ps.home_score == null || isNaN(Number(ps.home_score))) ? null : Number(ps.home_score);
      const as = (ps.away_score == null || isNaN(Number(ps.away_score))) ? null : Number(ps.away_score);

      if (hs == null && as == null) continue;

      await client.query(
        `UPDATE games SET home_score = $1, away_score = $2 WHERE id = $3`,
        [hs, as, match.id]
      );
      updated++;
    }

    // If GOTW exists for this week and not yet set, set it if that game is final
    const { rows: gotwRows } = await client.query(
      `SELECT week, home_team, away_team, game_total_points
       FROM game_of_the_week
       WHERE week = $1`, [week]
    );

    if (gotwRows.length) {
      const gotw = gotwRows[0];
      if (gotw.game_total_points == null) {
        const source = providerScores.find(ps =>
          normalizeTeam(ps.home_team) === gotw.home_team &&
          normalizeTeam(ps.away_team) === gotw.away_team &&
          ps.status === "final" &&
          ps.home_score != null &&
          ps.away_score != null
        );
        if (source) {
          const total = Number(source.home_score) + Number(source.away_score);
          await client.query(
            `UPDATE game_of_the_week SET game_total_points = $1 WHERE week = $2`,
            [total, week]
          );
        }
      }
    }

    await client.query("COMMIT");
    return { matched, updated };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Fetch from the selected provider and upsert.
 * env: SCORES_PROVIDER = "sportsdata" | others you add later
 */
async function fetchAndIngest({ week, seasonYear }) {
  const provider = getProvider(process.env.SCORES_PROVIDER);
  if (!provider) {
    throw new Error(`Unknown SCORES_PROVIDER: ${process.env.SCORES_PROVIDER || "(unset)"}`);
  }
  const data = await provider.getWeekScores({ week, seasonYear });
  return upsertWeekScores(week, data);
}

module.exports = {
  fetchAndIngest,
  upsertWeekScores,
  normalizeTeam,
};
