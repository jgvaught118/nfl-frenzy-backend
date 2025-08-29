const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

// GET /odds/week/:week
router.get('/week/:week', async (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;

  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${apiKey}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Odds API error: ${response.statusText}`);

    const data = await response.json();
    console.log('Total games returned from Odds API:', data.length);

    const odds = data
      .map(game => {
        // Try Caesars
        let book = game.bookmakers.find(b => b.key === 'caesars');

        // Fallback to DraftKings
        if (!book) {
          book = game.bookmakers.find(b => b.key === 'draftkings');
        }

        // Fallback to first available
        if (!book) {
          book = game.bookmakers[0];
        }

        if (!book) return null; // still nothing

        return {
          id: game.id,
          commence_time: game.commence_time,
          home_team: game.home_team,
          away_team: game.away_team,
          sportsbook: book.key,
          markets: book.markets.map(market => ({
            type: market.key,
            outcomes: market.outcomes
          }))
        };
      })
      .filter(Boolean); // remove nulls

    res.json(odds);
  } catch (err) {
    console.error('Failed to fetch odds:', err.message);
    res.status(500).json({ error: 'Could not retrieve odds' });
  }
});

module.exports = router;
