// backend/services/scoresProviderFactory.js
const sportsdata = require("./sportsdataProvider");

function getProvider(kind) {
  switch ((kind || "").toLowerCase()) {
    case "sportsdata":
      return sportsdata;
    default:
      return null;
  }
}

module.exports = { getProvider };
