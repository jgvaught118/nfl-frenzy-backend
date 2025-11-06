// scripts/fetchOdds.js
/* eslint-disable no-console */

/**
 * Fetch odds from The Odds API and populate:
 *  - line_favorite, line_spread, line_over_under, line_source, line_updated_at
 *  - favorite, spread (for current/future games) so frontend (PicksForm) can display odds
 *
 * Usage examples:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/fetchOdds.js
 *     - updates current week only
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/fetchOdds.js --week 10 --minWeek 10
 *     - force only week 10+ (good for late-season)
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/fetchOdds.js --all --maxWeeks 4 --minWeek 10
 *     - current week + next few weeks
 *
 *   ALLOW_PAST=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/fetchOdds.js --week 10
 *     - allow updates even if kickoff <= now (use with care)
 */

const { Client } = require("pg");

/** ---------- Config & CLI ---------- **/

const {
  RW_DB,
  ODDS_API_KEY,
  MIN_WEEK: MIN_WEEK_ENV,
  BOOKMAKERS: BOOKMAKERS_ENV,
  ALLOW_PAST: ALLOW_PAST_ENV,
} = process.env;

if (!RW_DB) {
  console.error("Missing env: RW_DB");
  process.exit(2);
}
if (!ODDS_API_KEY) {
  console.error("Missing env: ODDS_API_KEY (The Odds API key)");
  process.exit(2);
}

// sportsbook priority: first one present wins for that event
const BOOKMAKERS = (BOOKMAKERS_ENV || "caesars,draftkings,fanduel,betmgm")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const args = process.argv.slice(2);
const ARG = (flag) => args.includes(flag);
const getVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const ONLY_WEEK = getVal("--week") ? Number(getVal("--week")) : undefined;
const DO_ALL = ARG("--all");
const MAX_WEEKS = Number(getVal("--maxWeeks") || 3);
const ALLOW_PAST = ARG("--allow-past") || ALLOW_PAST_ENV === "1";
const MIN_WEEK = Number(getVal("--minWeek") || MIN_WEEK_ENV || 0);

/** ---------- Helpers (name matching) ---------- **/

// Keep letters+digits so "49ers" survives
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Normalize many variants to consistent team slugs
function canonicalSlug(raw) {
  let x = slug(raw);

  // City/abbr normalizations
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
    "49ers": "sanfrancisco49ers",
    seahawks: "seattleseahawks",
    buccaneers: "tampabaybuccaneers",
    bucs: "tampabaybuccaneers",
    titans: "tennesseetitans",
    commanders: "washingtoncommanders",
  };

  if (nicknameToCity[x]) return nicknameToCity[x];

  return x;
}

