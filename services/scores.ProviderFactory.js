// backend/services/scores.ProviderFactory.js
const sportsdataProvider = require("./sportsdataProvider");

/**
 * Chooses which score provider to use.
 * Right now we only support SportsDataIO if SPORTSDATA_API_KEY is present.
 */
function getProvider() {
  if (process.env.SPORTSDATA_API_KEY) return sportsdataProvider;
  throw new Error("No score provider configured (SPORTSDATA_API_KEY missing).");
}

module.exports = { getProvider };
