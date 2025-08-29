// nfl-frezy-backend/routes/games.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const fetch = require('node-fetch');

// Helper: Get week number from a date (adjust season opener if needed)
function getNFLWeekFromDate(gameDate) {
  const seasonStart = new Date('2025-09-04T00:00:00Z'); // Adjust to 2025 season opener
  const diff = new Date(gameDate) - seasonStart;
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
  return week > 0 ? week : 1;
}

/**
 * 1) /games/week/:week
 * Fetch games for a specific week as the Picks Form expects
 */
router.get('/week/:week', async (req, res) => {
  const { week } = req.params;

  try {
    const result = await db.query(
      `SELECT
         id,
         week,
         home_team,
         away_team,
         start_time AS kickoff,
         favorite,
         spread,
         home_score,
         away_score
       FROM games
       WHERE week = $1
       ORDER BY start_time`,
      [week]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No games found for this week" });
    }

    return res.json(result.rows);
  } catch (err) {
    console.error('Error fetching games for week:', err);
    return res.status(500).json({ error: 'Error fetching games for this week' });
  }
});

/**
 * 2) /games/update
 * Pulls schedule & odds from The Odds API
 */
router.get('/update', async (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${apiKey}&regions=us&markets=spreads&oddsFormat=american`;

  try {
    const response = await fetch(url);
    const games = await response.json();

    let insertedCount = 0;

    for (const game of games) {
      const { home_team, away_team, commence_time, bookmakers } = game;
      const startTime = new Date(commence_time);
      const week = getNFLWeekFromDate(startTime);

      const draftKings = bookmakers?.find(b => b.key === 'draftkings') || bookmakers?.[0];
      const spreadMarket = draftKings?.markets?.find(m => m.key === 'spreads');

      let favorite = null;
      let spread = null;

      if (spreadMarket && spreadMarket.outcomes?.length === 2) {
        const [team1, team2] = spreadMarket.outcomes;
        if (team1.point < team2.point) {
          favorite = team1.name;
          spread = Math.abs(team1.point);
        } else {
          favorite = team2.name;
          spread = Math.abs(team2.point);
        }
      }

      await db.query(
        `INSERT INTO games (week, home_team, away_team, start_time, favorite, spread)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (week, home_team, away_team) DO NOTHING`,
        [week, home_team, away_team, startTime, favorite, spread]
      );

      insertedCount++;
    }

    console.log(`Inserted ${insertedCount} games.`);
    return res.status(200).json({ message: `${insertedCount} games inserted.` });
  } catch (error) {
    console.error('Error updating games:', error);
    return res.status(500).json({ error: 'Failed to update games' });
  }
});

/**
 * 3) /games/update-scores
 * Pulls FINAL scores from TheSportsDB and updates DB
 */
router.get('/update-scores', async (req, res) => {
  const apiKey = process.env.SPORTSDB_API_KEY || process.env.THESPORTSDB_API_KEY;

  if (!apiKey) {
    console.error("❌ SPORTSDB_API_KEY (or THESPORTSDB_API_KEY) is missing from env");
    return res.status(500).json({ error: "SPORTSDB_API_KEY is not set" });
  }

  const url = `https://www.thesportsdb.com/api/v1/json/${apiKey}/eventspastleague.php?id=4391`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data || !data.events) {
      console.error("❌ Invalid response from SportsDB:", data);
      return res.status(500).json({ error: "Invalid response from SportsDB" });
    }

    let updatedCount = 0;

    for (const event of data.events) {
      const homeTeam = event.strHomeTeam;
      const awayTeam = event.strAwayTeam;
      const homeScore = parseInt(event.intHomeScore);
      const awayScore = parseInt(event.intAwayScore);

      if (isNaN(homeScore) || isNaN(awayScore)) {
        console.log(`Skipping game: ${homeTeam} vs ${awayTeam} - missing scores`);
        continue;
      }

      const result = await db.query(
        `UPDATE games
         SET home_score = $1, away_score = $2
         WHERE home_team = $3 AND away_team = $4`,
        [homeScore, awayScore, homeTeam, awayTeam]
      );

      if (result.rowCount > 0) {
        updatedCount++;
        console.log(`✅ Updated score: ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`);
      } else {
        console.log(`⚠ No match in DB for: ${homeTeam} vs ${awayTeam}`);
      }
    }

    return res.status(200).json({ message: `${updatedCount} games updated with final scores.` });
  } catch (error) {
    console.error('Error updating scores:', error);
    return res.status(500).json({ error: 'Failed to update scores' });
  }
});

module.exports = router;
