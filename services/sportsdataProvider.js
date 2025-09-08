// backend/services/sportsdataProvider.js
const axios = require("axios");

// Map SportsDataIO team codes -> your DB full names
const TEAM_MAP = {
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
  GB : "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC : "Kansas City Chiefs",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LV : "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE : "New England Patriots",
  NO : "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF : "San Francisco 49ers",
  TB : "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
};

function makeSeasonKey(year) {
  // SportsDataIO expects "2025REG"
  return `${year}REG`;
}

/**
 * Fetch a week's games from SportsDataIO and normalize to:
 * {
 *   week, home_team, away_team, home_score, away_score, kickoff
 * }
 */
async function fetchWeekScores({ week, seasonYear }) {
  const apiKey = process.env.SPORTSDATA_API_KEY;
  if (!apiKey) throw new Error("SPORTSDATA_API_KEY is missing");

  const seasonKey = makeSeasonKey(seasonYear);
  // Docs: ScoresByWeek/{season}/{week}
  // https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/2025REG/1
  const url = `https://api.sportsdata.io/v3/nfl/scores/json/ScoresByWeek/${seasonKey}/${week}`;

  const { data } = await axios.get(url, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
    timeout: 15000,
  });

  // Normalize results (defensive parsing)
  return (Array.isArray(data) ? data : []).map((g) => {
    // Prefer abbreviations -> full name via TEAM_MAP
    const homeAbbr = g.HomeTeam;
    const awayAbbr = g.AwayTeam;

    const homeFull =
      TEAM_MAP[homeAbbr] || g.HomeTeamName || g.StadiumDetails?.HomeTeam || homeAbbr;
    const awayFull =
      TEAM_MAP[awayAbbr] || g.AwayTeamName || awayAbbr;

    const home_score =
      Number.isFinite(Number(g.HomeScore)) ? Number(g.HomeScore) : null;
    const away_score =
      Number.isFinite(Number(g.AwayScore)) ? Number(g.AwayScore) : null;

    const kickoff = g.Date ? new Date(g.Date).toISOString() : null;

    return {
      week: Number(g.Week) || Number(week),
      home_team: homeFull,
      away_team: awayFull,
      home_score,
      away_score,
      kickoff,
    };
  });
}

module.exports = { fetchWeekScores };
