// scripts/fetchOdds.js
/* eslint-disable no-console */
const { Client } = require("pg");

/** ---------- Config & CLI ---------- **/
const { RW_DB, ODDS_API_KEY, MIN_WEEK: MIN_WEEK_ENV } = process.env;
if (!RW_DB) { console.error("Missing env: RW_DB"); process.exit(2); }
if (!ODDS_API_KEY) { console.error("Missing env: ODDS_API_KEY (The Odds API key)"); process.exit(2); }

const args = process.argv.slice(2);
const ARG = (flag) => args.includes(flag);
const getVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

// Flags
const ONLY_WEEK = getVal("--week") ? Number(getVal("--week")) : undefined;
const DO_ALL = ARG("--all");
const MAX_WEEKS = Number(getVal("--maxWeeks") || 3);
const ALLOW_PAST = ARG("--allow-past");
// hard guard that you asked for
const MIN_WEEK = Number(getVal("--minWeek") || MIN_WEEK_ENV || 0);

/** ---------- Helpers (robust name matching) ---------- **/
// Keep letters *and digits* so "49ers" survives; lower-case; strip others.
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Map common shorthand/variants to a canonical slug
function canonicalSlug(raw) {
  let x = slug(raw);

  // Normalize city shorthands
  x = x.replace(/^la(?=(rams|chargers)$)/, "losangeles");
  x = x.replace(/^ny(?=(jets|giants)$)/, "newyork");
  x = x.replace(/^kc(?=chiefs$)/, "kansascity");
  x = x.replace(/^ne(?=patriots$)/, "newengland");
  x = x.replace(/^no(?=saints$)/, "neworleans");
  x = x.replace(/^sf(?=49ers$)/, "sanfrancisco");
  x = x.replace(/^tb(?=(buccaneers|bucs)$)/, "tampabay");
  x = x.replace(/^gb(?=packers$)/, "greenbay");
  x = x.replace(/^lv(?=raiders$)/, "lasvegas");
  x = x.replace(/^jax(?=jaguars$)/, "jacksonville");
  x = x.replace(/^was(?=(footballteam|commanders)$)/, "washingtoncommanders");
  x = x.replace(/^washington(?=footballteam$)/, "washingtoncommanders");

  // Nickname-only failsafe (rare from Odds API, but harmless):
  const nicknameToCity = {
    cardinals: "arizonacardinals",
    falcons: "atlantafalcons",
    ravens: "baltimoreravens",
    bills: "buffalobills",
    panthers: "carolinapanthers",
    bears: "chicagobears",
    bengals: "cincinnatibengals",
    browns: "clevelandbrowns",
    cowboys: "dallascowboys",
    broncos: "denverbroncos",
    lions: "detroitlions",
    packers: "greenbaypackers",
    texans: "houstontexans",
    colts: "indianapoliscolts",
    jaguars: "jacksonvillejaguars",
    chiefs: "kansascitychiefs",
    raiders: "lasvegasraiders",
    chargers: "losangeleschargers",
    rams: "losangelesrams",
    dolphins: "miamidolphins",
    vikings: "minnesotavikings",
    patriots: "newenglandpatriots",
    saints: "neworleanssaints",
    giants: "newyorkgiants",
    jets: "newyorkjets",
    eagles: "philadelphiaeagles",
    steelers: "pittsburghsteelers",
    niners: "sanfrancisco49ers",
    "49ers": "sanfrancisco49ers", // digits preserved by slug()
    seahawks: "seattleseahawks",
    buccaneers: "tampabaybuccaneers",
    titans: "tennesseetitans",
    commanders: "washingtoncommanders",
  };
  if (nicknameToCity[x]) return nicknameToCity[x];

  return x;
}

// Key builder for matching
const matchKey = (home, away) =>
  `${canonicalSlug(home)}__${canonicalSlug(away)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ---------- The Odds API (Caesars) ---------- **/
async function fetchCaesarsAllOddsSnapshot() {
  const base = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url =
    `${base}?regions=us&markets=spreads,totals&oddsFormat=american&bookmakers=caesars&dateFormat=iso&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`The Odds API failed ${res.status} ${txt}`.trim());
  }

  const events = await res.json();
  console.log(`Caesars events loaded: ${Array.isArray(events) ? events.length : 0}`);

  const out = new Map();
  for (const ev of events || []) {
    const homeName = ev.home_team;
    const awayName = ev.away_team;
    if (!homeName || !awayName) continue;

    const caesars =
      (ev.bookmakers || []).find(
        (b) => b.key?.toLowerCase() === "caesars" || /caesars/i.test(b.name || "")
      ) || null;
    if (!caesars) continue;

    const spreads = (caesars.markets || []).find((m) => m.key === "spreads");
    const totals  = (caesars.markets || []).find((m) => m.key === "totals");

    let favoriteName = null;
    let spread = null;
    let overUnder = null;

    // spreads
    if (spreads?.outcomes?.length >= 2) {
      const [o1, o2] = spreads.outcomes;
      const fav = [o1, o2].find((o) => typeof o.point === "number" && o.point < 0) || null;
      if (fav) {
        favoriteName = fav.name || null;
        spread = Math.abs(Number(fav.point));
      } else if ([o1, o2].every((o) => Number(o.point) === 0)) {
        spread = 0;
      }
    }

    // totals
    if (totals?.outcomes?.length) {
      const over = totals.outcomes.find((o) => /^over$/i.test(o.name || ""));
      const pick = over || totals.outcomes[0];
      if (pick && typeof pick.point === "number") overUnder = Number(pick.point);
    }

    // which side is favorite?
    let favoriteSide = null;
    if (favoriteName) {
      const fav = canonicalSlug(favoriteName);
      const h = canonicalSlug(homeName);
      const a = canonicalSlug(awayName);
      if (fav === h) favoriteSide = "home";
      else if (fav === a) favoriteSide = "away";
    }

    const payload = {
      provider: "Caesars",
      espnHome: { name: homeName, abbr: null },
      espnAway: { name: awayName, abbr: null },
      overUnder: overUnder != null ? overUnder : null,
      favoriteSide: favoriteSide || null,
      favoriteName: favoriteName || null,
      spread: typeof spread === "number" ? spread : null,
    };

    const k1 = matchKey(homeName, awayName);
    const k2 = matchKey(awayName, homeName);
    out.set(k1, payload);
    out.set(k2, payload);
  }

  return out;
}

