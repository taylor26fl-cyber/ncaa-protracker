const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");

function readDB(){ return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); }
function writeDB(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2),"utf8"); }
function id(prefix){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`; }

function getOrCreateTeam(db, name){
  const n = String(name||"").trim();
  let t = db.teams.find(x => x.name === n);
  if(!t){
    const short = n.length <= 6 ? n.toUpperCase() : n.split(" ").slice(0,2).join(" ").toUpperCase();
    t = { id:id("t"), name:n, shortName:short, conference:"" };
    db.teams.push(t);
  }
  return t;
}

function getOrCreateGame(db, season, startTime, homeId, awayId, extId){
  let g = db.games.find(x => x.extSource === "ESPN" && x.extId === String(extId));
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
      extSource: "ESPN",
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

async function syncEspnToday({ season=2026 } = {}){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const ymd = `${y}${m}${day}`;
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${ymd}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error(`ESPN error: ${resp.status}`);
  const json = await resp.json();

  const db = readDB();
  let importedGames = 0;

  for(const ev of (json.events||[])){
    const comp = ev.competitions && ev.competitions[0];
    if(!comp) continue;

    const startTime = comp.date;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === "home");
    const away = competitors.find(c => c.homeAway === "away");
    if(!home || !away) continue;

    const homeName = home.team && home.team.displayName;
    const awayName = away.team && away.team.displayName;
    if(!homeName || !awayName) continue;

    const ht = getOrCreateTeam(db, homeName);
    const at = getOrCreateTeam(db, awayName);

    getOrCreateGame(db, season, startTime, ht.id, at.id, ev.id);
    importedGames++;
  }

  writeDB(db);
  return { ok:true, importedGames };
}

module.exports = { syncEspnToday };