const matchKey = (home, away) =>
  `${canonicalSlug(home)}__${canonicalSlug(away)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ---------- The Odds API snapshot (multi-book) ---------- **/

async function fetchAllOddsSnapshotWithFallback() {
  const base =
    "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds";
  const url = `${base}?regions=us,us2&markets=spreads,totals&oddsFormat=american&dateFormat=iso&apiKey=${encodeURIComponent(
    ODDS_API_KEY
  )}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`The Odds API failed ${res.status} ${txt}`.trim());
  }

  const events = await res.json();
  const count = Array.isArray(events) ? events.length : 0;
  console.log(`Loaded ${count} events from The Odds API.`);
  console.log(`Bookmaker priority: ${BOOKMAKERS.join(" → ")}`);

  const out = new Map();

  for (const ev of events || []) {
    const homeName = ev.home_team;
    const awayName = ev.away_team;
    if (!homeName || !awayName) continue;

    const books = ev.bookmakers || [];
    if (!books.length) continue;

    // choose first preferred book that exists
    const chosen =
      BOOKMAKERS.map((pref) =>
        books.find((b) => {
          const k = (b.key || "").toLowerCase();
          const n = (b.name || "").toLowerCase();
          return k === pref || n.includes(pref);
        })
      ).find(Boolean) || null;

    if (!chosen) continue;

    const provider = chosen.name || chosen.key || "Unknown";
    const spreads = (chosen.markets || []).find((m) => m.key === "spreads");
    const totals = (chosen.markets || []).find((m) => m.key === "totals");

    let favoriteName = null;
    let spread = null;
    let overUnder = null;

    // spreads: two outcomes with team + handicap
    if (spreads?.outcomes?.length >= 2) {
      const [o1, o2] = spreads.outcomes;
      const fav =
        [o1, o2].find(
          (o) => typeof o.point === "number" && Number(o.point) < 0
        ) || null;
      if (fav) {
        favoriteName = fav.name || null;
        spread = Math.abs(Number(fav.point)); // store positive
      } else if (
        [o1, o2].every(
          (o) => typeof o.point === "number" && Number(o.point) === 0
        )
      ) {
        spread = 0; // pick'em
      }
    }

    // totals: Over/Under share same "point"
    if (totals?.outcomes?.length) {
      const over = totals.outcomes.find((o) =>
        /^over$/i.test(o.name || "")
      );
      const under = totals.outcomes.find((o) =>
        /^under$/i.test(o.name || "")
      );
      const pick = over || under || totals.outcomes[0];
      if (pick && typeof pick.point === "number") {
        overUnder = Number(pick.point);
      }
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
      provider,
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
      ADD COLUMN IF NOT EXISTS line_updated_at  timestamptz,
      ADD COLUMN IF NOT EXISTS favorite         text,
      ADD COLUMN IF NOT EXISTS spread           numeric;
  `);
}

async function getCurrentWeek(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(
      MAX(week) FILTER (WHERE kickoff <= now()),
      MIN(week)
    ) AS current_week
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

/**
 * Apply odds to a single game.
 * - Always updates line_* fields (subject to guards).
 * - Also mirrors into favorite/spread so frontend can read them.
 */
async function updateOdds(client, gameId, odds, currentWeek) {
  const guardWeek = ALLOW_PAST ? "" : "AND week >= $6";
  const guardKick = ALLOW_PAST ? "" : "AND kickoff > now()";

  const favorite = odds.favoriteName || null;
  const spread = odds.spread != null ? Number(odds.spread) : null;
  const ou = odds.overUnder != null ? Number(odds.overUnder) : null;
  const src = odds.provider || "Unknown";

  const sql = `
    UPDATE games
       SET line_favorite   = $1,
           line_spread     = $2,
           line_over_under = $3,
           line_source     = $4,
           line_updated_at = now(),
           favorite        = COALESCE($1, favorite),
           spread          = COALESCE($2, spread)
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
  const client = new Client({
    connectionString: RW_DB,
    ssl: { rejectUnauthorized: false }, // Railway
  });

  await client.connect();
  await ensureOddsColumns(client);

  const currentWeek = await getCurrentWeek(client);

  // decide which weeks to target
  let targetWeeks = [];
  if (ONLY_WEEK) {
    targetWeeks = [ONLY_WEEK];
  } else if (DO_ALL) {
    const all = await weeksCurrentAndFuture(client, currentWeek);
    targetWeeks = all.slice(0, Math.max(1, MAX_WEEKS));
  } else {
    targetWeeks = [currentWeek];
  }

  // enforce minWeek guard
  targetWeeks = targetWeeks.filter((w) => w >= MIN_WEEK);

  console.log(
    `\nTarget weeks: ${targetWeeks.join(
      ", "
    )}  (current=${currentWeek}, minWeek=${MIN_WEEK}, allowPast=${
      ALLOW_PAST ? "yes" : "no"
    })`
  );

  // fetch snapshot once
  let snapshot;
  try {
    snapshot = await fetchAllOddsSnapshotWithFallback();
  } catch (e) {
    console.error(`✖ Odds fetch failed: ${e.message}`);
    await client.end();
    process.exit(2);
  }

  let totalUpdated = 0;
  let totalMissing = 0;
  let totalUnmatched = 0;

  for (const w of targetWeeks) {
    console.log(`\n===== ODDS: Week ${w} =====`);
    const games = await dbGamesForWeek(client, w);
    console.log(`→ DB games: ${games.length}`);

    const rows = [];

    for (const g of games) {
      const hit = snapshot.get(matchKey(g.home_team, g.away_team));

      if (!hit) {
        totalUnmatched++;
        rows.push({
          id: g.id,
          match: `${g.home_team} vs ${g.away_team}`,
          line: "UNMATCHED",
          source: "",
        });
        continue;
      }

      if (hit.spread == null && hit.overUnder == null) {
        totalMissing++;
        rows.push({
          id: g.id,
          match: `${g.home_team} vs ${g.away_team}`,
          line: "MISSING",
          source: hit.provider || "",
        });
        continue;
      }

      const changed = await updateOdds(client, g.id, hit, currentWeek);
      if (changed) {
        totalUpdated += changed;
        const line =
          (hit.favoriteName
            ? `${hit.favoriteName} -${hit.spread ?? 0}`
            : "Pick/Even") +
          (hit.overUnder != null ? ` (O/U ${hit.overUnder})` : "");
        rows.push({
          id: g.id,
          match: `${g.home_team} vs ${g.away_team}`,
          line,
          source: hit.provider || "",
        });
      } else {
        rows.push({
          id: g.id,
          match: `${g.home_team} vs ${g.away_team}`,
          line: "SKIPPED (guard: past/started or minWeek)",
          source: hit.provider || "",
        });
      }

      await sleep(15);
    }

    if (rows.length) {
      console.table(rows);
    }
  }

  console.log("\n=== Odds Summary ===");
  console.log(`Updated rows:    ${totalUpdated}`);
  console.log(`Missing odds:    ${totalMissing}`);
  console.log(`Unmatched teams: ${totalUnmatched}`);

  await client.end();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
