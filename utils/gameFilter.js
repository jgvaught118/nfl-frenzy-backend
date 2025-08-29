// utils/gameFilter.js
function getEligibleTeams(games) {
  const now = new Date();

  // Only return teams from games that haven't started yet
  return games
    .filter(game => new Date(game.commence_time) > now)
    .flatMap(game => [game.home_team, game.away_team]);
}

module.exports = { getEligibleTeams };