/** ---------- DB helpers ---------- **/
async function ensureOddsColumns(client) {
  await client.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS line_favorite    text,
      ADD COLUMN IF NOT EXISTS line_spread      numeric,
      ADD COLUMN IF NOT EXISTS line_over_under  numeric,
      ADD COLUMN IF NOT EXISTS line_source      text,
      ADD COLUMN IF NOT EXISTS line_updated_at  timestamptz;
  `);
}

async function getCurrentWeek(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(MAX(week) FILTER (WHERE kickoff <= now()), MIN(week)) AS current_week
    FROM games;
  `);
  return Number(rows[0].current_week);
}

async function weeksCurrentAndFuture(client, currentWeek) {
  const { rows } = await client.query(
    `SELECT DISTINCT week FROM games WHERE week >= $1 ORDER BY week`,
    [currentWeek]
  );
  return rows.map((r) => Number(r.week));
}

async function dbGamesForWeek(client, week) {
  const { rows } = await client.query(
    `SELECT id, week, home_team, away_team, kickoff
     FROM games
     WHERE week = $1
     ORDER BY kickoff, id`,
    [week]
  );
  return rows;
}

async function updateOdds(client, gameId, odds, currentWeek) {
  const guardWeek = ALLOW_PAST ? "" : "AND week >= $6";
  const guardKick = ALLOW_PAST ? "" : "AND kickoff > now()";

  const favorite = odds.favoriteName || null;
  const spread = odds.spread != null ? Number(odds.spread) : null;
  const ou = odds.overUnder != null ? Number(odds.overUnder) : null;
  const src = odds.provider || "Caesars";

  const sql = `
    UPDATE games
       SET line_favorite   = $1,
           line_spread     = $2,
           line_over_under = $3,
           line_source     = $4,
           line_updated_at = now()
     WHERE id = $5
       ${guardWeek}
       ${guardKick}
  `;
  const params = ALLOW_PAST
    ? [favorite, spread, ou, src, gameId]
    : [favorite, spread, ou, src, gameId, currentWeek];
  const res = await client.query(sql, params);
  return res.rowCount;
}

/** ---------- Runner ---------- **/
async function main() {
  const client = new Client({ connectionString: RW_DB, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await ensureOddsColumns(client);

  const currentWeek = await getCurrentWeek(client);

  // Decide target weeks
  let targetWeeks = [];
  if (ONLY_WEEK) {
    targetWeeks = [ONLY_WEEK];
  } else if (DO_ALL) {
    const allW = await weeksCurrentAndFuture(client, currentWeek);
    targetWeeks = allW.slice(0, Math.max(1, MAX_WEEKS));
  } else {
    targetWeeks = [currentWeek];
  }

  // Enforce the "don’t touch older weeks" guard at the script level too
  targetWeeks = targetWeeks.filter((w) => w >= MIN_WEEK);
  console.log(`\nTarget weeks: ${targetWeeks.join(", ")}  (current=${currentWeek}, minWeek=${MIN_WEEK})`);

  let totalUpdated = 0;
  let totalMissing = 0;
  let totalUnmatched = 0;

  // One snapshot of Caesars odds
  let caesars;
  try {
    caesars = await fetchCaesarsAllOddsSnapshot();
  } catch (e) {
    console.error(`✖ Caesars fetch failed: ${e.message}`);
    throw e;
  }

  for (const w of targetWeeks) {
    console.log(`\n===== ODDS: Week ${w} =====`);
    const games = await dbGamesForWeek(client, w);
    console.log(`→ DB games: ${games.length}`);

    const rows = [];
    for (const g of games) {
      const hit = caesars.get(matchKey(g.home_team, g.away_team));
      if (!hit) {
        totalUnmatched++;
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "UNMATCHED", ""]);
        continue;
      }
      if (hit.spread == null && hit.overUnder == null) {
        totalMissing++;
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "MISSING", hit.provider || ""]);
        continue;
      }
      const changed = await updateOdds(client, g.id, hit, currentWeek);
      if (changed) {
        totalUpdated += changed;
        const line =
          (hit.favoriteName ? `${hit.favoriteName} -${hit.spread ?? 0}` : "Pick/Even") +
          (hit.overUnder != null ? ` (O/U ${hit.overUnder})` : "");
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, line, hit.provider || ""]);
      } else {
        rows.push([g.id, `${g.home_team} vs ${g.away_team}`, "SKIPPED (guard)", hit.provider || ""]);
      }
      await sleep(15);
    }

    if (rows.length) {
      console.table(rows.map(([id, match, line, source]) => ({ id, match, line, source })));
    }
  }

  console.log("\n=== Odds Summary ===");
  console.log(`Updated rows:   ${totalUpdated}`);
  console.log(`Missing odds:   ${totalMissing}`);
  console.log(`Unmatched teams:${totalUnmatched}`);

  await client.end();

  // Don’t fail CI just for unmatched rows
  // if (totalUnmatched > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
