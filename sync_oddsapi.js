const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}
function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function normTeam(s) {
  return String(s || "").trim();
}
function sameDayUTC(isoA, isoB) {
  const a = new Date(isoA), b = new Date(isoB);
  return a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
}

function getOrCreateTeam(db, name) {
  const n = normTeam(name);
  let t = db.teams.find(x => x.name === n || x.shortName === n);
  if (!t) {
    const short = n.length <= 6 ? n.toUpperCase() : n.split(" ").slice(0,2).join(" ").toUpperCase();
    t = { id: id("t"), name: n, shortName: short, conference: "" };
    db.teams.push(t);
  }
  return t;
}

function getOrCreateGame(db, season, startTime, homeTeamId, awayTeamId, extId) {
  let g = db.games.find(x => x.extSource === "ODDSAPI" && x.extId === extId);
  if (!g) {
    g = {
      id: id("g"),
      season,
      status: "SCHEDULED",
      startTime,
      homeTeamId,
      awayTeamId,
      projSpreadHome: null,
      projTotal: null,
      projWinProbHome: null,
      extSource: "ODDSAPI",
      extId
    };
    db.games.push(g);
  } else {
    // keep ids stable but update time/teams if needed
    g.startTime = startTime;
    g.homeTeamId = homeTeamId;
    g.awayTeamId = awayTeamId;
  }
  return g;
}

function pickHardRockBookmaker(bookmakers) {
  if (!Array.isArray(bookmakers)) return null;
  // Title varies by provider, match loosely:
  return bookmakers.find(b => /hard\s*rock/i.test(b.title || "")) || null;
}

function extractMarket(bookmaker, key) {
  if (!bookmaker || !Array.isArray(bookmaker.markets)) return null;
  return bookmaker.markets.find(m => m.key === key) || null;
}

async function syncHardRockToday({ season = 2026 } = {}) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("Missing ODDS_API_KEY in .env");

  // Odds API: NCAAB
  const url =
    "https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds" +
    `?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Odds API error: ${resp.status} ${await resp.text()}`);

  const events = await resp.json();
  const db = readDB();

  const today = new Date().toISOString();
  let importedGames = 0;
  let importedLines = 0;
  let skippedNoHardRock = 0;

  for (const ev of events) {
    const commence = ev.commence_time;
    if (!commence) continue;

    // Only "today" (UTC day). If you want local day instead, tell me and I’ll switch it.
    if (!sameDayUTC(commence, today)) continue;

    const homeName = ev.home_team;
    const awayName = ev.away_team;
    if (!homeName || !awayName) continue;

    const hr = pickHardRockBookmaker(ev.bookmakers);
    if (!hr) {
      skippedNoHardRock++;
      continue;
    }

    const home = getOrCreateTeam(db, homeName);
    const away = getOrCreateTeam(db, awayName);
    const game = getOrCreateGame(db, season, commence, home.id, away.id, ev.id);

    const spreads = extractMarket(hr, "spreads");
    const totals = extractMarket(hr, "totals");
    const h2h = extractMarket(hr, "h2h");

    // spreads outcome names match teams; totals outcome names are Over/Under
    const spreadHome = spreads?.outcomes?.find(o => o.name === homeName)?.point ?? null;
    const total = totals?.outcomes?.find(o => /over/i.test(o.name))?.point ?? null;

    const mlHome = h2h?.outcomes?.find(o => o.name === homeName)?.price ?? null;
    const mlAway = h2h?.outcomes?.find(o => o.name === awayName)?.price ?? null;

    db.lines.push({
      id: id("l"),
      gameId: game.id,
      sportsbook: "HARDROCK",
      createdAt: new Date().toISOString(),
      spreadHome,
      total,
      mlHome,
      mlAway
    });

    importedGames++;
    importedLines++;
  }

  writeDB(db);

  return { ok: true, importedGames, importedLines, skippedNoHardRock };
}

module.exports = { syncHardRockToday };
