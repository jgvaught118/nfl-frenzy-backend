// backend/services/sportsdataProvider.js
const fetch = require("node-fetch");

/**
 * Map Sportsdata team keys to your DB names if needed.
 * Sportsdata gives Team as full city + mascot already, usually OK.
 */
function mapTeamName(s) {
  // You can fine-tune with the same mapping logic from normalizeTeam if needed
  return s;
}

/**
 * Returns
 * [
 *   { home_team, away_team, home_score, away_score, status }
 * ]
 */
async function getWeekScores({ week, seasonYear }) {
  const key = process.env.SPORTSDATA_API_KEY;
  const season = process.env.SPORTSDATA_SEASON; // e.g., "2025REG"
  if (!key || !season) {
    throw new Error("SPORTSDATA_API_KEY or SPORTSDATA_SEASON missing");
  }

  // Docs: https://sportsdata.io/developers/api-documentation/nfl#/sports-data
  const url = `https://api.sportsdata.io/api/nfl/odds/json/ScoresByWeek/${season}/${week}?key=${key}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Sportsdata error ${resp.status}: ${t}`);
  }
  const games = await resp.json();

  return games.map((g) => {
    // Sportsdata fields (varies by endpoint); adjust if needed:
    const status = (g.Status || "").toLowerCase();
    const mapped = {
      home_team: mapTeamName(g.HomeTeamFullName || g.HomeTeam || g.HomeTeamName),
      away_team: mapTeamName(g.AwayTeamFullName || g.AwayTeam || g.AwayTeamName),
      home_score: g.HomeScoreFinal ?? g.HomeScore ?? null,
      away_score: g.AwayScoreFinal ?? g.AwayScore ?? null,
      status:
        status.includes("final") ? "final" :
        status.includes("inprogress") || status.includes("in progress") ? "in_progress" :
        "scheduled",
    };
    return mapped;
  });
}

module.exports = {
  getWeekScores,
};
