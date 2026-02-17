const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");
const BASE = "https://v1.basketball.api-sports.io";

function readDB(){ return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); }
function writeDB(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2),"utf8"); }
function id(prefix){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`; }

function ymdLocal(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

async function apiGet(pathname, params){
  const key = process.env.APISPORTS_KEY;
  if(!key) throw new Error("Missing APISPORTS_KEY in .env");
  const u = new URL(BASE + pathname);
  Object.entries(params||{}).forEach(([k,v])=>{
    if(v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  });
  const resp = await fetch(u, { headers: { "x-apisports-key": key }});
  if(!resp.ok) throw new Error(`API-SPORTS error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function pickNCAALeagueId(leaguesJson){
  const arr = leaguesJson.response || [];
  // Look for USA NCAA
  const usaNcaa = arr.find(x =>
    x?.country?.name && /usa|united/i.test(x.country.name) &&
    x?.league?.name && /ncaa/i.test(x.league.name)
  );
  if(usaNcaa?.league?.id) return usaNcaa.league.id;

  // fallback: any NCAA
  const anyNcaa = arr.find(x => x?.league?.name && /ncaa/i.test(x.league.name));
  return anyNcaa?.league?.id || null;
}

function getOrCreateTeam(db, name){
  const n = String(name||"").trim();
  let t = db.teams.find(x => x.name === n);
  if(!t){
    const short = n.length<=6 ? n.toUpperCase() : n.split(" ").slice(0,2).join(" ").toUpperCase();
    t = { id:id("t"), name:n, shortName:short, conference:"" };
    db.teams.push(t);
  }
  return t;
}

function getOrCreateGame(db, season, startTime, homeId, awayId, extId){
  let g = db.games.find(x => x.extSource==="APISPORTS" && x.extId===String(extId));
  if(!g){
    g = {
      id: id("g"),
      season,
      status: "SCHEDULED",
      startTime,
      homeTeamId: homeId,
      awayTeamId: awayId,
      projSpreadHome: null,
      projTotal: null,
      projWinProbHome: null,
      extSource: "APISPORTS",
      extId: String(extId)
    };
    db.games.push(g);
  } else {
    g.startTime = startTime;
    g.homeTeamId = homeId;
    g.awayTeamId = awayId;
  }
  return g;
}

async function syncApiSportsToday({ season=2026 } = {}){
  const date = ymdLocal();

  let leagueId = process.env.APISPORTS_NCAA_LEAGUE_ID || null;
  if(!leagueId){
    const leaguesJson = await apiGet("/leagues", {});
    leagueId = pickNCAALeagueId(leaguesJson);
  }
  if(!leagueId) throw new Error("Could not find NCAA league id from API-SPORTS. Run: node -r dotenv/config find_ncaa_league.js");
let gamesJson = await apiGet("/games", { date, league: leagueId, season });
  let games = gamesJson.response || [];

  // Fallbacks (API-SPORTS season values can be "start year", and some endpoints ignore season)
  if (!games.length) {
    gamesJson = await apiGet("/games", { date, league: leagueId });
    games = gamesJson.response || [];
  }
  if (!games.length) {
    gamesJson = await apiGet("/games", { date, league: leagueId, season: season - 1 });
    games = gamesJson.response || [];
  }


  const db = readDB();
  let importedGames = 0;

  for(const g of games){
    const apiId = g?.id;
    const startTime = g?.date;
    const homeName = g?.teams?.home?.name;
    const awayName = g?.teams?.away?.name;
    if(!apiId || !startTime || !homeName || !awayName) continue;

    const ht = getOrCreateTeam(db, homeName);
    const at = getOrCreateTeam(db, awayName);

    getOrCreateGame(db, season, startTime, ht.id, at.id, apiId);
    importedGames++;
  }

  writeDB(db);
  return { ok:true, date, leagueId, importedGames };
}

module.exports = { syncApiSportsToday };
