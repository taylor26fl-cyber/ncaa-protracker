const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { loadTodayPlayersAndHistory, ymdUTC } = require("./auto_players");

const app = express();
app.use(express.json());


app.use(express.static(path.join(__dirname, "public"), { etag:false, lastModified:false }));

const PORT = 3000;
const DB_PATH = path.join(__dirname, "data", "db.json");

function readDB(){ return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); }
function writeDB(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2),"utf8"); }
function impliedProb(odds){ return odds>0 ? 100/(odds+100) : Math.abs(odds)/(Math.abs(odds)+100); }
function edgeSpread(proj, market){ if(proj==null||market==null) return null; return proj-market; }
function edgeTotal(proj, market){ if(proj==null||market==null) return null; return proj-market; }
function edgeML(projProbHome, marketMlHome){ if(projProbHome==null||marketMlHome==null) return null; return projProbHome - impliedProb(marketMlHome); }

function latestLines(db){
  const byGame=new Map();
  for(const l of (db.lines||[])){
    if(l.sportsbook!=="HARDROCK") continue;
    const arr=byGame.get(l.gameId)||[];
    arr.push(l); byGame.set(l.gameId, arr);
  }
  const latest=new Map(), prev=new Map();
  for(const [gid, arr] of byGame.entries()){
    arr.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    if(arr[0]) latest.set(gid, arr[0]);
    if(arr[1]) prev.set(gid, arr[1]);
  }
  return {latest, prev};
}

function ensureDB(){
  if(!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), {recursive:true});
  if(!fs.existsSync(DB_PATH)){
    writeDB({teams:[], games:[], lines:[], bets:[], playerProps:[]});
  } else {
    const db = readDB();
    db.teams ||= []; db.games ||= []; db.lines ||= []; db.bets ||= []; db.playerProps ||= [];
db.playerIndex ||= {}; db.rosters ||= {}; db.playerHistory ||= {};
db.hardrockPropLines ||= [];
    writeDB(db);
  }
}
ensureDB();

/* ---------------- API ---------------- */

app.get("/api/games",(req,res)=>{
app.post("/api/auto/load-today-players", async (req,res)=>{
  try{
    const season = Number((req.body && req.body.season) || 2026);
    const dateISO = (req.body && req.body.dateISO) || null; // optional "YYYY-MM-DD"
    const out = await loadTodayPlayersAndHistory({ dateISO, leagues:["NBA","NCAAB"], maxGames: 80 });
    res.json(out);
  }catch(e){
    res.status(400).json({ ok:false, error: String(e.message||e) });
  }
});

  const db=readDB();
  const teamById=new Map((db.teams||[]).map(t=>[t.id,t]));
  const {latest, prev}=latestLines(db);

  const rows=(db.games||[])
    .slice()
    .sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
    .map(g=>{
      const ll=latest.get(g.id)||null;
      const pl=prev.get(g.id)||null;
      const eS=edgeSpread(g.projSpreadHome, ll?.spreadHome ?? null);
      const eT=edgeTotal(g.projTotal, ll?.total ?? null);
      const eM=edgeML(g.projWinProbHome, ll?.mlHome ?? null);

      return {
        ...g,
        homeTeam: teamById.get(g.homeTeamId),
        awayTeam: teamById.get(g.awayTeamId),
        latestLine: ll,
        prevLine: pl,
        edges: { spread:eS, total:eT, ml:eM }
      };
    });

  res.setHeader("Cache-Control","no-store");
  res.json(rows);
});

app.get("/api/game-picker",(req,res)=>{
  const db=readDB();
  const teamById=new Map((db.teams||[]).map(t=>[t.id,t]));
  const games=(db.games||[]).slice().sort((a,b)=>new Date(a.startTime)-new Date(b.startTime)).map(g=>{
    const home = teamById.get(g.homeTeamId)?.name || g.homeTeamId;
    const away = teamById.get(g.awayTeamId)?.name || g.awayTeamId;
    const t = new Date(g.startTime);
    const hh = String(t.getHours()).padStart(2,"0");
    const mm = String(t.getMinutes()).padStart(2,"0");
    const label = `${g.league || "NCAAB"} ${hh}:${mm}  ${away} @ ${home}`;
    return { id:g.id, league:g.league||"NCAAB", startTime:g.startTime, label, eventId:String(g.extId||"") };
  });
  res.setHeader("Cache-Control","no-store");
  res.json({ok:true, games});
});

/* Player props storage (uses db.playerProps) */
app.get("/api/player-props",(req,res)=>{
  const db=readDB();
  res.setHeader("Cache-Control","no-store");
  res.json(db.playerProps||[]);
});

app.post("/api/player-props/bulk",(req,res)=>{
  try{
    const db=readDB();
    db.playerProps ||= [];
    const arr = Array.isArray(req.body) ? req.body : [];
    const added=[];
    for(const p of arr){
      if(!p || !p.player || !p.stat || p.line==null || !p.type || !p.gameEventId) continue;
      added.push({
        id:`pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`,
        player:String(p.player),
        stat:String(p.stat),
        line:Number(p.line),
        projection:(p.projection==null?null:Number(p.projection)),
        type:String(p.type).toUpperCase(),
        gameEventId:String(p.gameEventId),
        result:"PENDING",
        actual:null
      });
    }
    db.playerProps.push(...added);
    writeDB(db);
    res.json({ok:true, added:added.length});
  }catch(e){
    res.status(400).json({ok:false, error:String(e?.message||e)});
  }
});

/* Hooks into your existing grading endpoint if present in old server.js modules */
let gradePropsFn = null;
try{
  // If you already have these modules from earlier, we can reuse them:
  const grader = require("./auto_grade_props");
  gradePropsFn = grader.gradeAll || grader.run || null;
}catch(e){}

app.post("/api/player-props/grade", async (req,res)=>{
  try{
    if(!gradePropsFn){
      return res.json({ok:false, error:"grader module !found (auto_grade_props.js)."});
    }
    const out = await gradePropsFn();
    res.json({ok:true, ...out});
  }catch(e){
    res.status(400).json({ok:false, error:String(e?.message||e)});
  }
});

/* Players endpoints (reuse your existing ESPN fetch module if present) */
let getPlayersFn = null;
let getNbaPlayersFn = null;
try{ getPlayersFn = require("./espn_players").getPlayers; }catch(e){}
try{ getNbaPlayersFn = require("./espn_nba_players").getNbaPlayers; }catch(e){}

app.get("/api/players/:eventId", async (req,res)=>{
  try{
    if(!getPlayersFn){
      return res.json({ok:false, error:"espn_players module !found"});
    }
    const out = await getPlayersFn(String(req.params.eventId));
    res.setHeader("Cache-Control","no-store");
    res.json(out);
  }catch(e){
    res.status(400).json({ok:false, error:String(e?.message||e)});
  }
});

app.get("/api/nba/game/:eventId/players", async (req,res)=>{
  try{
    if(!getNbaPlayersFn){
      return res.json({ok:false, error:"espn_nba_players module !found"});
    }
    const out = await getNbaPlayersFn(String(req.params.eventId));
    res.setHeader("Cache-Control","no-store");
    res.json(out);
  }catch(e){
    res.status(400).json({ok:false, error:String(e?.message||e)});
  }
});

/* Sync endpoints (reuse your existing modules if present) */
let syncEspnDate = null, syncEspnNbaDate = null;
try{ syncEspnDate = require("./sync_espn_date").syncEspnDate; }catch(e){}
try{ syncEspnNbaDate = require("./sync_espn_nba_date").syncEspnNbaDate; }catch(e){}

app.post("/api/sync/espn-nba-range", async (req,res)=>{
  try{
    if(!syncEspnNbaDate) return res.json({ok:false, error:"sync_espn_nba_date missing"});
    const season=Number(req.body?.season||2026);
    const start=String(req.body?.start||"20260215");
    const end=String(req.body?.end||"20260316");
    const toDate=(x)=>new Date(Number(x.slice(0,4)),Number(x.slice(4,6))-1,Number(x.slice(6,8)));
    const fmt=(d)=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    let d0=toDate(start), d1=toDate(end);
    if(d0>d1)[d0,d1]=[d1,d0];
    let importedTotal=0, days=0;
    for(let d=new Date(d0); d<=d1; d.setDate(d.getDate()+1)){
      const date=fmt(d);
      const out = await syncEspnNbaDate({season,date});
      importedTotal += Number(out.importedGames||0);
      days++;
      await new Promise(r=>setTimeout(r,120));
      if(days>370) break;
    }
    res.json({ok:true, league:"NBA", season, start:fmt(d0), end:fmt(d1), days, importedTotal});
  }catch(e){ res.status(400).json({ok:false, error:String(e?.message||e)}); }
});

app.post("/api/sync/espn-ncaab-range", async (req,res)=>{
  try{
    if(!syncEspnDate) return res.json({ok:false, error:"sync_espn_date missing"});
    const season=Number(req.body?.season||2026);
    const start=String(req.body?.start||"20260215");
    const end=String(req.body?.end||"20260316");
    const toDate=(x)=>new Date(Number(x.slice(0,4)),Number(x.slice(4,6))-1,Number(x.slice(6,8)));
    const fmt=(d)=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    let d0=toDate(start), d1=toDate(end);
    if(d0>d1)[d0,d1]=[d1,d0];
    let importedTotal=0, days=0;
    for(let d=new Date(d0); d<=d1; d.setDate(d.getDate()+1)){
      const date=fmt(d);
      const out = await syncEspnDate({season,date});
      importedTotal += Number(out.importedGames||0);
      days++;
      await new Promise(r=>setTimeout(r,120));
      if(days>370) break;
    }
    res.json({ok:true, league:"NCAAB", season, start:fmt(d0), end:fmt(d1), days, importedTotal});
  }catch(e){ res.status(400).json({ok:false, error:String(e?.message||e)}); }
});

app.post("/api/sync/daily", async (req,res)=>{
  try{
    const season=Number(req.body?.season||2026);
    const daysAhead=Number(req.body?.daysAhead||1);
    const ymd=(d)=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    let imported = { nba:0, ncaab:0 };
    for(let i=0;i<=daysAhead;i++){
      const d=new Date(); d.setDate(d.getDate()+i);
      const date=ymd(d);
      if(syncEspnNbaDate){
        const out = await syncEspnNbaDate({season,date});
        imported.nba += Number(out.importedGames||0);
      }
      if(syncEspnDate){
        const out = await syncEspnDate({season,date});
        imported.ncaab += Number(out.importedGames||0);
      }
    }
    res.json({ok:true, season, daysAhead, imported});
  }catch(e){ res.status(400).json({ok:false, error:String(e?.message||e)}); }
});

/* Serve the SPA */
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/games",(req,res)=>res.redirect("/"));
app.get("/players",(req,res)=>res.redirect("/"));
app.get("/props",(req,res)=>res.redirect("/"));
app.get("/sync",(req,res)=>res.redirect("/"));

/* Daily auto sync loop (lightweight) */
let __lastDate = null;
function yyyymmdd(d=new Date()){
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}
async function maybeDaily(){
  const today=yyyymmdd(new Date());
  if(__lastDate!==today){
    __lastDate=today;
    try{ await fetchLocal("/api/sync/daily",{season:2026,daysAhead:1}); }catch(e){}
  }
}
async function fetchLocal(pathname, body){
  // call local handler directly by invoking functions (no HTTP). We'll just run sync logic inline:
  // simplest: reuse endpoints via direct calls already in maybeDaily above -> call modules directly
  const season=Number(body?.season||2026);
  const daysAhead=Number(body?.daysAhead||1);
  const ymd=(d)=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  for(let i=0;i<=daysAhead;i++){
    const d=new Date(); d.setDate(d.getDate()+i);
    const date=ymd(d);
    if(syncEspnNbaDate) await syncEspnNbaDate({season,date});
    if(syncEspnDate) await syncEspnDate({season,date});
  }
}

app.get("/api/dashboard",(req,res)=>{
  const db = readDB();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  function isToday(iso){
    const t = new Date(iso);
    return t.getUTCFullYear()===y && t.getUTCMonth()===m && t.getUTCDate()===d;
  }

  function within3mo(iso){
    const t = new Date(iso).getTime();
    const end = new Date(Date.UTC(y, m+3, d)).getTime();
    return t >= now.getTime() - 6*60*60*1000 && t <= end;
  }

  const all = (db.games||[]);
  const todayCount = all.filter(g=>isToday(g.startTime) && g.extId).length;
  const rangeCount = all.filter(g=>within3mo(g.startTime) && g.extId).length;

  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, todayCount, rangeCount });
});

/* ===== NBA GLOBAL PLAYERS + GAMELOGS (ProTracker upgrade) ===== */

function dbEnsureBuckets(db){
  db.nbaPlayers ||= {};     // athleteId -> { athleteId, name, team, pos, updatedAt }
  db.nbaGameLogs ||= {};    // athleteId -> [ { eventId, dateISO, opponent, team, line:{PTS,REB,AST,3PT,MIN}, updatedAt } ]
}

function upsertNbaPlayer(db, pl){
  if(!pl || !pl.athleteId) return;
  const id = String(pl.athleteId);
  const prev = db.nbaPlayers[id] || {};
  db.nbaPlayers[id] = {
    athleteId: id,
    name: pl.name || prev.name || "—",
    team: pl.team || prev.team || "",
    pos: pl.pos || prev.pos || "",
    updatedAt: new Date().toISOString()
  };
}

function pushGameLog(db, athleteId, row){
  const id = String(athleteId||"").trim();
  if(!id) return;
  db.nbaGameLogs[id] ||= [];
  const key = (x)=> `${x.eventId}|${x.dateISO}|${(x.team||"")}|${(x.opponent||"")}`;
  const existing = new Map(db.nbaGameLogs[id].map(x=>[key(x), x]));
  existing.set(key(row), row);
  // keep most recent first
  const arr = Array.from(existing.values()).sort((a,b)=> new Date(b.dateISO) - new Date(a.dateISO));
  db.nbaGameLogs[id] = arr.slice(0, 120); // keep last 120 games stored
}

function asNum(x){
  if(x==null) return null;
  const n = Number(String(x).replace(/[^\d.\-]/g,""));
  return Number.isNaN(n) ? null : n;
}

// Pull ESPN NBA summary (boxscore) && extract athlete stat lines
async function espnNbaSummary(eventId){
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`;
  const r = await fetch(url, { headers: { "user-agent":"protracker" } });
  if(!r.ok) throw new Error(`ESPN summary ${r.status}`);
  return await r.json();
}

function extractPlayersFromSummary(summary){
  // We try multiple shapes because ESPN changes sometimes.
  // Goal: [{athleteId,name,team,opp,pos,line:{MIN,PTS,REB,AST,'3PT'}}]
  const out = [];

  const game = summary?.header?.competitions?.[0] || {};
  const comps = game?.competitors || [];
  const home = comps.find(c=>c.homeAway==="home") || {};
  const away = comps.find(c=>c.homeAway==="away") || {};

  const homeName = home?.team?.displayName || home?.team?.name || "Home";
  const awayName = away?.team?.displayName || away?.team?.name || "Away";

  // ESPN usually: summary.boxscore.players = [ {team:{}, statistics:[{athletes:[...]}]} ]
  const playersBlocks = summary?.boxscore?.players || [];

  for(const tb of playersBlocks){
    const teamName = tb?.team?.displayName || tb?.team?.name || "";
    const oppName = (teamName && teamName===homeName) ? awayName : (teamName && teamName===awayName) ? homeName : "";
    const statsGroups = tb?.statistics || [];

    for(const sg of statsGroups){
      // Many times "athletes" already include "stats" array in a fixed order
      const athletes = sg?.athletes || [];
      const labels = sg?.labels || sg?.keys || []; // sometimes labels
      for(const a of athletes){
        const ath = a?.athlete || {};
        const athleteId = ath?.id ? String(ath.id) : null;
        const name = ath?.displayName || ath?.shortName || a?.name || "—";
        const pos = ath?.position?.abbreviation || a?.position || "";
        const stats = a?.stats || a?.statistics || [];

        // Build a label->value map if possible
        const m = {};
        for(let i=0;i<stats.length;i++){
          const k = labels[i] || String(i);
          m[k] = stats[i];
        }

        // Best-effort find common stat fields
        const MIN = (m.MIN ?? m.min ?? m.minutes);
        const PTS = m.PTS ?? m.pts ?? m.points;
        const REB = m.REB ?? m.reb ?? m.rebounds;
        const AST = m.AST ?? m.ast ?? m.assists;

        // 3PT is often "3PT" ?? "3PM-3PA" — we try to parse makes from "3PT" first
        let THREES = m["3PT"] || m["3PM"] || m["3PM-3PA"] || m["3FG"] || null;
        if (THREES && typeof THREES === "string" && THREES.includes("-")) {
          THREES = THREES.split("-")[0]
        // python-ish above won't run; JS below handles it

        let th = m["3PT"] ?? m["3PM"] ?? m["3PM-3PA"] ?? m["3FG"] ?? null;
        if(typeof th === "string" && th.includes("-")) th = th.split("-")[0];

        out.push({
          athleteId,
          name,
          team: teamName,
          opponent: oppName,
          pos,
          line: {
            MIN: MIN ?? null,
            PTS: PTS ?? null,
            REB: REB ?? null,
            AST: AST ?? null,
            "3PT": th ?? null
          }
        });
      }
    }
  }

  // De-dupe by athleteId (keep first)
  const seen = new Set();
  return out.filter(x=>{
    const k = x.athleteId || (x.team + "|" + x.name);
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Backfill endpoint: pulls ESPN summary for NBA games in your DB && stores game logs + player index
app.post("/api/nba/backfill-logs", async (req,res)=>{
  try{
    const body = req.body || {};
    const daysBack = Number(body.daysBack ?? 14);
    const daysAhead = Number(body.daysAhead ?? 1);

    const db = readDB();
    dbEnsureBuckets(db);

    const now = new Date();
    const start = new Date(now); start.setDate(start.getDate() - daysBack);
    const end = new Date(now); end.setDate(end.getDate() + daysAhead);

    const games = (db.games||[])
      .filter(g=> (g.league||"").toUpperCase()==="NBA")
      .filter(g=> g.extId)
      .filter(g=>{
        const t = new Date(g.startTime);
        return t >= start && t <= end;
      })
      .sort((a,b)=> new Date(a.startTime) - new Date(b.startTime));

    let fetched=0, stored=0, errors=0;

    for(const g of games){
      const eventId = String(g.extId);
      try{
        const summary = await espnNbaSummary(eventId);
        const players = extractPlayersFromSummary(summary);

        // dateISO from game startTime
        const dateISO = new Date(g.startTime).toISOString().slice(0,10);

        for(const pl of players){
          if(!pl.athleteId) continue;
          upsertNbaPlayer(db, pl);

          const row = {
            eventId,
            dateISO,
            opponent: pl.opponent || "",
            team: pl.team || "",
            line: {
              MIN: pl.line?.MIN ?? null,
              PTS: pl.line?.PTS ?? null,
              REB: pl.line?.REB ?? null,
              AST: pl.line?.AST ?? null,
              "3PT": pl.line?.["3PT"] ?? null
            },
            updatedAt: new Date().toISOString()
          };
          pushGameLog(db, pl.athleteId, row);
          stored += 1;
        }

        fetched += 1;
      }catch(e){
        errors += 1;
      }
    }

    writeDB(db);
    res.json({ ok:true, gamesConsidered: games.length, fetched, storedRows: stored, errors });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// Global NBA players list
app.get("/api/nba/players",(req,res)=>{
  const q = String(req.query.q||"").trim().toLowerCase();
  const db = readDB();
  dbEnsureBuckets(db);

  let arr = Object.values(db.nbaPlayers||{});
  if(q){
    arr = arr.filter(p=> (p.name||"").toLowerCase().includes(q) || (p.team||"").toLowerCase().includes(q));
  }
  arr.sort((a,b)=> (a.name||"").localeCompare(b.name||""));

  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, count: arr.length, players: arr.slice(0, 5000) });
});

// Player gamelog (last N)
app.get("/api/nba/player/:athleteId/gamelog",(req,res)=>{
  const last = Math.min(120, Math.max(1, Number(req.query.last||20)));
  const db = readDB();
  dbEnsureBuckets(db);

  const id = String(req.params.athleteId);
  const logs = (db.nbaGameLogs[id]||[]).slice(0, last);

  // quick rolling averages
  function avg(stat, n){
    const xs = logs.slice(0,n).map(x=> asNum(x.line?.[stat])).filter(x=>x!=null);
    if(!xs.length) return null;
    return xs.reduce((a,b)=>a+b,0) / xs.length;
  }
  const roll = {
    L5:  { PTS: avg("PTS",5),  REB: avg("REB",5),  AST: avg("AST",5),  "3PT": avg("3PT",5) },
    L10: { PTS: avg("PTS",10), REB: avg("REB",10), AST: avg("AST",10), "3PT": avg("3PT",10) },
    L20: { PTS: avg("PTS",20), REB: avg("REB",20), AST: avg("AST",20), "3PT": avg("3PT",20) }
  };

  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, athleteId:id, logs, roll });
});

/* ===== /NBA GLOBAL PLAYERS + GAMELOGS ===== */
app.get("/api/roster/:eventId", (req,res)=>{
  const db = readDB();
  const r = (db.rosters||{})[String(req.params.eventId)];
  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, eventId:String(req.params.eventId), roster: r || null });
});

app.get("/api/player-history/:athleteId", (req,res)=>{
  const db = readDB();
  const h = (db.playerHistory||{})[String(req.params.athleteId)];
  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, athleteId:String(req.params.athleteId), history: h || null });
});

let __lastAutoPlayersDay = null;
async function __autoPlayersDaily(){
  try{
    const today = ymdUTC(new Date());
    if(__lastAutoPlayersDay === today) return;
    __lastAutoPlayersDay = today;
    // auto-load players/history for today after daily sync has populated games
    await loadTodayPlayersAndHistory({ dateISO: today, leagues:["NBA","NCAAB"], maxGames: 80 });
    console.log("[auto] loaded today players/history:", today);
  }catch(e){
    console.log("[auto] players/history failed:", String(e.message||e));
  }
}
setTimeout(__autoPlayersDaily, 2000);
setInterval(__autoPlayersDaily, 5*60*1000);


/**
 * Hard Rock player prop lines (manual import)
 * Store format:
 * { eventId, league, player, stat, line, overOdds, underOdds, updatedAt }
 */
app.post("/api/hardrock/props/import", (req,res)=>{
  try{
    const arr = req.body
    if(!Array.isArray(arr)) return res.status(400).json({ok:false, error:"Body must be an array"});

    const db = readDB();
    db.hardrockPropLines ||= [];

    let added=0;
    const now = new Date().toISOString();

    // JS-only validation (above block is inert because it's in a JS string)
    const clean = [];
    for(const x of arr){
      const eventId = String(x.eventId||"").trim();
      const player = String(x.player||"").trim();
      const stat   = String(x.stat||"").trim().toUpperCase();
      const line   = Number(x.line);
      if(!eventId || !player || !stat || Number.isNaN(line)) continue;
      clean.push({
        eventId,
        league: x.league ? String(x.league).trim().toUpperCase() : null,
        player,
        stat,
        line,
        overOdds: x.overOdds==null ? null : Number(x.overOdds),
        underOdds: x.underOdds==null ? null : Number(x.underOdds),
        updatedAt: now
      });
    }

    // Replace older entries for same eventId+player+stat with newest
    const key = (r)=>`${r.eventId}|${r.player.toLowerCase()}|${r.stat}`;
    const existing = new Map(db.hardrockPropLines.map(r=>[key(r), r]));
    for(const r of clean){
      existing.set(key(r), r);
    }
    db.hardrockPropLines = Array.from(existing.values());
    writeDB(db);

    added = clean.length;
    res.json({ok:true, added});
  }catch(e){
    res.status(400).json({ok:false, error:String(e.message||e)});
  }
});

app.get("/api/hardrock/props", (req,res)=>{
  const eventId = String(req.query.eventId||"").trim();
  const db = readDB();
  const rows = (db.hardrockPropLines||[]).filter(r=>!eventId || r.eventId===eventId);
  rows.sort((a,b)=> (a.player||"").localeCompare(b.player||"") || (a.stat||"").localeCompare(b.stat||""));
  res.setHeader("Cache-Control","no-store");
  res.json({ok:true, eventId: eventId||null, rows});
});
}


/* ===== START SERVER (must be last) ===== */
app.listen(PORT, "0.0.0.0", () => {
  console.log("ProTracker running at http://127.0.0.1:" + PORT);

  // if you have these functions defined elsewhere, call them safely:
  try { if (typeof maybeDaily === "function") { maybeDaily(); setInterval(maybeDaily, 60_000); } } catch(e){}
  try { if (typeof __autoPlayersDaily === "function") { setTimeout(__autoPlayersDaily, 2000); setInterval(__autoPlayersDaily, 5*60*1000); } } catch(e){}
});

/* ============================================================
   NBA PLAYER STATS TRACKER (SAFE BOTTOM BLOCK)
   ============================================================ */

function __ensureNbaStats(db){
  db.nbaStats ||= {};
  db.nbaProcessedEvents ||= {};
}

function __num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function __ingestNbaEvent(eventId){
  try{
    const r = await fetch(`http://127.0.0.1:${PORT}/api/nba/game/${eventId}/players`);
    const data = await r.json();
    if(!data || !data.ok || !Array.isArray(data.players)) return;

    const db = readDB();
    __ensureNbaStats(db);

    const now = new Date().toISOString();

    for(const p of data.players){
      const line = p.line || {};
      const name = String(p.player||"").toLowerCase().trim();
      if(!name) continue;

      const rec = {
        eventId,
        time: data.startTime || null,
        team: p.team || null,
        PTS: __num(line.PTS ?? line.pts ?? line.points),
        REB: __num(line.REB ?? line.reb ?? line.rebounds),
        AST: __num(line.AST ?? line.ast ?? line.assists),
        THREES: __num(line["3PT"] ?? line.threes),
        MIN: __num(line.MIN ?? line.min),
        updatedAt: now
      };

      db.nbaStats[name] ||= [];

      const arr = db.nbaStats[name];
      const ix = arr.findIndex(x=>x.eventId===eventId);
      if(ix>=0) arr[ix]=rec;
      else arr.push(rec);
    }

    db.nbaProcessedEvents[eventId] = true;
    writeDB(db);
  }catch(e){}
}

/* --- sync today's NBA games into player stats --- */
app.post("/api/nba/stats/sync", async (req,res)=>{
  try{
    const db = readDB();
    __ensureNbaStats(db);

    const today = new Date().toISOString().slice(0,10);

    const games = (db.games||[])
      .filter(g=>g.league==="NBA")
      .filter(g=>g.extId)
      .filter(g=>String(g.startTime||"").slice(0,10)===today);

    for(const g of games){
      await __ingestNbaEvent(String(g.extId));
    }

    res.json({ok:true, games:games.length});
  }catch(e){
    res.status(500).json({ok:false,error:String(e)});
  }
});

/* --- list players with averages --- */
app.get("/api/nba/stats/players",(req,res)=>{
  const db = readDB();
  __ensureNbaStats(db);

  const rows = Object.entries(db.nbaStats||{}).map(([name,games])=>{
    let gp=0, pts=0, reb=0, ast=0, th=0;

    for(const g of games){
      if(g.PTS!=null || g.MIN!=null){
        gp++;
        pts+=g.PTS||0;
        reb+=g.REB||0;
        ast+=g.AST||0;
        th+=g.THREES||0;
      }
    }

    const avg = x=> gp ? x/gp : 0;

    return {
      player:name,
      gp,
      pts:avg(pts),
      reb:avg(reb),
      ast:avg(ast),
      threes:avg(th)
    };
  })
  .sort((a,b)=>b.pts-a.pts)
  .slice(0,500);

  res.json({ok:true,count:rows.length,rows});
});

/* --- single player --- */
app.get("/api/nba/stats/player/:name",(req,res)=>{
  const db = readDB();
  __ensureNbaStats(db);

  const key = String(req.params.name||"").toLowerCase();
  res.json({
    ok:true,
    player:key,
    games: db.nbaStats[key] || []
  });
});


/* ============================================================
   NBA STATS DEBUG + FORCE SYNC (SAFE BOTTOM BLOCK)
   ============================================================ */

app.get("/api/nba/stats/debug/:eventId", async (req,res)=>{
  const eventId = String(req.params.eventId||"").trim();
  const url = `http://127.0.0.1:${PORT}/api/nba/game/${eventId}/players`;

  try{
    const r = await fetch(url);
    const ct = r.headers.get("content-type") || "";
    const text = await r.text();

    let parsed = null;
    let playersLen = null;
    let ok = false;

    try{
      parsed = JSON.parse(text);
      ok = !!parsed?.ok;
      playersLen = Array.isArray(parsed?.players) ? parsed.players.length : null;
    }catch(e){}

    res.setHeader("Cache-Control","no-store");
    res.json({
      ok:true,
      eventId,
      url,
      status:r.status,
      contentType:ct,
      parsedOk: ok,
      playersLen,
      head: text.slice(0,300)
    });
  }catch(e){
    res.status(500).json({ok:false, eventId, error:String(e.message||e)});
  }
});

app.post("/api/nba/stats/sync-force", async (req,res)=>{
  try{
    const db = readDB();
    db.nbaStats ||= {};
    db.nbaProcessedEvents ||= {};

    const body = req.body || {};
    const limit = Number(body.limit || 10);

    const games = (db.games||[])
      .filter(g=>g.league==="NBA" && g.extId)
      .sort((a,b)=> new Date(b.startTime) - new Date(a.startTime))
      .slice(0, limit);

    let attempted = 0, savedPlayers = 0, errors = 0;

    for(const g of games){
      const eventId = String(g.extId);
      attempted++;

      try{
        const r = await fetch(`http://127.0.0.1:${PORT}/api/nba/game/${eventId}/players`);
        const data = await r.json();

        if(!data?.ok || !Array.isArray(data.players)) continue;

        const now = new Date().toISOString();

        for(const p of data.players){
          const line = p.line || {};
          const name = String(p.player||"").toLowerCase().trim();
          if(!name) continue;

          const rec = {
            eventId,
            time: g.startTime || null,
            team: p.team || null,
            PTS: Number.isFinite(Number(line.PTS ?? line.pts ?? line.points)) ? Number(line.PTS ?? line.pts ?? line.points) : null,
            REB: Number.isFinite(Number(line.REB ?? line.reb ?? line.rebounds)) ? Number(line.REB ?? line.reb ?? line.rebounds) : null,
            AST: Number.isFinite(Number(line.AST ?? line.ast ?? line.assists)) ? Number(line.AST ?? line.ast ?? line.assists) : null,
            THREES: Number.isFinite(Number(line["3PT"] ?? line.threes)) ? Number(line["3PT"] ?? line.threes) : null,
            MIN: Number.isFinite(Number(line.MIN ?? line.min)) ? Number(line.MIN ?? line.min) : null,
            updatedAt: now
          };

          db.nbaStats[name] ||= [];
          const arr = db.nbaStats[name];
          const ix = arr.findIndex(x=>x.eventId===eventId);
          if(ix>=0) arr[ix] = rec;
          else arr.push(rec);

          savedPlayers++;
        }

        db.nbaProcessedEvents[eventId] = true;
      }catch(e){
        errors++;
      }
    }

    writeDB(db);
    res.json({ok:true, attempted, savedPlayers, errors, playersInDb:Object.keys(db.nbaStats||{}).length});
  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});


/* ============================================================
   FIX NBA PLAYERS ENDPOINT (remove broken module route, replace
   with ESPN summary fetch)
   ============================================================ */

function __removeRoute(method, path){
  try{
    const stack = app?._router?.stack;
    if(!Array.isArray(stack)) return 0;
    let removed = 0;

    for(let i = stack.length - 1; i >= 0; i--){
      const layer = stack[i];
      if(!layer?.route) continue;
      if(layer.route.path !== path) continue;

      const m = (layer.route.methods||{});
      if(m[method.toLowerCase()]){
        stack.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }catch(e){
    return 0;
  }
}

// Remove the old broken route if it exists
const __rm1 = __removeRoute("get", "/api/nba/game/:eventId/players");

// Replacement: pull players + stats from ESPN "summary" endpoint
app.get("/api/nba/game/:eventId/players", async (req,res)=>{
  const eventId = String(req.params.eventId||"").trim();
  try{
    const url = `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if(!r.ok){
      res.status(502).json({ ok:false, eventId, error:`ESPN fetch failed (${r.status})` });
      return;
    }
    const data = await r.json();

    // ESPN summary usually has boxscore.players -> teams -> statistics -> athletes
    const out = [];
    const playersRoot = data?.boxscore?.players;

    if(Array.isArray(playersRoot)){
      for(const teamBlock of playersRoot){
        const teamName =
          teamBlock?.team?.displayName ||
          teamBlock?.team?.shortDisplayName ||
          teamBlock?.team?.name ||
          "";

        const statsLabels = (teamBlock?.statistics||[]).map(s=>String(s?.name||""));

        // teamBlock.statistics is not the athlete rows; those are inside teamBlock.statistics? No:
        // ESPN uses: teamBlock.statistics (labels) + teamBlock.players (groups like starters/bench)
        const groups = teamBlock?.statistics?.[0]?.athletes ? [{ athletes: teamBlock.statistics[0].athletes }] : teamBlock?.players;

        if(Array.isArray(groups)){
          for(const grp of groups){
            const athletes = grp?.athletes;
            if(!Array.isArray(athletes)) continue;

            for(const a of athletes){
              const name = a?.athlete?.displayName || a?.athlete?.shortName || "";
              const pos  = a?.athlete?.position?.abbreviation || "";
              const starter = !!a?.starter;

              // a.stats is array of strings aligned to labels in grp.statLabels or teamBlock.statistics
              const labels = grp?.statLabels || grp?.labels || teamBlock?.statLabels || statsLabels;
              const vals = Array.isArray(a?.stats) ? a.stats : [];

              const line = {};
              if(Array.isArray(labels) && labels.length){
                for(let i=0;i<labels.length;i++){
                  const k = String(labels[i]||"").toUpperCase().trim();
                  line[k] = (vals[i]===undefined) ? null : vals[i];
                }
              }else{
                // fallback: try common espn order if labels missing
                // typically: MIN, FG, 3PT, FT, OREB, DREB, REB, AST, STL, BLK, TO, PF, +/- , PTS
                const fallback = ["MIN","FG","3PT","FT","OREB","DREB","REB","AST","STL","BLK","TO","PF","+/-","PTS"];
                for(let i=0;i<fallback.length;i++){
                  line[fallback[i]] = (vals[i]===undefined) ? null : vals[i];
                }
              }

              if(name){
                out.push({
                  team: teamName,
                  player: name,
                  pos,
                  starter,
                  statType: grp?.name || grp?.type || "",
                  line
                });
              }
            }
          }
        }
      }
    }

    res.setHeader("Cache-Control","no-store");
    res.json({ ok:true, eventId, removedBrokenRoute: __rm1, players: out });
  }catch(e){
    res.status(500).json({ ok:false, eventId, error:String(e.message||e) });
  }
});

/* ============================================================
   ESPN NBA BOX SCORE FIX v2 (use site.api.espn.com + fallback)
   Paste at bottom to override route again.
   ============================================================ */

function __removeRoute(method, path){
  try{
    const stack = app?._router?.stack;
    if(!Array.isArray(stack)) return 0;
    let removed=0;
    for(let i=stack.length-1;i>=0;i--){
      const layer=stack[i];
      if(!layer?.route) continue;
      if(layer.route.path!==path) continue;
      const m=(layer.route.methods||{});
      if(m[method.toLowerCase()]){
        stack.splice(i,1);
        removed++;
      }
    }
    return removed;
  }catch(e){ return 0; }
}

async function __fetchJson(url){
  const r = await fetch(url, { headers: { "user-agent":"Mozilla/5.0" } });
  const text = await r.text();
  let json = null;
  try{ json = JSON.parse(text); }catch(e){}
  return { ok:r.ok, status:r.status, json, text: text.slice(0,500) };
}

function __parsePlayersFromSummary(data){
  const out = [];
  const playersRoot = data?.boxscore?.players;
  if(!Array.isArray(playersRoot)) return out;

  for(const teamBlock of playersRoot){
    const teamName =
      teamBlock?.team?.displayName ||
      teamBlock?.team?.shortDisplayName ||
      teamBlock?.team?.name || "";

    const groups = teamBlock?.players; // starters/bench groups
    if(!Array.isArray(groups)) continue;

    for(const grp of groups){
      const labels = grp?.statistics?.[0]?.keys
        ? grp.statistics[0].keys.map(k=>String(k||"").toUpperCase())
        : (grp?.statLabels || grp?.labels || []);

      const athletes = grp?.athletes;
      if(!Array.isArray(athletes)) continue;

      for(const a of athletes){
        const name = a?.athlete?.displayName || a?.athlete?.shortName || "";
        const pos  = a?.athlete?.position?.abbreviation || "";
        const starter = !!a?.starter;

        const vals = Array.isArray(a?.stats) ? a.stats : [];
        const line = {};

        if(Array.isArray(labels) && labels.length){
          for(let i=0;i<labels.length;i++){
            line[labels[i]] = (vals[i]===undefined) ? null : vals[i];
          }
        }else{
          // fallback common ordering
          const fb=["MIN","FG","3PT","FT","OREB","DREB","REB","AST","STL","BLK","TO","PF","+/-","PTS"];
          for(let i=0;i<fb.length;i++){
            line[fb[i]]=(vals[i]===undefined)?null:vals[i];
          }
        }

        if(name){
          out.push({
            team: teamName,
            player: name,
            pos,
            starter,
            statType: grp?.name || grp?.type || "",
            line
          });
        }
      }
    }
  }
  return out;
}

function __parsePlayersFromCdnBoxscore(data){
  // cdn format is different; but usually contains "gamepackageJSON.boxscore.players"
  const root =
    data?.gamepackageJSON?.boxscore?.players ||
    data?.boxscore?.players;

  const out = [];
  if(!Array.isArray(root)) return out;

  for(const teamBlock of root){
    const teamName =
      teamBlock?.team?.displayName ||
      teamBlock?.team?.shortDisplayName ||
      teamBlock?.team?.name || "";

    const groups = teamBlock?.statistics?.[0]?.athletes
      ? [{ name:"all", athletes: teamBlock.statistics[0].athletes, statLabels: teamBlock.statistics[0]?.labels }]
      : teamBlock?.players;

    if(!Array.isArray(groups)) continue;

    for(const grp of groups){
      const athletes = grp?.athletes;
      if(!Array.isArray(athletes)) continue;

      const labels = grp?.statLabels || grp?.labels || [];
      for(const a of athletes){
        const name = a?.athlete?.displayName || a?.athlete?.shortName || "";
        const pos  = a?.athlete?.position?.abbreviation || "";
        const starter = !!a?.starter;
        const vals = Array.isArray(a?.stats) ? a.stats : [];
        const line = {};
        if(labels.length){
          for(let i=0;i<labels.length;i++){
            line[String(labels[i]||"").toUpperCase()] = (vals[i]===undefined)?null:vals[i];
          }
        }else{
          const fb=["MIN","FG","3PT","FT","OREB","DREB","REB","AST","STL","BLK","TO","PF","+/-","PTS"];
          for(let i=0;i<fb.length;i++){
            line[fb[i]]=(vals[i]===undefined)?null:vals[i];
          }
        }
        if(name){
          out.push({ team:teamName, player:name, pos, starter, statType: grp?.name||"", line });
        }
      }
    }
  }
  return out;
}

// Remove the prior route and replace
const __rm2 = __removeRoute("get", "/api/nba/game/:eventId/players");

app.get("/api/nba/game/:eventId/players", async (req,res)=>{
  const eventId = String(req.params.eventId||"").trim();
  try{
    // Try “site.api.espn.com” first (this fixes your 404)
    const u1 = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`;
    let r1 = await __fetchJson(u1);
    if(r1.ok && r1.json){
      const players = __parsePlayersFromSummary(r1.json);
      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, eventId, source:"site.api.espn.com", removedPrev: __rm2, playersLen: players.length, players });
      return;
    }

    // Fallback: ESPN CDN boxscore
    const u2 = `https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=${encodeURIComponent(eventId)}`;
    let r2 = await __fetchJson(u2);
    if(r2.ok && r2.json){
      const players = __parsePlayersFromCdnBoxscore(r2.json);
      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, eventId, source:"cdn.espn.com", removedPrev: __rm2, playersLen: players.length, players });
      return;
    }

    // If both fail, return best diagnostics
    res.status(502).json({
      ok:false,
      eventId,
      removedPrev: __rm2,
      error:`ESPN fetch failed (site:${r1.status}, cdn:${r2.status})`,
      siteHead: r1.text,
      cdnHead: r2.text
    });
  }catch(e){
    res.status(500).json({ ok:false, eventId, error:String(e.message||e) });
  }
});

/* ============================================================
   NBA PLAYER STATS STORAGE (boxscore -> per-player game log)
   Paste at bottom of protracker.js
   ============================================================ */

function __ymdUTC(d){
  return d.toISOString().slice(0,10).replace(/-/g,"");
}
function __dateISO(d){
  return d.toISOString().slice(0,10);
}
function __safeNum(x){
  if(x==null) return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}
function __pick(obj, keys){
  for(const k of keys){
    if(obj && obj[k]!=null) return obj[k];
  }
  return null;
}

// store per-player per-game totals (PTS/REB/AST/3PM + MIN if available)
async function __saveNbaGamePlayerStats(eventId){
  const r = await fetch(`http://127.0.0.1:${PORT}/api/nba/game/${encodeURIComponent(eventId)}/players`);
  const j = await r.json();
  if(!j || !j.ok) return { ok:false, eventId, error: j?.error || "players fetch failed" };

  const players = Array.isArray(j.players) ? j.players : [];
  const db = readDB();
  db.nbaPlayerGameLogs ||= [];   // rows: {eventId,dateISO,player,team,MIN,PTS,REB,AST,THREES,updatedAt}

  // figure game date from db.games if possible
  const g = (db.games||[]).find(x=>String(x.extId||"")===String(eventId));
  const dateISO = g?.startTime ? new Date(g.startTime).toISOString().slice(0,10) : __dateISO(new Date());

  const now = new Date().toISOString();
  let added = 0;

  // Build a map to upsert by eventId+player
  const key = (row)=>`${row.eventId}|${row.player.toLowerCase()}`;
  const existing = new Map((db.nbaPlayerGameLogs||[]).map(row=>[key(row), row]));

  for(const p of players){
    const m = p.line || {};

    // ESPN can label 3 pointers as "3PT" like "2-6". We'll parse makes.
    const raw3 = __pick(m, ["3PT","3PM","3P","3PFG","3PTFG"]);
    let threes = null;
    if(typeof raw3 === "string" && raw3.includes("-")){
      threes = __safeNum(raw3.split("-")[0]);
    }else{
      threes = __safeNum(raw3);
    }

    const row = {
      eventId: String(eventId),
      dateISO,
      player: String(p.player||"").trim(),
      team: String(p.team||"").trim(),
      MIN: __pick(m, ["MIN","min","minutes"]),
      PTS: __pick(m, ["PTS","pts","points"]),
      REB: __pick(m, ["REB","reb","rebs","rebounds"]),
      AST: __pick(m, ["AST","ast","assists"]),
      THREES: threes,
      updatedAt: now
    };

    if(!row.player) continue;
    existing.set(key(row), row);
    added++;
  }

  db.nbaPlayerGameLogs = Array.from(existing.values());
  writeDB(db);

  return { ok:true, eventId, dateISO, saved: added };
}

function __removeRoute2(method, path){
  try{
    const stack = app?._router?.stack;
    if(!Array.isArray(stack)) return 0;
    let removed=0;
    for(let i=stack.length-1;i>=0;i--){
      const layer=stack[i];
      if(!layer?.route) continue;
      if(layer.route.path!==path) continue;
      const m=(layer.route.methods||{});
      if(m[method.toLowerCase()]){
        stack.splice(i,1);
        removed++;
      }
    }
    return removed;
  }catch(e){ return 0; }
}

// POST /api/nba/stats/sync-days  { daysBack: 7, limitGames: 50 }
__removeRoute2("post","/api/nba/stats/sync-days");
app.post("/api/nba/stats/sync-days", async (req,res)=>{
  try{
    const daysBack = Number(req.body?.daysBack ?? 7);
    const limitGames = Number(req.body?.limitGames ?? 80);

    const db = readDB();
    const now = new Date();
    const start = new Date(now.getTime() - daysBack*24*60*60*1000);

    // choose NBA games in window with extId
    const games = (db.games||[])
      .filter(g=> (g.league==="NBA") && g.extId && g.startTime)
      .filter(g=>{
        const t = new Date(g.startTime);
        return t >= start && t <= now;
      })
      .sort((a,b)=> new Date(b.startTime) - new Date(a.startTime))
      .slice(0, limitGames);

    let ok=0, fail=0;
    const out = [];
    for(const g of games){
      const r = await __saveNbaGamePlayerStats(String(g.extId));
      if(r.ok){ ok++; } else { fail++; }
      out.push(r);
    }

    res.setHeader("Cache-Control","no-store");
    res.json({ ok:true, window:{ daysBack, limitGames }, games: games.length, okCount: ok, failCount: fail, results: out.slice(0,25) });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// GET /api/nba/stats/players?player=Luka%20Doncic&limit=50
__removeRoute2("get","/api/nba/stats/players");
app.get("/api/nba/stats/players",(req,res)=>{
  const db = readDB();
  const q = String(req.query.player||"").trim().toLowerCase();
  const limit = Number(req.query.limit ?? 80);

  const rows = (db.nbaPlayerGameLogs||[])
    .filter(r=> !q || String(r.player||"").toLowerCase().includes(q))
    .sort((a,b)=> (b.dateISO||"").localeCompare(a.dateISO||""));

  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, count: rows.length, rows: rows.slice(0,limit) });
});

/* =======================
   PATCH: NBA stats parser v2 (fix saved:0)
   Paste at bottom of protracker.js
   ======================= */

function __removeRoute3(method, path){
  try{
    const stack = app?._router?.stack;
    if(!Array.isArray(stack)) return 0;
    let removed=0;
    for(let i=stack.length-1;i>=0;i--){
      const layer=stack[i];
      if(!layer?.route) continue;
      if(layer.route.path!==path) continue;
      const m=(layer.route.methods||{});
      if(m[method.toLowerCase()]){
        stack.splice(i,1);
        removed++;
      }
    }
    return removed;
  }catch(e){ return 0; }
}

function __pick2(obj, keys){
  for(const k of keys){
    if(obj && obj[k]!=null) return obj[k];
  }
  return null;
}

function __getPlayerName(p){
  // supports many ESPN shapes
  return (
    p?.player ||
    p?.name ||
    p?.displayName ||
    p?.athlete?.displayName ||
    p?.athlete?.fullName ||
    p?.athlete?.shortName ||
    p?.athlete?.name ||
    ""
  ).toString().trim();
}

function __getTeamName(p){
  return (
    p?.team ||
    p?.teamName ||
    p?.team?.displayName ||
    p?.team?.name ||
    p?.team?.abbreviation ||
    ""
  ).toString().trim();
}

function __extractPlayersArray(j){
  if(!j) return [];
  // common shapes:
  if(Array.isArray(j.players)) return j.players;
  if(Array.isArray(j.response)) return j.response;
  if(Array.isArray(j.data?.players)) return j.data.players;
  if(Array.isArray(j.game?.players)) return j.game.players;

  // ESPN boxscore style sometimes: teams[].athletes[]
  const teams = j.teams || j.game?.teams || j.boxscore?.teams || j.data?.teams;
  if(Array.isArray(teams)){
    const out = [];
    for(const t of teams){
      const athletes = t?.athletes || t?.players || t?.roster || t?.team?.athletes;
      if(Array.isArray(athletes)){
        for(const a of athletes){
          // normalize to look like what we expect
          out.push({
            player: a?.athlete?.displayName || a?.displayName || a?.name,
            team: t?.team?.displayName || t?.team?.name || t?.displayName || t?.name,
            line: a?.stats || a?.stat || a?.boxscore || a?.line
          });
        }
      }
    }
    return out;
  }

  return [];
}

async function __saveNbaGamePlayerStats(eventId){
  const r = await fetch(`http://127.0.0.1:${PORT}/api/nba/game/${encodeURIComponent(eventId)}/players`);
  const j = await r.json();

  // if your endpoint returns ok:false, bail
  if(!j || j.ok === false){
    return { ok:false, eventId, error: j?.error || "players fetch failed" };
  }

  const players = __extractPlayersArray(j);
  const db = readDB();
  db.nbaPlayerGameLogs ||= []; // {eventId,dateISO,player,team,MIN,PTS,REB,AST,THREES,updatedAt}

  const g = (db.games||[]).find(x=>String(x.extId||"")===String(eventId));
  const dateISO = g?.startTime ? new Date(g.startTime).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);

  const now = new Date().toISOString();

  const key = (row)=>`${row.eventId}|${row.player.toLowerCase()}`;
  const existing = new Map((db.nbaPlayerGameLogs||[]).map(row=>[key(row), row]));

  let added = 0;

  for(const p of players){
    const name = __getPlayerName(p);
    if(!name) continue;

    const m = p.line || p.stats || p.statLine || p.box || {};

    // handle 3PT like "2-6" => makes=2
    const raw3 = __pick2(m, ["3PT","3PM","3P","3PFG","3PTFG","threes"]);
    let threes = null;
    if(typeof raw3 === "string" && raw3.includes("-")){
      const makes = Number(raw3.split("-")[0]);
      threes = Number.isNaN(makes) ? null : makes;
    }else{
      const n = Number(raw3);
      threes = Number.isNaN(n) ? null : n;
    }

    const row = {
      eventId: String(eventId),
      dateISO,
      player: name,
      team: __getTeamName(p),
      MIN: __pick2(m, ["MIN","min","minutes"]),
      PTS: __pick2(m, ["PTS","pts","points"]),
      REB: __pick2(m, ["REB","reb","rebs","rebounds"]),
      AST: __pick2(m, ["AST","ast","assists"]),
      THREES: threes,
      updatedAt: now
    };

    existing.set(key(row), row);
    added++;
  }

  db.nbaPlayerGameLogs = Array.from(existing.values());
  writeDB(db);

  return { ok:true, eventId, dateISO, playersSeen: players.length, saved: added };
}

// Replace endpoints so they use the new parser
__removeRoute3("post","/api/nba/stats/sync-days");
app.post("/api/nba/stats/sync-days", async (req,res)=>{
  try{
    const daysBack = Number(req.body?.daysBack ?? 7);
    const limitGames = Number(req.body?.limitGames ?? 80);

    const db = readDB();
    const now = new Date();
    const start = new Date(now.getTime() - daysBack*24*60*60*1000);

    const games = (db.games||[])
      .filter(g=> (g.league==="NBA") && g.extId && g.startTime)
      .filter(g=>{
        const t = new Date(g.startTime);
        return t >= start && t <= now;
      })
      .sort((a,b)=> new Date(b.startTime) - new Date(a.startTime))
      .slice(0, limitGames);

    let ok=0, fail=0;
    const results = [];
    for(const g of games){
      const rr = await __saveNbaGamePlayerStats(String(g.extId));
      if(rr.ok) ok++; else fail++;
      results.push(rr);
    }

    res.setHeader("Cache-Control","no-store");
    res.json({ ok:true, window:{ daysBack, limitGames }, games: games.length, okCount: ok, failCount: fail, results: results.slice(0,25) });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// Quick debug: show shape + first player keys
__removeRoute3("get","/api/nba/stats/debug2/:eventId");
app.get("/api/nba/stats/debug2/:eventId", async (req,res)=>{
  try{
    const eventId = String(req.params.eventId);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/nba/game/${encodeURIComponent(eventId)}/players`);
    const j = await r.json();
    const players = __extractPlayersArray(j);
    const first = players[0] || null;
    res.json({
      ok:true,
      eventId,
      topKeys: j ? Object.keys(j).slice(0,30) : [],
      playersLen: players.length,
      firstPlayerKeys: first ? Object.keys(first).slice(0,30) : [],
      firstPlayer: first
    });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

/* =======================
   PATCH: ESPN NBA players/boxscore via SUMMARY
   Paste at bottom of protracker.js
   ======================= */

function __removeRoute3(method, path){
  try{
    const stack = app?._router?.stack;
    if(!Array.isArray(stack)) return 0;
    let removed=0;
    for(let i=stack.length-1;i>=0;i--){
      const layer=stack[i];
      if(!layer?.route) continue;
      if(layer.route.path!==path) continue;
      const m=(layer.route.methods||{});
      if(m[method.toLowerCase()]){
        stack.splice(i,1);
        removed++;
      }
    }
    return removed;
  }catch(e){ return 0; }
}

async function __fetchJsonTry(urls){
  const headers = {
    "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "accept": "application/json,text/plain,*/*"
  };
  let lastErr = null;
  for(const url of urls){
    try{
      const r = await fetch(url, { headers });
      if(!r.ok){
        lastErr = new Error(`HTTP ${r.status} from ${url}`);
        continue;
      }
      const ct = (r.headers.get("content-type")||"").toLowerCase();
      const txt = await r.text();
      // ESPN sometimes returns HTML blocks on errors
      if(txt.trim().startsWith("<!doctype") || txt.trim().startsWith("<html")){
        lastErr = new Error(`HTML response from ${url}`);
        continue;
      }
      const j = JSON.parse(txt);
      return { ok:true, url, json:j };
    }catch(e){
      lastErr = e;
    }
  }
  return { ok:false, error: String(lastErr?.message || lastErr || "fetch failed") };
}

function __parseEspnSummaryPlayers(summaryJson){
  const playersOut = [];

  // ESPN summary commonly: boxscore.players -> [ {team, statistics:[{name, labels, athletes:[...]} ] } ]
  const box = summaryJson?.boxscore;
  const teams = box?.players;
  if(!Array.isArray(teams)) return playersOut;

  for(const t of teams){
    const teamName =
      t?.team?.displayName ||
      t?.team?.name ||
      t?.team?.abbreviation ||
      t?.displayName ||
      "Team";

    const statsGroups = t?.statistics;
    if(!Array.isArray(statsGroups)) continue;

    for(const grp of statsGroups){
      const labels = Array.isArray(grp?.labels) ? grp.labels : [];
      const athletes = Array.isArray(grp?.athletes) ? grp.athletes : [];
      for(const a of athletes){
        const athlete = a?.athlete || {};
        const name = athlete?.displayName || athlete?.fullName || athlete?.shortName;
        if(!name) continue;

        const vals = Array.isArray(a?.stats) ? a.stats : [];
        const line = {};
        for(let i=0;i<labels.length && i<vals.length;i++){
          line[String(labels[i])] = vals[i];
        }

        // normalize a few keys people care about (if present)
        // (we keep original line too)
        playersOut.push({
          team: teamName,
          player: String(name),
          pos: a?.position?.abbreviation || a?.position || "",
          starter: !!a?.starter,
          statType: grp?.name || "",
          line
        });
      }
    }
  }

  return playersOut;
}

// Override the NBA players endpoint
__removeRoute3("get", "/api/nba/game/:eventId/players");
app.get("/api/nba/game/:eventId/players", async (req,res)=>{
  try{
    const eventId = String(req.params.eventId);

    const urls = [
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`,
      `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`
    ];

    const got = await __fetchJsonTry(urls);
    if(!got.ok){
      return res.status(502).json({ ok:false, eventId, error:`ESPN fetch failed (${got.error})` });
    }

    const players = __parseEspnSummaryPlayers(got.json);

    res.setHeader("Cache-Control","no-store");
    res.json({
      ok:true,
      eventId,
      source: got.url,
      playersLen: players.length,
      players
    });
  }catch(e){
    res.status(500).json({ ok:false, eventId:String(req.params.eventId), error:String(e.message||e) });
  }
});

/* ===== PLAYER ROLLING AVERAGES (PROTRACKER CORE) ===== */

app.get("/api/nba/stats/rolling", (req,res)=>{
  const db = readDB();
  const limit = Number(req.query.games || 5);

  const rows = db.nbaPlayerStats || [];
  const map = new Map();

  for(const r of rows){
    const key = r.player;
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }

  const out = [];

  for(const [player, games] of map.entries()){
    games.sort((a,b)=> new Date(b.dateISO) - new Date(a.dateISO));

    const last = games.slice(0, limit);

    const avg = (k)=>{
      const vals = last.map(x=>Number(x[k]||0));
      if(!vals.length) return 0;
      return vals.reduce((a,b)=>a+b,0)/vals.length;
    };

    out.push({
      player,
      games: last.length,
      avgPTS: avg("PTS"),
      avgREB: avg("REB"),
      avgAST: avg("AST"),
      avg3PT: avg("THREES")
    });
  }

  out.sort((a,b)=> b.avgPTS - a.avgPTS);

  res.json({ ok:true, count:out.length, rows:out });
});


/* ===== PATCH: rolling stats from saved NBA player rows (works with your 875 rows) =====
   Usage:
     /api/nba/stats/rolling?games=5                 -> leaders (top 25 by avg PTS)
     /api/nba/stats/rolling?player=Luka%20Doncic&games=5  -> last N + averages for that player
*/
function __ptNum(v){
  if (v == null) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "string"){
    const s = v.trim();
    if (!s) return null;
    // handle "3-8" style strings if they ever appear
    if (s.includes("-")) {
      const a = s.split("-")[0];
      const n = Number(a);
      return Number.isNaN(n) ? null : n;
    }
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function __ptPickStatsBucket(db){
  // try common names (your /api/nba/stats/players is already reading one of these)
  return db.nbaPlayerStats
      || db.nbaStats
      || db.nbaGamePlayerStats
      || db.playerStatsNBA
      || [];
}

app.get("/api/nba/stats/rolling", (req,res)=>{
  const db = readDB();
  const rows = __ptPickStatsBucket(db);

  const games = Math.max(1, Math.min(50, Number(req.query.games || 5)));
  const playerQ = String(req.query.player || "").trim().toLowerCase();

  // normalize + sort newest first by dateISO then eventId
  const sorted = (rows||[]).slice().sort((a,b)=>{
    const da = String(a.dateISO||"");
    const dbb = String(b.dateISO||"");
    if (da !== dbb) return dbb.localeCompare(da); // desc
    return String(b.eventId||"").localeCompare(String(a.eventId||""));
  });

  function agg(list){
    const take = list.slice(0, games);
    let g=0, pts=0, reb=0, ast=0, th=0, min=0;
    for(const r of take){
      const PTS = __ptNum(r.PTS ?? r.pts ?? r.points);
      const REB = __ptNum(r.REB ?? r.reb ?? r.rebounds);
      const AST = __ptNum(r.AST ?? r.ast ?? r.assists);
      const THR = __ptNum(r.THREES ?? r.threes ?? r["3PT"] ?? r["3pt"]);
      const MIN = __ptNum(r.MIN ?? r.min ?? r.minutes);

      // count a game if it has at least one stat
      if (PTS==null && REB==null && AST==null && THR==null && MIN==null) continue;
      g++;
      pts += (PTS ?? 0);
      reb += (REB ?? 0);
      ast += (AST ?? 0);
      th  += (THR ?? 0);
      min += (MIN ?? 0);
    }
    const avg = (x)=> g ? (x/g) : null;
    return {
      gamesUsed: g,
      avgPTS: avg(pts),
      avgREB: avg(reb),
      avgAST: avg(ast),
      avgTHREES: avg(th),
      avgMIN: avg(min),
      totals: { PTS: pts, REB: reb, AST: ast, THREES: th, MIN: min },
      lastGames: take.slice(0, games).map(r=>({
        dateISO: r.dateISO,
        eventId: r.eventId,
        team: r.team,
        player: r.player,
        MIN: r.MIN,
        PTS: r.PTS,
        REB: r.REB,
        AST: r.AST,
        THREES: r.THREES
      }))
    };
  }

  // If player= provided -> return that player's rolling
  if(playerQ){
    const list = sorted.filter(r=> String(r.player||"").toLowerCase() === playerQ);
    const out = agg(list);
    res.setHeader("Cache-Control","no-store");
    return res.json({ ok:true, mode:"player", player:req.query.player, games, count: out.gamesUsed, row: out });
  }

  // No player -> leaders: group by player name and compute avg PTS over last N games
  const byPlayer = new Map();
  for(const r of sorted){
    const name = String(r.player||"").trim();
    if(!name) continue;
    if(!byPlayer.has(name)) byPlayer.set(name, []);
    byPlayer.get(name).push(r);
  }

  const leaders = [];
  for(const [name, list] of byPlayer.entries()){
    const out = agg(list);
    // require at least 2 games (avoid 1-off noise)
    if(out.gamesUsed < Math.min(2, games)) continue;
    leaders.push({
      player: name,
      gamesUsed: out.gamesUsed,
      avgPTS: out.avgPTS,
      avgREB: out.avgREB,
      avgAST: out.avgAST,
      avgTHREES: out.avgTHREES,
      avgMIN: out.avgMIN
    });
  }

  leaders.sort((a,b)=> (b.avgPTS||0) - (a.avgPTS||0));
  const top = leaders.slice(0, 25);

  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, mode:"leaders", games, count: top.length, rows: top });
});
/* ===== END PATCH ===== */


/* ===== NBA ROLLING AVERAGES (SAFE ADD-ON) ===== */
app.get("/api/nba/stats/rolling2", (req,res)=>{
  try{
    const db = readDB();

    // find where stats are stored (your build changed names a few times)
    let all =
      db.nbaPlayerStats ||
      db.nbaStatsPlayers ||
      db.nbaStats ||
      db.playerStats ||
      [];

    if(!Array.isArray(all)) all = [];

    const gamesN = Math.max(1, Math.min(20, Number(req.query.games||5)));
    const q = String(req.query.player||"").toLowerCase();

    let rows = all.filter(r =>
      r && r.player && r.dateISO && r.eventId
    );

    if(q){
      rows = rows.filter(r =>
        String(r.player).toLowerCase().includes(q)
      );
    }

    // newest first
    rows.sort((a,b)=>{
      if(a.dateISO !== b.dateISO)
        return a.dateISO < b.dateISO ? 1 : -1;
      return String(a.eventId) < String(b.eventId) ? 1 : -1;
    });

    const byPlayer = new Map();

    for(const r of rows){
      if(!byPlayer.has(r.player))
        byPlayer.set(r.player, []);

      const arr = byPlayer.get(r.player);

      // prevent duplicate same game
      if(arr.some(x=>x.eventId===r.eventId)) continue;

      arr.push(r);
    }

    function num(v){
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    const out=[];

    for(const [player,arr] of byPlayer.entries()){
      const take = arr.slice(0,gamesN);
      if(!take.length) continue;

      let sMIN=0,sPTS=0,sREB=0,sAST=0,s3=0;
      let cMIN=0,cPTS=0,cREB=0,cAST=0,c3=0;

      for(const g of take){
        const MIN=num(g.MIN);
        const PTS=num(g.PTS);
        const REB=num(g.REB);
        const AST=num(g.AST);

        let TH=g.THREES ?? g["3PT"];
        if(typeof TH==="string" && TH.includes("-"))
          TH=TH.split("-")[0];
        const THREES=num(TH);

        if(MIN!=null){sMIN+=MIN;cMIN++;}
        if(PTS!=null){sPTS+=PTS;cPTS++;}
        if(REB!=null){sREB+=REB;cREB++;}
        if(AST!=null){sAST+=AST;cAST++;}
        if(THREES!=null){s3+=THREES;c3++;}
      }

      const last=take[0];

      out.push({
        player,
        team:last.team||null,
        games:take.length,
        avgMIN:cMIN?(sMIN/cMIN).toFixed(2):null,
        avgPTS:cPTS?(sPTS/cPTS).toFixed(2):null,
        avgREB:cREB?(sREB/cREB).toFixed(2):null,
        avgAST:cAST?(sAST/cAST).toFixed(2):null,
        avg3PT:c3?(s3/c3).toFixed(2):null
      });
    }

    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,count:out.length,rows:out});

  }catch(e){
    res.json({ok:false,error:String(e.message||e)});
  }
});


/* ===== NBA ROLLING AVERAGES (AUTO-DETECT DB TABLE) ===== */
function __findStatsRows(db){
  // 1) Look for arrays at top-level
  for(const [k,v] of Object.entries(db||{})){
    if(Array.isArray(v) && v.length){
      const x = v[0];
      if(x && typeof x === "object" && ("player" in x) && ("eventId" in x) && ("dateISO" in x)){
        return v;
      }
    }
  }

  // 2) Look 1-level deep (objects containing arrays)
  for(const [k,v] of Object.entries(db||{})){
    if(v && typeof v === "object" && !Array.isArray(v)){
      for(const [k2,v2] of Object.entries(v)){
        if(Array.isArray(v2) && v2.length){
          const x = v2[0];
          if(x && typeof x === "object" && ("player" in x) && ("eventId" in x) && ("dateISO" in x)){
            return v2;
          }
        }
      }
    }
  }

  return [];
}

app.get("/api/nba/stats/rolling3", (req,res)=>{
  try{
    const db = readDB();
    const all = __findStatsRows(db);

    const gamesN = Math.max(1, Math.min(20, Number(req.query.games||5)));
    const q = String(req.query.player||"").toLowerCase().trim();

    let rows = Array.isArray(all) ? all.slice() : [];
    rows = rows.filter(r => r && r.player && r.eventId && r.dateISO);

    if(q){
      rows = rows.filter(r => String(r.player).toLowerCase().includes(q));
    }

    // newest first (dateISO desc, eventId desc)
    rows.sort((a,b)=>{
      if(a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? 1 : -1;
      return String(a.eventId) < String(b.eventId) ? 1 : -1;
    });

    const byPlayer = new Map();
    for(const r of rows){
      const name = String(r.player);
      if(!byPlayer.has(name)) byPlayer.set(name, []);
      const arr = byPlayer.get(name);
      if(arr.some(x=>String(x.eventId)===String(r.eventId))) continue; // avoid duplicates per game
      arr.push(r);
    }

    function num(v){
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    const out = [];
    for(const [player, arr] of byPlayer.entries()){
      const take = arr.slice(0, gamesN);
      if(!take.length) continue;

      let sMIN=0,sPTS=0,sREB=0,sAST=0,s3=0;
      let cMIN=0,cPTS=0,cREB=0,cAST=0,c3=0;

      for(const g of take){
        const MIN=num(g.MIN);
        const PTS=num(g.PTS);
        const REB=num(g.REB);
        const AST=num(g.AST);

        let TH = (g.THREES ?? g["3PT"]);
        if(typeof TH==="string" && TH.includes("-")) TH = TH.split("-")[0];
        const THREES = num(TH);

        if(MIN!=null){sMIN+=MIN;cMIN++;}
        if(PTS!=null){sPTS+=PTS;cPTS++;}
        if(REB!=null){sREB+=REB;cREB++;}
        if(AST!=null){sAST+=AST;cAST++;}
        if(THREES!=null){s3+=THREES;c3++;}
      }

      const last = take[0];

      out.push({
        player,
        team: last.team || null,
        games: take.length,
        avgMIN: cMIN ? (sMIN/cMIN).toFixed(2) : null,
        avgPTS: cPTS ? (sPTS/cPTS).toFixed(2) : null,
        avgREB: cREB ? (sREB/cREB).toFixed(2) : null,
        avgAST: cAST ? (sAST/cAST).toFixed(2) : null,
        avg3PT: c3 ? (s3/c3).toFixed(2) : null
      });
    }

    res.setHeader("Cache-Control","no-store");
    res.json({ok:true, count: out.length, rows: out});
  }catch(e){
    res.status(500).json({ok:false, error:String(e.message||e)});
  }
});


/* ===== COMPAT: rolling2 -> rolling3 ===== */
app.get("/api/nba/stats/rolling2", (req,res)=>{
  // Redirect internally by calling the same handler logic via HTTP-free copy:
  // simplest: just respond with the same output as rolling3 by reusing query params.
  req.url = "/api/nba/stats/rolling3" + (req._parsedUrl?.search || "");
  // If your express doesn't like rewriting req.url, just do a normal redirect:
  return res.redirect(302, "/api/nba/stats/rolling3" + (req._parsedUrl?.search || ""));
});


/* ===== FORCE OVERRIDE: /api/nba/stats/rolling2 (remove old + replace) ===== */
(function fixRolling2(){
  try{
    // 1) Remove any earlier /api/nba/stats/rolling2 GET handlers (first-match wins in Express)
    const stack = app?._router?.stack;
    if(Array.isArray(stack)){
      for(let i=stack.length-1;i>=0;i--){
        const layer = stack[i];
        if(layer?.route?.path === "/api/nba/stats/rolling2" && layer?.route?.methods?.get){
          stack.splice(i,1);
        }
      }
    }

    // 2) Add the correct rolling2 route (same idea as rolling3)
    app.get("/api/nba/stats/rolling2", (req,res)=>{
      const db = readDB();

      // pick whichever array exists (your app has one of these)
      const rows =
        (db.nbaPlayerStats) ||
        (db.nbaStatsPlayers) ||
        (db.nbaStats) ||
        (db.nbaPlayerGameLogs) ||
        [];

      const games = Math.max(1, Math.min(50, Number(req.query.games || 5)));
      const playerQ = String(req.query.player || "").trim().toLowerCase();

      // normalize numbers
      const n = (v)=>{
        if(v==null) return 0;
        const s = String(v).trim();
        if(!s) return 0;
        const x = Number(s);
        return Number.isFinite(x) ? x : 0;
      };

      // filter + sort newest-first by dateISO then eventId
      const filtered = rows
        .filter(r=>{
          if(!playerQ) return true;
          return String(r.player||"").toLowerCase().includes(playerQ);
        })
        .slice()
        .sort((a,b)=>{
          const da = String(a.dateISO||"");
          const dbb = String(b.dateISO||"");
          if(da !== dbb) return da < dbb ? 1 : -1;
          const ea = String(a.eventId||"");
          const eb = String(b.eventId||"");
          return ea < eb ? 1 : ea > eb ? -1 : 0;
        });

      // take last N per player
      const buckets = new Map(); // key player|team -> array
      for(const r of filtered){
        const key = `${r.player||""}|||${r.team||""}`;
        if(!buckets.has(key)) buckets.set(key, []);
        const arr = buckets.get(key);
        if(arr.length < games) arr.push(r);
      }

      // compute averages
      const out = [];
      for(const [key, arr] of buckets.entries()){
        const [player, team] = key.split("|||");
        const g = arr.length;
        let min=0, pts=0, reb=0, ast=0, th=0;

        for(const r of arr){
          min += n(r.MIN ?? r.min ?? r.minutes);
          pts += n(r.PTS ?? r.pts ?? r.points);
          reb += n(r.REB ?? r.reb ?? r.rebounds);
          ast += n(r.AST ?? r.ast ?? r.assists);
          th  += n(r.THREES ?? r["3PT"] ?? r.threes ?? r.threePointers);
        }

        const f2 = (x)=> (g ? (x/g).toFixed(2) : "0.00");
        out.push({
          player,
          team,
          games: g,
          avgMIN: f2(min),
          avgPTS: f2(pts),
          avgREB: f2(reb),
          avgAST: f2(ast),
          avg3PT: f2(th),
        });
      }

      // if player query is provided, keep best match first
      out.sort((a,b)=> (b.games - a.games) || String(a.player).localeCompare(String(b.player)));

      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, count: out.length, rows: out });
    });

    console.log("[patch] rolling2 overridden ✅");
  }catch(e){
    console.log("[patch] rolling2 override failed:", String(e?.message||e));
  }
})();


/* ===== FIX OVERRIDE: /api/nba/stats/rolling2 (rows may be {count,rows} or object) ===== */
(function fixRolling2_v2(){
  try{
    // Remove any earlier /api/nba/stats/rolling2 GET handlers
    const stack = app?._router?.stack;
    if(Array.isArray(stack)){
      for(let i=stack.length-1;i>=0;i--){
        const layer = stack[i];
        if(layer?.route?.path === "/api/nba/stats/rolling2" && layer?.route?.methods?.get){
          stack.splice(i,1);
        }
      }
    }

    function asArray(x){
      if(!x) return [];
      if(Array.isArray(x)) return x;
      // common: { ok:true, count:..., rows:[...] }
      if(Array.isArray(x.rows)) return x.rows;
      // sometimes stored under "data"
      if(Array.isArray(x.data)) return x.data;
      // sometimes a map/object of id -> row
      if(typeof x === "object") return Object.values(x);
      return [];
    }

    app.get("/api/nba/stats/rolling2", (req,res)=>{
      const db = readDB();

      // try the likely buckets in your DB
      const raw =
        db.nbaStatsPlayers ??
        db.nbaPlayerStats ??
        db.nbaPlayerGameLogs ??
        db.nbaStats ??
        db.statsPlayers ??
        db.playerStats ??
        null;

      const rows = asArray(raw);

      const games = Math.max(1, Math.min(50, Number(req.query.games || 5)));
      const playerQ = String(req.query.player || "").trim().toLowerCase();

      const n = (v)=>{
        if(v==null) return 0;
        const s = String(v).trim();
        if(!s) return 0;
        const x = Number(s);
        return Number.isFinite(x) ? x : 0;
      };

      const filtered = rows
        .filter(r=>{
          if(!playerQ) return true;
          return String(r.player||"").toLowerCase().includes(playerQ);
        })
        .slice()
        .sort((a,b)=>{
          const da = String(a.dateISO||"");
          const dbb = String(b.dateISO||"");
          if(da !== dbb) return da < dbb ? 1 : -1;
          const ea = String(a.eventId||"");
          const eb = String(b.eventId||"");
          return ea < eb ? 1 : ea > eb ? -1 : 0;
        });

      const buckets = new Map(); // player|team -> last N games
      for(const r of filtered){
        const key = `${r.player||""}|||${r.team||""}`;
        if(!buckets.has(key)) buckets.set(key, []);
        const arr = buckets.get(key);
        if(arr.length < games) arr.push(r);
      }

      const out = [];
      for(const [key, arr] of buckets.entries()){
        const [player, team] = key.split("|||");
        const g = arr.length;

        let min=0, pts=0, reb=0, ast=0, th=0;

        for(const r of arr){
          min += n(r.MIN ?? r.min ?? r.minutes);
          pts += n(r.PTS ?? r.pts ?? r.points);
          reb += n(r.REB ?? r.reb ?? r.rebounds);
          ast += n(r.AST ?? r.ast ?? r.assists);
          th  += n(r.THREES ?? r["3PT"] ?? r.threes ?? r.threePointers);
        }

        const f2 = (x)=> (g ? (x/g).toFixed(2) : "0.00");
        out.push({
          player,
          team,
          games: g,
          avgMIN: f2(min),
          avgPTS: f2(pts),
          avgREB: f2(reb),
          avgAST: f2(ast),
          avg3PT: f2(th),
        });
      }

      out.sort((a,b)=> (b.games - a.games) || String(a.player).localeCompare(String(b.player)));

      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, count: out.length, rows: out });
    });

    console.log("[patch] rolling2 fixed override v2 ✅");
  }catch(e){
    console.log("[patch] rolling2 v2 failed:", String(e?.message||e));
  }
})();


/* ===== NBA TOP PERFORMERS (TODAY) ===== */

app.get("/api/nba/stats/today-leaders", (req,res)=>{
  try{
    const db = readDB();
    const rows = Array.isArray(db.nbaPlayerStats)
      ? db.nbaPlayerStats
      : [];

    const todayISO = new Date().toISOString().slice(0,10);

    const today = rows.filter(r => r.dateISO === todayISO);

    function top(stat, limit=10){
      return [...today]
        .sort((a,b)=> Number(b[stat]||0) - Number(a[stat]||0))
        .slice(0,limit)
        .map(r=>({
          player: r.player,
          team: r.team,
          [stat]: Number(r[stat]||0)
        }));
    }

    res.json({
      ok:true,
      date: todayISO,
      leaders:{
        points: top("PTS"),
        rebounds: top("REB"),
        assists: top("AST"),
        threes: top("THREES")
      }
    });

  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});


/* ===== NBA TOP PERFORMERS (AUTO-FIND STATS ARRAY) ===== */

function __findStatsArray(obj, depth=0){
  if(!obj || depth>3) return null;

  // direct array check
  if(Array.isArray(obj) && obj.length && typeof obj[0]==="object"){
    const o = obj[0];
    const hasShape =
      ("dateISO" in o) &&
      ("player" in o) &&
      (("PTS" in o) || ("pts" in o)) &&
      (("REB" in o) || ("reb" in o)) &&
      (("AST" in o) || ("ast" in o));
    if(hasShape) return obj;
  }

  // search object keys
  if(typeof obj === "object"){
    for(const k of Object.keys(obj)){
      const v = obj[k];
      const found = __findStatsArray(v, depth+1);
      if(found) return found;
    }
  }

  return null;
}

app.get("/api/nba/stats/today-leaders2", (req,res)=>{
  try{
    const db = readDB();
    const rows = __findStatsArray(db) || [];

    if(!Array.isArray(rows) || rows.length===0){
      return res.json({ ok:true, date:null, leaders:{ points:[], rebounds:[], assists:[], threes:[] }, note:"No stats array found in DB" });
    }

    // Use TODAY first; if none, use most recent dateISO in DB
    const todayISO = new Date().toISOString().slice(0,10);

    const dates = [...new Set(rows.map(r=>r?.dateISO).filter(Boolean))].sort();
    const latestISO = dates[dates.length-1] || null;

    const dateUsed = rows.some(r=>r.dateISO===todayISO) ? todayISO : latestISO;

    const dayRows = rows.filter(r => r.dateISO === dateUsed);

    const num = (x)=> (x==null || x==="") ? 0 : Number(x);

    function top(stat, limit=10){
      return [...dayRows]
        .sort((a,b)=> num(b[stat]) - num(a[stat]))
        .slice(0, limit)
        .map(r=>({
          player: r.player,
          team: r.team,
          [stat]: num(r[stat])
        }));
    }

    res.json({
      ok:true,
      date: dateUsed,
      leaders:{
        points: top("PTS"),
        rebounds: top("REB"),
        assists: top("AST"),
        threes: top("THREES")
      }
    });

  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});


/* ===== PROTRACKER EDGES (ROLLING AVG vs HARDROCK LINE) ===== */

function __normName(s){
  return String(s||"").trim().toLowerCase().replace(/\s+/g," ");
}
function __toNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Find stats array (same trick as leaders2)
function __findStatsArray(obj, depth=0){
  if(!obj || depth>3) return null;
  if(Array.isArray(obj) && obj.length && typeof obj[0]==="object"){
    const o=obj[0];
    const ok=("dateISO" in o) && ("player" in o) && (("PTS" in o)||("pts" in o)) && (("REB" in o)||("reb" in o)) && (("AST" in o)||("ast" in o));
    if(ok) return obj;
  }
  if(typeof obj==="object"){
    for(const k of Object.keys(obj)){
      const found=__findStatsArray(obj[k], depth+1);
      if(found) return found;
    }
  }
  return null;
}

// Map HR stat -> our stat field
function __statField(stat){
  const s = String(stat||"").toUpperCase();
  if(s==="PTS" || s==="POINTS") return "PTS";
  if(s==="REB" || s==="REBOUNDS") return "REB";
  if(s==="AST" || s==="ASSISTS") return "AST";
  if(s==="3PT" || s==="3PTS" || s==="THREES") return "THREES";
  return null;
}

// Rolling averages from saved game stats
function __rolling(rows, games=5, playerQuery=null){
  const g = Math.max(1, Math.min(20, Number(games)||5));
  const q = playerQuery ? __normName(playerQuery) : null;

  // group by player+team
  const byKey = new Map();
  for(const r of rows){
    if(!r || !r.player || !r.dateISO) continue;
    if(q && __normName(r.player)!==q) continue;
    const key = `${__normName(r.player)}|${__normName(r.team||"")}`;
    if(!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const out = [];
  for(const [key, arr] of byKey.entries()){
    arr.sort((a,b)=> String(b.dateISO).localeCompare(String(a.dateISO))); // newest first
    const take = arr.slice(0, g);
    const gamesUsed = take.length;
    const sum = (field)=> take.reduce((acc,x)=>acc+__toNum(x[field]),0);

    const player = take[0].player;
    const team = take[0].team;

    out.push({
      player, team,
      games: gamesUsed,
      avgPTS: gamesUsed ? sum("PTS")/gamesUsed : 0,
      avgREB: gamesUsed ? sum("REB")/gamesUsed : 0,
      avgAST: gamesUsed ? sum("AST")/gamesUsed : 0,
      avg3PT: gamesUsed ? sum("THREES")/gamesUsed : 0
    });
  }
  return out;
}

// Simple leaders wrapper
app.get("/api/nba/leaders", (req,res)=>{
  try{
    const date = String(req.query.date||"").trim() || null;
    const db = readDB();
    const rows = __findStatsArray(db) || [];
    if(!rows.length) return res.json({ok:true,date:null,leaders:{points:[],rebounds:[],assists:[],threes:[]}});

    const todayISO = new Date().toISOString().slice(0,10);
    const dates = [...new Set(rows.map(r=>r?.dateISO).filter(Boolean))].sort();
    const latestISO = dates[dates.length-1] || null;
    const dateUsed = date || (rows.some(r=>r.dateISO===todayISO) ? todayISO : latestISO);

    const dayRows = rows.filter(r=>r.dateISO===dateUsed);

    const top = (field, limit=10)=> [...dayRows].sort((a,b)=>__toNum(b[field])-__toNum(a[field])).slice(0,limit).map(r=>({player:r.player,team:r.team,[field]:__toNum(r[field])}));

    res.json({
      ok:true,
      date: dateUsed,
      leaders:{
        points: top("PTS"),
        rebounds: top("REB"),
        assists: top("AST"),
        threes: top("THREES")
      }
    });
  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});

// Edges endpoint (HardRock lines vs rolling averages)
app.get("/api/nba/edges", (req,res)=>{
  try{
    const eventId = String(req.query.eventId||"").trim();
    const games = Number(req.query.games||5);
    const minEdge = Number(req.query.minEdge||1);

    const db = readDB();
    const statsRows = __findStatsArray(db) || [];
    const hr = (db.hardrockPropLines||[]).filter(x=>!eventId || String(x.eventId)===eventId);

    if(!hr.length){
      return res.json({ok:true,eventId:eventId||null,count:0,rows:[],note:"No HardRock lines imported for this eventId"});
    }

    // rolling for all players (or you can filter later)
    const roll = __rolling(statsRows, games, null);
    const rollMap = new Map();
    for(const r of roll){
      rollMap.set(__normName(r.player), r);
    }

    const rows = [];
    for(const l of hr){
      const nameKey = __normName(l.player);
      const r = rollMap.get(nameKey);
      if(!r) continue;

      const fld = __statField(l.stat);
      if(!fld) continue;

      const proj =
        fld==="PTS" ? r.avgPTS :
        fld==="REB" ? r.avgREB :
        fld==="AST" ? r.avgAST :
        r.avg3PT;

      const line = __toNum(l.line);
      const edge = proj - line;

      if(Math.abs(edge) < minEdge) continue;

      rows.push({
        eventId: l.eventId,
        league: l.league || "NBA",
        player: l.player,
        team: r.team,
        stat: String(l.stat||"").toUpperCase(),
        line,
        proj: Number(proj.toFixed(2)),
        edge: Number(edge.toFixed(2)),
        overOdds: l.overOdds ?? null,
        underOdds: l.underOdds ?? null,
        games: r.games
      });
    }

    rows.sort((a,b)=> Math.abs(b.edge)-Math.abs(a.edge));

    res.json({ ok:true, eventId:eventId||null, count: rows.length, rows });
  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});


/* ===============================
   HARDROCK PROP LINES (MANUAL IMPORT)
   =============================== */

app.post("/api/hardrock/props/import", (req,res)=>{
  try{
    const arr = req.body;
    if(!Array.isArray(arr)){
      return res.status(400).json({ok:false,error:"Body must be array"});
    }

    const db = readDB();
    db.hardrockPropLines ||= [];

    const now = new Date().toISOString();

    const clean = [];
    for(const x of arr){
      const eventId = String(x.eventId||"").trim();
      const player  = String(x.player||"").trim();
      const stat    = String(x.stat||"").trim().toUpperCase();
      const line    = Number(x.line);

      if(!eventId || !player || !stat || Number.isNaN(line)) continue;

      clean.push({
        eventId,
        league: x.league||"NBA",
        player,
        stat,
        line,
        overOdds: x.overOdds ?? null,
        underOdds: x.underOdds ?? null,
        updatedAt: now
      });
    }

    const key = r => `${r.eventId}|${r.player}|${r.stat}`;
    const map = new Map((db.hardrockPropLines||[]).map(r=>[key(r),r]));

    for(const r of clean){
      map.set(key(r), r);
    }

    db.hardrockPropLines = Array.from(map.values());
    writeDB(db);

    res.json({ok:true, added:clean.length});
  }catch(e){
    res.status(500).json({ok:false,error:String(e.message||e)});
  }
});


app.get("/api/hardrock/props",(req,res)=>{
  const eventId = String(req.query.eventId||"").trim();
  const db = readDB();

  let rows = db.hardrockPropLines || [];
  if(eventId){
    rows = rows.filter(r=>r.eventId===eventId);
  }

  res.json({ok:true,eventId:eventId||null,rows});
});


/* ===============================
   EDGE BOARD (TODAY) - WORKING
   =============================== */
app.get("/api/nba/edges-today", async (req,res)=>{
  try{
    const minEdge = Number(req.query.minEdge ?? 1);
    const gamesN = Number(req.query.games ?? 5);

    const db = readDB();
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();

    const isToday = (iso)=>{
      const t = new Date(iso);
      return t.getUTCFullYear()===y && t.getUTCMonth()===m && t.getUTCDate()===d;
    };

    const todays = (db.games||[]).filter(g=>{
      const lg = (g.league||"").toUpperCase();
      return lg==="NBA" && g.extId && isToday(g.startTime);
    });

    const allEdges = [];
    for(const g of todays){
      const eventId = String(g.extId);
      const url = `http://127.0.0.1:${PORT}/api/nba/edges?eventId=${encodeURIComponent(eventId)}&games=${encodeURIComponent(gamesN)}&minEdge=${encodeURIComponent(minEdge)}`;
      const r = await fetch(url);
      const j = await r.json();
      if(j && j.ok && Array.isArray(j.rows)){
        for(const row of j.rows){
          allEdges.push(row);
        }
      }
    }

    // sort biggest absolute edge first
    allEdges.sort((a,b)=>Math.abs(Number(b.edge||0)) - Math.abs(Number(a.edge||0)));

    res.setHeader("Cache-Control","no-store");
    res.json({ ok:true, date: now.toISOString().slice(0,10), count: allEdges.length, rows: allEdges.slice(0,200) });
  }catch(e){
    res.status(500).json({ok:false, error:String(e.message||e)});
  }
});


/* =====================================================
   NBA EDGE BOARD — SAFE BOTTOM INSERT
   Shows best prop edges for TODAY'S NBA games
   ===================================================== */

if (!global.__PT_EDGES_TODAY__) {

  global.__PT_EDGES_TODAY__ = true;

  app.get("/api/nba/edges-today", async (req,res)=>{
    try{
      const minEdge = Number(req.query.minEdge ?? 1);
      const gamesN = Number(req.query.games ?? 5);

      const db = readDB();
      const now = new Date();

      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const d = now.getUTCDate();

      function isToday(iso){
        const t = new Date(iso);
        return (
          t.getUTCFullYear() === y &&
          t.getUTCMonth() === m &&
          t.getUTCDate() === d
        );
      }

      const todaysGames = (db.games || []).filter(g=>{
        return (
          (g.league || "").toUpperCase() === "NBA" &&
          g.extId &&
          isToday(g.startTime)
        );
      });

      let edges = [];

      for(const g of todaysGames){
        try{
          const url =
            "http://127.0.0.1:3000/api/nba/edges" +
            "?eventId=" + encodeURIComponent(g.extId) +
            "&games=" + encodeURIComponent(gamesN) +
            "&minEdge=" + encodeURIComponent(minEdge);

          const r = await fetch(url);
          const j = await r.json();

          if(j && j.ok && Array.isArray(j.rows)){
            edges.push(...j.rows);
          }
        }catch(e){}
      }

      edges.sort((a,b)=>
        Math.abs(Number(b.edge||0)) -
        Math.abs(Number(a.edge||0))
      );

      res.setHeader("Cache-Control","no-store");
      res.json({
        ok:true,
        date: now.toISOString().slice(0,10),
        count: edges.length,
        rows: edges.slice(0,200)
      });

    }catch(e){
      res.status(500).json({ok:false,error:String(e.message||e)});
    }
  });

}


/* =====================================================
   NBA EDGES TODAY (ET) + DEBUG — SAFE BOTTOM INSERT
   ===================================================== */

if (!global.__PT_EDGES_TODAY_ET__) {
  global.__PT_EDGES_TODAY_ET__ = true;

  function ymdInTZ(date, tz){
    // returns YYYY-MM-DD in the requested timezone
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (t)=> parts.find(p=>p.type===t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  app.get("/api/nba/edges-today-debug", (req,res)=>{
    const db = readDB();
    const tz = req.query.tz || "America/New_York";
    const today = ymdInTZ(new Date(), tz);

    const todaysGames = (db.games||[]).filter(g=>{
      const lg = (g.league||"").toUpperCase();
      if(lg !== "NBA") return false;
      if(!g.extId) return false;
      const gday = ymdInTZ(new Date(g.startTime), tz);
      return gday === today;
    }).map(g=>({
      startTime: g.startTime,
      dayET: ymdInTZ(new Date(g.startTime), tz),
      eventId: String(g.extId),
      id: g.id
    }));

    const lines = (db.hardrockPropLines||[]);
    const linesToday = lines.filter(x=>{
      const day = ymdInTZ(new Date(x.updatedAt || Date.now()), tz);
      return day === today;
    }).slice(0,50);

    res.setHeader("Cache-Control","no-store");
    res.json({
      ok:true,
      tz,
      today,
      gamesTodayCount: todaysGames.length,
      gamesToday: todaysGames.slice(0,40),
      hardrockTotal: lines.length,
      hardrockUpdatedTodaySample: linesToday
    });
  });

  app.get("/api/nba/edges-today", async (req,res)=>{
    try{
      const minEdge = Number(req.query.minEdge ?? 1);
      const gamesN  = Number(req.query.games ?? 5);
      const tz = req.query.tz || "America/New_York";

      const db = readDB();
      const today = ymdInTZ(new Date(), tz);

      // Find today's NBA games by ET day
      const todaysGames = (db.games||[])
        .filter(g=>{
          const lg = (g.league||"").toUpperCase();
          if(lg !== "NBA") return false;
          if(!g.extId) return false;
          const gday = ymdInTZ(new Date(g.startTime), tz);
          return gday === today;
        });

      // Fallback: if no games match, use any eventIds you imported HR lines for today
      let eventIds = todaysGames.map(g=>String(g.extId));
      if(eventIds.length === 0){
        const hr = (db.hardrockPropLines||[]);
        const s = new Set();
        for(const x of hr){
          const day = ymdInTZ(new Date(x.updatedAt || Date.now()), tz);
          if(day === today && x.eventId) s.add(String(x.eventId));
        }
        eventIds = Array.from(s);
      }

      let edges = [];
      for(const eid of eventIds){
        try{
          const url =
            "http://127.0.0.1:3000/api/nba/edges" +
            "?eventId=" + encodeURIComponent(eid) +
            "&games=" + encodeURIComponent(gamesN) +
            "&minEdge=" + encodeURIComponent(minEdge);

          const r = await fetch(url);
          const j = await r.json();
          if(j && j.ok && Array.isArray(j.rows)) edges.push(...j.rows);
        }catch(e){}
      }

      edges.sort((a,b)=>Math.abs(Number(b.edge||0)) - Math.abs(Number(a.edge||0)));

      res.setHeader("Cache-Control","no-store");
      res.json({
        ok:true,
        tz,
        date: today,
        eventIds,
        count: edges.length,
        rows: edges.slice(0,200)
      });
    }catch(e){
      res.status(500).json({ok:false,error:String(e.message||e)});
    }
  });
}


/* ==========================================================
   OVERRIDE: /api/nba/edges-today (+ debug) — FORCE ET VERSION
   Paste-at-bottom safe: removes older routes if they exist
   ========================================================== */
(function overrideEdgesTodayET(){
  if (global.__PT_OVERRIDE_EDGES_TODAY_ET__) return;
  global.__PT_OVERRIDE_EDGES_TODAY_ET__ = true;

  function ymdInTZ(date, tz){
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"
    }).formatToParts(date);
    const get = (t)=> parts.find(p=>p.type===t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function dropRoute(path){
    try{
      const stack = app?._router?.stack;
      if(!Array.isArray(stack)) return 0;
      const before = stack.length;
      app._router.stack = stack.filter(layer=>{
        // route layers
        if(layer?.route?.path === path) return false;
        // middleware (rare)
        if(layer?.name === "bound dispatch" && layer?.regexp?.toString?.().includes(path)) return false;
        return true;
      });
      return before - app._router.stack.length;
    }catch(e){ return 0; }
  }

  // remove any older versions
  dropRoute("/api/nba/edges-today");
  dropRoute("/api/nba/edges-today-debug");

  app.get("/api/nba/edges-today-debug", (req,res)=>{
    const db = readDB();
    const tz = req.query.tz || "America/New_York";
    const today = ymdInTZ(new Date(), tz);

    const gamesToday = (db.games||[]).filter(g=>{
      const lg = String(g.league||"").toUpperCase();
      if(lg !== "NBA") return false;
      if(!g.extId) return false;
      const gday = ymdInTZ(new Date(g.startTime), tz);
      return gday === today;
    }).map(g=>({
      startTime: g.startTime,
      dayET: ymdInTZ(new Date(g.startTime), tz),
      eventId: String(g.extId),
      id: g.id
    }));

    const hr = (db.hardrockPropLines||[]);
    const hrSample = hr
      .filter(x=> ymdInTZ(new Date(x.updatedAt || Date.now()), tz) === today)
      .slice(0,50);

    res.setHeader("Cache-Control","no-store");
    res.json({
      ok:true,
      tz,
      today,
      gamesTodayCount: gamesToday.length,
      gamesToday: gamesToday.slice(0,40),
      hardrockTotal: hr.length,
      hardrockUpdatedTodaySample: hrSample
    });
  });

  app.get("/api/nba/edges-today", async (req,res)=>{
    try{
      const minEdge = Number(req.query.minEdge ?? 0.5);
      const gamesN  = Number(req.query.games ?? 5);
      const tz = req.query.tz || "America/New_York";

      const db = readDB();
      const today = ymdInTZ(new Date(), tz);

      // Find today's NBA games by ET day
      const todaysGames = (db.games||[])
        .filter(g=>{
          const lg = String(g.league||"").toUpperCase();
          if(lg !== "NBA") return false;
          if(!g.extId) return false;
          const gday = ymdInTZ(new Date(g.startTime), tz);
          return gday === today;
        });

      const eventIds = todaysGames.map(g=>String(g.extId));

      let edges = [];
      for(const eid of eventIds){
        const url =
          "http://127.0.0.1:3000/api/nba/edges" +
          "?eventId=" + encodeURIComponent(eid) +
          "&games=" + encodeURIComponent(gamesN) +
          "&minEdge=" + encodeURIComponent(minEdge);

        try{
          const r = await fetch(url);
          const j = await r.json();
          if(j?.ok && Array.isArray(j.rows)) edges.push(...j.rows);
        }catch(e){}
      }

      // Sort biggest absolute edge first
      edges.sort((a,b)=> Math.abs(Number(b.edge||0)) - Math.abs(Number(a.edge||0)));

      res.setHeader("Cache-Control","no-store");
      res.json({
        ok:true,
        tz,
        date: today,
        eventIds,
        count: edges.length,
        rows: edges.slice(0,200)
      });
    }catch(e){
      res.status(500).json({ok:false,error:String(e.message||e)});
    }
  });

  console.log("[patch] edges-today overridden (ET)");
})();


/* =========================
   __PT_DK_PROPS_V1__ (paste at bottom of protracker.js)
   - Pull DK props via TheOddsAPI
   - Match DK events -> ESPN eventIds (by teams + start time)
   - Save into db.hardrockPropLines (re-using your existing schema)
   - Provide /api/odds/dk/pull + /api/nba/edges-today (ET)
   Requires: THEODDS_API_KEY in .env
   ========================= */
(function __PT_DK_PROPS_V1__(){
  try{
    try { require("dotenv").config(); } catch(e){}
    const THEODDS_API_KEY = process.env.THEODDS_API_KEY || "";

    const _fetch = (typeof fetch !== "undefined") ? fetch : require("node-fetch");

    function normTeam(s){
      return String(s||"")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g," ")
        .replace(/\s+/g," ")
        .trim();
    }
    function statFromMarket(m){
      m = String(m||"").toLowerCase();
      if(m.includes("player_points")) return "PTS";
      if(m.includes("player_rebounds")) return "REB";
      if(m.includes("player_assists")) return "AST";
      if(m.includes("player_threes") || m.includes("player_3pt")) return "3PT";
      return null;
    }

    // Return YYYY-MM-DD in America/New_York from an ISO string
    function dayET(iso){
      try{
        const dt = new Date(iso);
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year:"numeric", month:"2-digit", day:"2-digit"
        }).format(dt); // en-CA => YYYY-MM-DD
      }catch(e){
        return String(iso||"").slice(0,10);
      }
    }

    function minutesDiff(aISO,bISO){
      const a = new Date(aISO).getTime();
      const b = new Date(bISO).getTime();
      return Math.abs(a-b) / 60000;
    }

    function findEspnEventIdForDkEvent(db, dkEvent){
      // dkEvent has: commence_time, home_team, away_team
      const dkHome = normTeam(dkEvent.home_team);
      const dkAway = normTeam(dkEvent.away_team);
      const dkTime = dkEvent.commence_time;

      // Candidate ESPN games in db.games with extId and NBA
      const games = (db.games||[])
        .filter(g => (g.league||"").toUpperCase()==="NBA" && g.extId && g.startTime)
        .sort((a,b)=> new Date(a.startTime) - new Date(b.startTime));

      // Match by ET day first
      const dkDay = dayET(dkTime);
      const sameDay = games.filter(g => dayET(g.startTime) === dkDay);

      // Resolve team names from db.teams if present
      const teams = db.teams || [];
      const teamName = (id)=> (teams.find(t=>t.id===id)?.name || id || "");
      function gameTeams(g){
        const home = normTeam(g.homeTeam?.name || teamName(g.homeTeamId));
        const away = normTeam(g.awayTeam?.name || teamName(g.awayTeamId));
        return {home, away};
      }

      // Best match scoring: team match + time closeness
      let best = null;
      let bestScore = -1;

      for(const g of sameDay){
        const gt = gameTeams(g);
        const teamHit = (gt.home===dkHome && gt.away===dkAway) ? 2 :
                        (gt.home===dkAway && gt.away===dkHome) ? 1 : 0; // handle swapped
        if(teamHit===0) continue;

        const md = minutesDiff(g.startTime, dkTime);
        // time window within 6 hours gets points
        const timeScore = (md <= 360) ? (360 - md) / 360 : 0;

        const score = teamHit*10 + timeScore;
        if(score > bestScore){
          bestScore = score;
          best = g;
        }
      }

      // Fallback: ignore day, just try within 12h by teams
      if(!best){
        for(const g of games){
          const gt = gameTeams(g);
          const teamHit = (gt.home===dkHome && gt.away===dkAway) ? 2 :
                          (gt.home===dkAway && gt.away===dkHome) ? 1 : 0;
          if(teamHit===0) continue;

          const md = minutesDiff(g.startTime, dkTime);
          if(md>720) continue;
          const score = teamHit*10 + (720-md)/720;
          if(score > bestScore){
            bestScore = score;
            best = g;
          }
        }
      }

      return best ? String(best.extId) : null;
    }

    // Pull DK props and save to db.hardrockPropLines under ESPN eventId
    app.post("/api/odds/dk/pull", async (req,res)=>{
      try{
        if(!THEODDS_API_KEY){
          return res.status(400).json({ok:false, error:"Missing THEODDS_API_KEY in .env"});
        }

        const body = req.body || {};
        const sportKey = body.sportKey || "basketball_nba";
        const regions  = body.regions || "us";
        const markets  = body.markets || "player_points,player_rebounds,player_assists,player_threes";

        const url =
          `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sportKey)}/odds/` +
          `?apiKey=${encodeURIComponent(THEODDS_API_KEY)}` +
          `&regions=${encodeURIComponent(regions)}` +
          `&markets=${encodeURIComponent(markets)}` +
          `&oddsFormat=american`;

        const resp = await _fetch(url, { headers:{accept:"application/json"} });
        const txt = await resp.text();
        if(!resp.ok){
          return res.status(502).json({ok:false, status:resp.status, error:"TheOddsAPI fetch failed", head: txt.slice(0,400)});
        }
        let events = [];
        try{ events = JSON.parse(txt); } catch(e){
          return res.status(502).json({ok:false, error:"JSON parse failed", head: txt.slice(0,400)});
        }
        if(!Array.isArray(events)) events = [];

        const db = readDB();
        db.hardrockPropLines ||= [];

        let matched=0, imported=0, unmatched=0;
        const nowISO = new Date().toISOString();

        for(const ev of events){
          const books = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
          const dk = books.find(b => String(b.key||"").toLowerCase()==="draftkings");
          if(!dk) continue;

          const espnEventId = findEspnEventIdForDkEvent(db, ev);
          if(!espnEventId){ unmatched++; continue; }
          matched++;

          const mkts = Array.isArray(dk.markets) ? dk.markets : [];
          for(const mk of mkts){
            const stat = statFromMarket(mk.key);
            if(!stat) continue;

            const outs = Array.isArray(mk.outcomes) ? mk.outcomes : [];
            for(const o of outs){
              const player = String(o.description || o.player || o.name || "").trim();
              const side = String(o.name||"").toLowerCase(); // over/under
              const line = Number(o.point);
              const price = (o.price==null) ? null : Number(o.price);
              if(!player || Number.isNaN(line)) continue;

              // Find or create row for player+stat in this ESPN eventId
              let row = db.hardrockPropLines.find(r =>
                String(r.eventId)===espnEventId &&
                String(r.player||"").toLowerCase()===player.toLowerCase() &&
                String(r.stat||"").toUpperCase()===stat
              );

              if(!row){
                row = {
                  eventId: espnEventId,
                  league: "NBA",
                  player,
                  stat,
                  line,
                  overOdds: null,
                  underOdds: null,
                  updatedAt: nowISO,
                  book: "draftkings"
                };
                db.hardrockPropLines.push(row);
              } else {
                row.line = line;
                row.updatedAt = nowISO;
                row.book = "draftkings";
              }

              if(side.includes("over")) row.overOdds = price;
              if(side.includes("under")) row.underOdds = price;

              imported++;
            }
          }
        }

        // De-dup keep latest
        const k = (r)=>`${r.eventId}|${String(r.player||"").toLowerCase()}|${String(r.stat||"").toUpperCase()}|${String(r.book||"")}`;
        const map = new Map();
        for(const r of db.hardrockPropLines){
          const kk = k(r);
          const prev = map.get(kk);
          if(!prev || String(r.updatedAt) > String(prev.updatedAt)) map.set(kk,r);
        }
        db.hardrockPropLines = Array.from(map.values());
        writeDB(db);

        res.json({ok:true, eventsSeen: events.length, matched, unmatched, imported, stored: db.hardrockPropLines.length});
      }catch(e){
        res.status(500).json({ok:false, error:String(e.message||e)});
      }
    });

    // Today's edges across today's ESPN games (ET day) using your existing /api/nba/edges logic if present,
    // otherwise compute a minimal edge using your rolling3 endpoint if available.
    app.get("/api/nba/edges-today", async (req,res)=>{
      try{
        const minEdge = Number(req.query.minEdge ?? 0.5);
        const gamesN = Number(req.query.games ?? 5);

        const db = readDB();
        const tz = "America/New_York";
        const today = new Intl.DateTimeFormat("en-CA", {timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());

        const gamesToday = (db.games||[])
          .filter(g => (g.league||"").toUpperCase()==="NBA" && g.extId && g.startTime && dayET(g.startTime)===today)
          .map(g => String(g.extId));

        // Need imported DK lines
        const props = (db.hardrockPropLines||[])
          .filter(r => r.league==="NBA" && gamesToday.includes(String(r.eventId)));

        // Use nbaRolling cache from DB if you have it; else fallback to calling your rolling3 endpoint internally
        const allStats = db.nbaBoxPlayers || []; // if you store raw game stats there
        // We will compute rolling on the fly from db.nbaBoxPlayers if present, otherwise edge list will be empty.

        function num(x){
          const n = Number(x);
          return Number.isFinite(n) ? n : 0;
        }

        // Build per-player game list from stored nbaBoxPlayers (if present)
        const byPlayer = new Map();
        for(const r of allStats){
          const name = String(r.player||"").trim();
          if(!name) continue;
          if(!byPlayer.has(name)) byPlayer.set(name, []);
          byPlayer.get(name).push(r);
        }
        for(const [name, arr] of byPlayer){
          arr.sort((a,b)=> String(b.dateISO||"").localeCompare(String(a.dateISO||"")));
        }

        function projFromRolling(player, stat){
          const arr = byPlayer.get(player);
          if(!arr || !arr.length) return null;
          const slice = arr.slice(0, Math.max(1, gamesN));
          const denom = slice.length;
          let sum = 0;

          for(const g of slice){
            if(stat==="PTS") sum += num(g.PTS);
            else if(stat==="REB") sum += num(g.REB);
            else if(stat==="AST") sum += num(g.AST);
            else if(stat==="3PT") sum += num(g.THREES);
          }
          return sum / denom;
        }

        const rows = [];
        for(const p of props){
          const player = p.player;
          const stat = String(p.stat||"").toUpperCase();
          const line = Number(p.line);
          if(!player || !stat || !Number.isFinite(line)) continue;

          const proj = projFromRolling(player, stat);
          if(proj==null) continue;

          const edge = proj - line; // + means proj over line
          if(Math.abs(edge) < minEdge) continue;

          rows.push({
            eventId: String(p.eventId),
            league: "NBA",
            player,
            stat,
            line,
            proj: Number(proj.toFixed(2)),
            edge: Number(edge.toFixed(2)),
            overOdds: p.overOdds ?? null,
            underOdds: p.underOdds ?? null,
            games: Math.max(1, Math.min(gamesN, (byPlayer.get(player)||[]).length))
          });
        }

        rows.sort((a,b)=> Math.abs(b.edge)-Math.abs(a.edge) || String(a.player).localeCompare(String(b.player)));
        res.setHeader("Cache-Control","no-store");
        res.json({ok:true, tz, date: today, eventIds: gamesToday, count: rows.length, rows});
      }catch(e){
        res.status(500).json({ok:false, error:String(e.message||e)});
      }
    });

    console.log("[patch] DK props ready: POST /api/odds/dk/pull and GET /api/nba/edges-today");
  }catch(e){
    console.log("[patch] DK props block failed:", String(e.message||e));
  }
})();


/* ===== __PT_ODDSAPI_DK_PATCH__ (paste at very bottom) ===== */
try {
  // avoid double-register if you paste twice
  if (!global.__PT_ODDSAPI_DK_PATCH__) {
    global.__PT_ODDSAPI_DK_PATCH__ = true;

    const ODDS_BASE = "https://api.the-odds-api.com/v4";

    async function oddsApiGet(path, qs = {}) {
      const apiKey = process.env.THEODDS_API_KEY;
      if (!apiKey) throw new Error("Missing THEODDS_API_KEY in .env");

      const u = new URL(ODDS_BASE + path);
      u.searchParams.set("apiKey", apiKey);
      for (const [k, v] of Object.entries(qs)) {
        if (v === undefined || v === null || v === "") continue;
        u.searchParams.set(k, String(v));
      }
      const r = await fetch(u.toString(), { headers: { "accept": "application/json" } });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`TheOddsAPI ${r.status}: ${txt.slice(0, 200)}`);
      }
      return r.json();
    }

    function safeNum(x) {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    }

    // maps common markets -> your stat keys
    const MARKET_TO_STAT = {
      "player_points": "PTS",
      "player_rebounds": "REB",
      "player_assists": "AST",
      "player_threes": "3PT",
      "player_3pt_made": "3PT",
      "player_threes_made": "3PT",
    };

    // POST /api/odds/dk/pull
    // body: { sport?: "basketball_nba", regions?: "us", markets?: "...", daysAhead?: 1 }
    app.post("/api/odds/dk/pull", async (req, res) => {
      try {
        const sport = (req.body?.sport || "basketball_nba").trim();
        const regions = (req.body?.regions || "us").trim();
        // pick the props markets you want (TheOddsAPI naming can vary by plan)
        const markets = (req.body?.markets || [
          "player_points",
          "player_rebounds",
          "player_assists",
          "player_threes",
        ].join(",")).trim();

        const oddsFormat = (req.body?.oddsFormat || "american").trim();
        const dateFormat = (req.body?.dateFormat || "iso").trim();

        // Pull event odds (includes player props if your plan supports it)
        const data = await oddsApiGet(`/sports/${sport}/odds`, {
          regions,
          markets,
          oddsFormat,
          dateFormat,
          // IMPORTANT: request DK book if available; if not, we’ll fall back to any book that matches “draftkings”
          bookmakers: "draftkings",
        });

        const db = readDB();
        db.hardrockPropLines ||= [];
        const now = new Date().toISOString();

        // helper for de-dupe (eventId|player|stat)
        const key = (r) => `${r.eventId}|${r.player.toLowerCase()}|${r.stat}`;
        const existing = new Map((db.hardrockPropLines || []).map(r => [key(r), r]));

        let added = 0;

        for (const ev of (data || [])) {
          // We need to map TheOddsAPI event -> your ESPN eventId.
          // Best simple approach: match by start time + teams in your db.games
          const startISO = ev.commence_time;
          const home = (ev.home_team || "").toLowerCase();
          const away = (ev.away_team || "").toLowerCase();

          const match = (db.games || []).find(g => {
            if (!g.extId) return false;
            const gStart = String(g.startTime || "");
            if (startISO && gStart && !gStart.startsWith(startISO.slice(0, 16))) {
              // loose match by prefix minute
              // if too strict for you, remove this check
            }
            const ht = ((db.teams||[]).find(t => t.id === g.homeTeamId)?.name || "").toLowerCase();
            const at = ((db.teams||[]).find(t => t.id === g.awayTeamId)?.name || "").toLowerCase();
            return (ht && at && ht.includes(home.split(" ")[0]) && at.includes(away.split(" ")[0])) ||
                   (ht && at && ht.includes(home) && at.includes(away));
          });

          const eventId = match?.extId || null;
          if (!eventId) continue;

          const books = ev.bookmakers || [];
          const dk = books.find(b => String(b.key || "").toLowerCase() === "draftkings") ||
                     books.find(b => String(b.title || "").toLowerCase().includes("draftkings"));
          if (!dk) continue;

          for (const mk of (dk.markets || [])) {
            const stat = MARKET_TO_STAT[mk.key] || null;
            if (!stat) continue;

            for (const o of (mk.outcomes || [])) {
              const player = (o.description || o.name || "").trim();
              const line = safeNum(o.point);
              if (!player || line == null) continue;

              // try to capture over/under odds if present; TheOddsAPI outcome structure varies
              // many formats provide one outcome per side; we store line and “price” if it’s there
              const price = safeNum(o.price);

              const row = {
                eventId: String(eventId),
                league: "NBA",
                player,
                stat,
                line,
                overOdds: null,
                underOdds: null,
                updatedAt: now
              };

              // If the outcome name indicates Over/Under, set odds accordingly
              const nm = String(o.name || "").toLowerCase();
              if (nm.includes("over")) row.overOdds = price;
              else if (nm.includes("under")) row.underOdds = price;

              existing.set(key(row), row);
              added++;
            }
          }
        }

        db.hardrockPropLines = Array.from(existing.values());
        writeDB(db);

        res.json({ ok: true, added, note: "Saved into db.hardrockPropLines (used by edges endpoints)." });
      } catch (e) {
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    });

    console.log("[patch] DK props ready: POST /api/odds/dk/pull (reads THEODDS_API_KEY from .env)");
  }
} catch (e) {
  // never crash boot
  console.log("[patch] odds api patch failed:", String(e.message || e));
}
/* ===== end __PT_ODDSAPI_DK_PATCH__ ===== */

/* __DK_PLAYER_PROPS_PATCH__ (paste-at-bottom)
   Fixes INVALID_MARKET by using the EVENT odds endpoint for player props.
   Adds:
     POST /api/odds/dk/pull
     GET  /api/odds/dk/debug-markets?eventId=...
     GET  /api/odds/dk/props?eventId=...
*/

const __DK_API_KEY__ =
  process.env.THEODDS_API_KEY ||
  "03b25e9a799e27648397402b98a85fa3"; // <-- your key

const __ODDS_BASE__ = "https://api.the-odds-api.com/v4";

async function __oddsGet(path, params = {}) {
  const u = new URL(__ODDS_BASE__ + path);
  u.searchParams.set("apiKey", __DK_API_KEY__);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const r = await fetch(u.toString(), { headers: { "accept": "application/json" } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, text, json, url: u.toString() };
}

function __statFromMarket(marketKey) {
  // TheOddsAPI keys -> your internal stat codes
  if (marketKey === "player_points") return "PTS";
  if (marketKey === "player_rebounds") return "REB";
  if (marketKey === "player_assists") return "AST";
  if (marketKey === "player_threes") return "3PT";
  return null;
}

// Store DK props in DB
function __ensureDkBucket(db) {
  db.dkPropLines ||= [];
  return db.dkPropLines;
}

// Pull DK player props for all games "today" (ET) based on your db.games eventIds
app.post("/api/odds/dk/pull", async (req, res) => {
  try {
    if (!__DK_API_KEY__ || __DK_API_KEY__.includes("INVALID")) {
      return res.status(400).json({ ok: false, error: "Missing/invalid THEODDS_API_KEY" });
    }

    const db = readDB();
    __ensureDkBucket(db);

    // Use your existing "today" NBA games list (ET) from db.games
    const tz = "America/New_York";
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    const todayET = fmt.format(new Date()); // YYYY-MM-DD

    const todayEventIds = (db.games || [])
      .filter(g => (g.league || "").toUpperCase() === "NBA" && g.extId)
      .map(g => {
        const dayET = fmt.format(new Date(g.startTime));
        return { eventId: String(g.extId), dayET };
      })
      .filter(x => x.dayET === todayET)
      .map(x => x.eventId);

    // If you have none, still allow manual list in body
    const bodyIds = Array.isArray(req.body?.eventIds) ? req.body.eventIds.map(String) : [];
    const eventIds = [...new Set((todayEventIds.length ? todayEventIds : bodyIds))];

    if (!eventIds.length) {
      return res.json({ ok: true, dateET: todayET, attempted: 0, saved: 0, note: "No NBA eventIds found for today." });
    }

    const markets = "player_points,player_rebounds,player_assists,player_threes";
    const now = new Date().toISOString();

    let saved = 0;
    let attempted = 0;
    const errors = [];

    for (const eid of eventIds) {
      attempted++;

      // IMPORTANT: player props must be pulled via the EVENT odds endpoint
      const resp = await __oddsGet(`/sports/basketball_nba/events/${encodeURIComponent(eid)}/odds`, {
        regions: "us",
        markets,
        bookmakers: "draftkings",
        oddsFormat: "american",
        dateFormat: "iso",
      });

      if (!resp.ok) {
        // Surface useful error detail
        errors.push({ eventId: eid, status: resp.status, head: resp.text.slice(0, 300) });
        continue;
      }

      // The response shape: { id, bookmakers:[{key,markets:[{key,outcomes:[...]}]}] }
      const data = resp.json || {};
      const bks = Array.isArray(data.bookmakers) ? data.bookmakers : [];

      for (const bk of bks) {
        const ms = Array.isArray(bk.markets) ? bk.markets : [];
        for (const m of ms) {
          const stat = __statFromMarket(m.key);
          if (!stat) continue;

          const outs = Array.isArray(m.outcomes) ? m.outcomes : [];
          // outcomes for player props are usually per-player Over/Under pairs with a "point" line.
          // We'll store each (player, stat) at the line, with over/under odds if present.
          // We group by player+line.
          const byPlayerLine = new Map();
          for (const o of outs) {
            const player = String(o.description || o.name || "").trim();
            const line = (o.point == null) ? null : Number(o.point);
            if (!player || line == null || Number.isNaN(line)) continue;
            const key = `${player.toLowerCase()}|${line}`;
            if (!byPlayerLine.has(key)) byPlayerLine.set(key, { player, line, overOdds: null, underOdds: null });
            const row = byPlayerLine.get(key);
            const nm = String(o.name || "").toLowerCase(); // "Over"/"Under"
            if (nm.includes("over")) row.overOdds = (o.price == null ? null : Number(o.price));
            if (nm.includes("under")) row.underOdds = (o.price == null ? null : Number(o.price));
          }

          for (const v of byPlayerLine.values()) {
            // Upsert into db.dkPropLines by eventId+player+stat
            const k = `${eid}|${v.player.toLowerCase()}|${stat}`;
            // keep a map for quick upsert
            // (do it cheaply without rebuilding huge maps each time)
            const idx = db.dkPropLines.findIndex(r =>
              (r.eventId === eid) &&
              (String(r.player || "").toLowerCase() === v.player.toLowerCase()) &&
              (String(r.stat || "").toUpperCase() === stat)
            );

            const row = {
              eventId: eid,
              league: "NBA",
              bookmaker: "DRAFTKINGS",
              player: v.player,
              stat,
              line: v.line,
              overOdds: v.overOdds,
              underOdds: v.underOdds,
              updatedAt: now,
            };

            if (idx >= 0) db.dkPropLines[idx] = row;
            else db.dkPropLines.push(row);

            saved++;
          }
        }
      }
    }

    writeDB(db);
    res.json({ ok: true, dateET: todayET, attempted, saved, errorsCount: errors.length, errors });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Debug what markets DK is returning for a specific event
app.get("/api/odds/dk/debug-markets", async (req, res) => {
  try {
    const eventId = String(req.query.eventId || "").trim();
    if (!eventId) return res.status(400).json({ ok:false, error:"eventId required" });

    const resp = await __oddsGet(`/sports/basketball_nba/events/${encodeURIComponent(eventId)}/odds`, {
      regions: "us",
      markets: "player_points,player_rebounds,player_assists,player_threes",
      bookmakers: "draftkings",
      oddsFormat: "american",
      dateFormat: "iso",
    });

    if (!resp.ok) return res.status(502).json({ ok:false, status: resp.status, head: resp.text.slice(0,500), url: resp.url });

    const bks = resp.json?.bookmakers || [];
    const keys = [];
    for (const bk of bks) for (const m of (bk.markets || [])) keys.push(m.key);
    res.json({ ok:true, eventId, marketKeys: [...new Set(keys)].sort(), url: resp.url });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// Read DK props you pulled
app.get("/api/odds/dk/props", (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  const db = readDB();
  const rows = (db.dkPropLines || []).filter(r => !eventId || r.eventId === eventId);
  rows.sort((a,b)=> (a.player||"").localeCompare(b.player||"") || (a.stat||"").localeCompare(b.stat||""));
  res.setHeader("Cache-Control","no-store");
  res.json({ ok:true, eventId: eventId || null, count: rows.length, rows });
});

console.log("[patch] DK player props patch loaded ✅");


/* ===== EDGE TIERS (SAFE ADD-ON) ===== */

function __edgeTier(edge){
  const e = Math.abs(Number(edge||0));

  if(e >= 3) return "A";
  if(e >= 2) return "B";
  if(e >= 1) return "C";
  return "D";
}

/*
 Adds tier + sorting to edges-today output
 without modifying your existing logic.
*/
app.get("/api/nba/edges-today-tiered", (req,res)=>{
  try{
    const minEdge = Number(req.query.minEdge||0);
    const games = Number(req.query.games||5);

    // reuse your existing endpoint internally
    const url =
      `http://127.0.0.1:${PORT}/api/nba/edges-today?minEdge=${minEdge}&games=${games}`;

    fetch(url)
      .then(r=>r.json())
      .then(data=>{
        const rows = Array.isArray(data.rows) ? data.rows : [];

        const out = rows
          .map(r=>({
            ...r,
            tier: __edgeTier(r.edge)
          }))
          .sort((a,b)=>Math.abs(b.edge)-Math.abs(a.edge));

        res.json({
          ok:true,
          date:data.date,
          count:out.length,
          rows:out
        });
      })
      .catch(err=>{
        res.status(500).json({ok:false,error:String(err)});
      });

  }catch(e){
    res.status(500).json({ok:false,error:String(e)});
  }
});

/* ===== SGO (SportsGameOdds) Player Props Pull =====
   Adds:
   - POST /api/odds/sgo/pull
   - GET  /api/odds/sgo/props?eventId=...
   Saves into db.sgoPropLines AND mirrors into db.hardrockPropLines for reuse by edges endpoints.
*/
(function PT_SGO_PATCH(){
  try{
    if (typeof app === "undefined") return;

    const SGO_BASE = "https://api.sportsgameodds.com/v2";
    const SGO_KEY  = process.env.SPORTSGAMEODDS_KEY || process.env.SPORTSGAMEODDS_API_KEY || "";

    async function sgoGet(path, params){
      if(!SGO_KEY) throw new Error("Missing SPORTSGAMEODDS_KEY in .env");
      const url = new URL(SGO_BASE + path);
      if(params){
        for (const [k,v] of Object.entries(params)){
          if(v === undefined || v === null) continue;
          url.searchParams.set(k, String(v));
        }
      }
      const r = await fetch(url.toString(), {
        headers: { "x-api-key": SGO_KEY }
      });
      const text = await r.text();
      let json = null;
      try{ json = JSON.parse(text); }catch(e){}
      if(!r.ok){
        throw new Error(`SGO fetch failed (${r.status}) ${json?JSON.stringify(json).slice(0,220):text.slice(0,220)}`);
      }
      return json;
    }

    function ymdET(d){
      // your server already uses America/New_York; keep it simple and consistent with edges-today logic
      const dt = new Date(d);
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" });
      return fmt.format(dt); // YYYY-MM-DD
    }

    function normalizeStat(statID, betTypeID){
      // SportsGameOdds uses statID like "points", betTypeID like "overUnder" (example code shows statID + betTypeID) 2
      const s = String(statID||"").toLowerCase();
      if (s.includes("point")) return "PTS";
      if (s.includes("rebound")) return "REB";
      if (s.includes("assist")) return "AST";
      if (s.includes("three") || s.includes("3")) return "3PT";
      // fallback: keep original
      return String(statID||"").toUpperCase();
    }

    function prettyPlayerFromEntity(statEntityID){
      // statEntityID example in docs: 'LEBRON_JAMES_1_NBA' 3
      if(!statEntityID) return "";
      const parts = String(statEntityID).split("_");
      if(parts.length >= 3){
        const nameParts = parts.slice(0, -2);
        return nameParts.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      }
      return String(statEntityID);
    }

    // Pull NBA player props for upcoming games OR for a specific eventId
    app.post("/api/odds/sgo/pull", express.json({limit:"2mb"}), async (req,res)=>{
      try{
        const body = req.body || {};
        const leagueID = body.leagueID || "NBA";
        const eventId = body.eventId || body.eventID || null;

        // which books to keep (optional). if empty => keep all books present
        const bookmakerIDs = Array.isArray(body.bookmakerIDs) ? body.bookmakerIDs.map(String) : [];

        // If no eventId given: pull a few upcoming games with oddsAvailable=true 4
        const eventsResp = await sgoGet("/events", eventId ? { eventIDs: eventId } : {
          leagueID,
          finalized: "false",
          oddsAvailable: "true",
          limit: Number(body.limit || 10)
        });

        const events = (eventsResp && eventsResp.data) ? eventsResp.data : [];
        const db = readDB();
        db.sgoPropLines ||= [];
        db.hardrockPropLines ||= []; // we mirror into this for your edges endpoints

        let saved = 0;
        let totalProps = 0;
        const nowISO = new Date().toISOString();

        for(const ev of events){
          const evId = String(ev.eventID || ev.id || ev.eventId || "").trim();
          if(!evId) continue;

          const startsAt = ev?.status?.startsAt || ev?.startTime || null;
          const dateISO = startsAt ? ymdET(startsAt) : ymdET(new Date());

          const odds = ev.odds || {};
          // Player props are odds where statEntityID is NOT all/home/away 5
          for(const [oddID, odd] of Object.entries(odds)){
            const statEntity = odd?.statEntityID || "all";
            if(["all","home","away"].includes(String(statEntity))) continue;

            const player = prettyPlayerFromEntity(statEntity);
            const stat = normalizeStat(odd?.statID, odd?.betTypeID);

            // byBookmaker contains overUnder + odds + lastUpdatedAt 6
            const byBook = odd?.byBookmaker || {};
            for(const [bookID, bookData] of Object.entries(byBook)){
              if(bookmakerIDs.length && !bookmakerIDs.includes(String(bookID))) continue;
              if(bookData && bookData.available === false) continue;

              const line = bookData?.overUnder;
              const price = bookData?.odds ?? null;
              const side = String(odd?.sideID || "").toLowerCase(); // "over" or "under" 7
              if(line == null || line === "") continue;

              totalProps++;

              // We'll store one row per side; later we can merge over/under if you want
              const row = {
                eventId: evId,
                league: leagueID,
                dateISO,
                bookmaker: String(bookID),
                oddID: String(oddID),
                player,
                stat,
                line: Number(line),
                side: side || null,
                odds: price==null ? null : Number(price),
                updatedAt: bookData?.lastUpdatedAt || nowISO
              };

              db.sgoPropLines.push(row);

              // Mirror into your existing hardrockPropLines format (one row per stat with over/under odds fields)
              // We'll merge sides into a single row if possible.
              const key = (r)=>`${r.eventId}|${(r.player||"").toLowerCase()}|${String(r.stat||"").toUpperCase()}|${String(r.bookmaker||"")}`;
              const mergedKey = `${evId}|${player.toLowerCase()}|${String(stat).toUpperCase()}|${String(bookID)}`;

              const existingIdx = db.hardrockPropLines.findIndex(r=>key(r)===mergedKey);
              if(existingIdx === -1){
                db.hardrockPropLines.push({
                  eventId: evId,
                  league: leagueID,
                  player,
                  stat: String(stat).toUpperCase(),
                  line: Number(line),
                  overOdds: side==="over" ? (price==null?null:Number(price)) : null,
                  underOdds: side==="under" ? (price==null?null:Number(price)) : null,
                  bookmaker: String(bookID),
                  updatedAt: bookData?.lastUpdatedAt || nowISO
                });
                saved++;
              }else{
                const ex = db.hardrockPropLines[existingIdx];
                ex.line = Number(line);
                if(side==="over") ex.overOdds = price==null?null:Number(price);
                if(side==="under") ex.underOdds = price==null?null:Number(price);
                ex.bookmaker = String(bookID);
                ex.updatedAt = bookData?.lastUpdatedAt || nowISO;
              }
            }
          }
        }

        writeDB(db);

        res.setHeader("Cache-Control","no-store");
        res.json({
          ok:true,
          leagueID,
          events: events.length,
          totalProps,
          savedMirroredRows: saved,
          note: "Props saved to db.sgoPropLines; also mirrored into hardrockPropLines for edges endpoints."
        });
      }catch(e){
        res.status(400).json({ ok:false, error:String(e.message||e) });
      }
    });

    // Inspect saved SGO props
    app.get("/api/odds/sgo/props", (req,res)=>{
      const eventId = String(req.query.eventId||"").trim();
      const player = String(req.query.player||"").trim().toLowerCase();
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit||500)));

      const db = readDB();
      let rows = (db.sgoPropLines||[]);
      if(eventId) rows = rows.filter(r=>String(r.eventId)===eventId);
      if(player) rows = rows.filter(r=>String(r.player||"").toLowerCase().includes(player));
      rows = rows.slice(0, limit);

      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, eventId: eventId||null, count: rows.length, rows });
    });

    console.log("[patch] SGO props endpoints ready: POST /api/odds/sgo/pull  GET /api/odds/sgo/props ✅");
  }catch(_e){}
})();

/* ===================== PT PATCH: SGO PROPS + GAME LABEL MAP =====================

1) Adds: GET /api/games-map      -> eventId => label (Away @ Home)
2) Adds: POST /api/odds/sgo/pull -> pulls NBA props from SportsGameOdds, stores in DB
3) Adds: GET /api/odds/sgo/props -> reads stored props from DB
4) Adds: daily auto-pull (once per day) + interval safety (every 10 min tries, but only runs once/day)

Requires .env:
  SPORTSGAMEODDS_KEY=YOUR_KEY_HERE

Docs: /events endpoint returns odds keyed by oddID with statID/playerID/byBookmaker/bookOverUnder/etc.
=============================================================================== */

(function PT_SGO_PATCH(){
  // ---- small helpers ----
  const __TZ = "America/New_York";
  const __SGO_BASE = "https://sportsgameodds.com"; // docs site; actual API host can differ in your existing code
  // Many customers use api.sportsgameodds.com; fallback to this if you already used it elsewhere.
  const __SGO_API = process.env.SPORTSGAMEODDS_API_BASE || "https://api.sportsgameodds.com";

  function ymdET(d){
    // "today" in ET so your daily run matches your edges-today ET logic
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: __TZ, year:"numeric", month:"2-digit", day:"2-digit"
    });
    return fmt.format(d); // YYYY-MM-DD
  }

  function toNum(x){
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function pickBookmaker(byBookmaker){
    // Prefer DraftKings-ish keys if present, else first available.
    if(!byBookmaker || typeof byBookmaker !== "object") return null;
    const prefer = ["draftkings", "dk", "draft_kings", "draftKings"];
    for(const k of prefer){
      if(byBookmaker[k]) return { key:k, v:byBookmaker[k] };
    }
    const keys = Object.keys(byBookmaker);
    if(!keys.length) return null;
    return { key: keys[0], v: byBookmaker[keys[0]] };
  }

  function nameFromMarket(marketName, playerID){
    // Try to extract player name from marketName like "Anthony Edwards Points O/U (Game)" etc.
    if(typeof marketName === "string" && marketName.trim()){
      // common: "<NAME> To Record ..." or "<NAME> Points ..." or "<NAME> (something)"
      let s = marketName.trim();
      // remove trailing parentheses chunk if it exists
      s = s.replace(/\s*\(.*?\)\s*$/,"").trim();
      // if " To " exists, take left side
      const idxTo = s.indexOf(" To ");
      if(idxTo > 2) return s.slice(0, idxTo).trim();
      // if " - " exists
      const idxDash = s.indexOf(" - ");
      if(idxDash > 2) return s.slice(0, idxDash).trim();
      // if " Points" etc appears, take left side
      const m = s.match(/^(.+?)\s+(Points|Rebounds|Assists|3PM|Threes|Steals|Blocks|PRA|PR|PA)\b/i);
      if(m && m[1]) return m[1].trim();
    }
    return playerID || "—";
  }

  // ---- game label map from your db.games ----
  // You already have /api/game-picker. This gives a fuller map for any eventId in DB.
  try{
    app.get("/api/games-map", (req,res)=>{
      const db = readDB();
      const out = {};
      for(const g of (db.games||[])){
        const eid = g.extId || g.eventId || g.id || null;
        if(!eid) continue;

        // best label:
        // 1) existing g.label if present
        // 2) build from team names if you stored them
        // 3) fallback "eventId ####"
        let label = g.label || "";
        if(!label){
          const away = g.away || g.awayTeam || g.teamAway || "";
          const home = g.home || g.homeTeam || g.teamHome || "";
          if(away && home) label = `${away} @ ${home}`;
        }
        if(!label) label = `eventId ${eid}`;

        out[String(eid)] = {
          eventId: String(eid),
          label,
          startTime: g.startTime || null,
          league: g.league || null
        };
      }
      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, count:Object.keys(out).length, map: out });
    });
  }catch(e){ /* ignore if app not in scope */ }

  // ---- SGO pull/store ----
  async function sgoFetch(path, params){
    const key = (process.env.SPORTSGAMEODDS_KEY || "").trim();
    if(!key) throw new Error("Missing SPORTSGAMEODDS_KEY in .env");

    const url = new URL(__SGO_API + path);
    // SportsGameOdds uses apiKey query param commonly
    url.searchParams.set("apiKey", key);
    for(const [k,v] of Object.entries(params||{})){
      if(v==null) continue;
      url.searchParams.set(k, String(v));
    }

    const r = await fetch(url.toString(), { headers: { "accept":"application/json" } });
    const text = await r.text();
    let json = null;
    try{ json = JSON.parse(text); }catch(_){}
    if(!r.ok){
      const head = text.slice(0,400);
      const err = new Error(`SGO fetch failed (${r.status})`);
      err.status = r.status;
      err.head = head;
      throw err;
    }
    return json;
  }

  function extractPropsFromEvent(ev){
    // ev.odds is an object keyed by oddID -> odd
    // odd has: oddID, opposingOddID, marketName, statID, playerID, bookOverUnder, byBookmaker, etc.
    const oddsObj = ev?.odds;
    if(!oddsObj || typeof oddsObj !== "object") return [];

    const out = [];
    const seen = new Set();

    const entries = Object.entries(oddsObj);
    for(const [oddKey, odd] of entries){
      if(!odd || typeof odd !== "object") continue;

      // only player-ish odds (playerID present)
      const playerID = odd.playerID || null;
      if(!playerID) continue;

      const oddID = odd.oddID || oddKey;
      if(seen.has(oddID)) continue;

      const opp = odd.opposingOddID || null;
      const isOver = /-over$/i.test(oddID);
      const isUnder = /-under$/i.test(oddID);

      // Try to pair over/under into ONE row when possible:
      if(isUnder && opp && /-over$/i.test(opp)){
        // wait for the "-over" pass to handle it
        continue;
      }

      let overOdd = null, underOdd = null;
      let line = null;
      let book = null;

      // pick bookmaker odds from this odd
      const pickA = pickBookmaker(odd.byBookmaker);
      if(pickA){
        book = pickA.key;
        // for O/U markets, bookmaker object includes odds + overUnder
        if(pickA.v){
          if(pickA.v.overUnder != null) line = toNum(pickA.v.overUnder);
          if(pickA.v.odds != null){
            if(isUnder) underOdd = pickA.v.odds;
            else overOdd = pickA.v.odds;
          }
        }
      }
      // fallback to top-level bookOverUnder
      if(line == null && odd.bookOverUnder != null) line = toNum(odd.bookOverUnder);

      // if we can find opposing odd and same bookmaker, use it too
      if(opp && oddsObj[opp]){
        const o2 = oddsObj[opp];
        const pickB = pickBookmaker(o2.byBookmaker);
        if(pickB){
          if(!book) book = pickB.key;
          if(line == null && pickB.v?.overUnder != null) line = toNum(pickB.v.overUnder);
          if(pickB.v?.odds != null){
            if(/-under$/i.test(opp)) underOdd = pickB.v.odds;
            if(/-over$/i.test(opp)) overOdd = pickB.v.odds;
          }
        }
        if(line == null && o2.bookOverUnder != null) line = toNum(o2.bookOverUnder);
        seen.add(opp);
      }

      const marketName = odd.marketName || "";
      const playerName = nameFromMarket(marketName, playerID);

      out.push({
        eventId: String(ev.eventID || ev.eventId || ""),
        league: "NBA",
        source: "sportsgameodds",
        bookmaker: book || null,
        player: playerName,
        playerId: String(playerID),
        stat: String(odd.statID || odd.statId || "UNKNOWN"),
        market: marketName || null,
        line,
        overOdds: overOdd,
        underOdds: underOdd,
        updatedAt: new Date().toISOString()
      });

      seen.add(oddID);
    }
    return out;
  }

  async function pullSgoNbaProps({ limitEvents=60, daysAhead=1 } = {}){
    const now = new Date();
    const today = ymdET(now);
    // window in ISO (SGO supports startsAfter/startsBefore)
    // Use ET day boundaries but send as ISO-ish date strings.
    const startsAfter = today; // many APIs accept YYYY-MM-DD
    const end = new Date(now); end.setDate(end.getDate() + Math.max(0, Number(daysAhead)||0));
    const startsBefore = ymdET(end);

    // leagueID for NBA (SGO uses IDs; if your key expects numeric leagueID, swap here)
    // We’ll try common patterns: "NBA" works in many SGO examples; if your account uses numeric IDs, set SGO_NBA_LEAGUEID in .env.
    const leagueID = (process.env.SGO_NBA_LEAGUEID || "NBA").trim();

    const payload = await sgoFetch("/v2/events", {
      leagueID,
      oddsAvailable: "true",
      startsAfter,
      startsBefore,
      limit: String(limitEvents)
    });

    const events = payload?.data || payload?.events || payload || [];
    const db = readDB();
    db.sgoPropLines ||= [];

    let added = 0;
    let scannedEvents = 0;

    // Replace by key (eventId+playerId+stat+line+bookmaker)
    const key = (r)=>`${r.eventId}|${r.playerId}|${r.stat}|${r.line}|${r.bookmaker||""}`;
    const existing = new Map(db.sgoPropLines.map(r=>[key(r), r]));

    for(const ev of events){
      scannedEvents++;
      const evId = String(ev?.eventID || ev?.eventId || "");
      if(!evId) continue;

      const props = extractPropsFromEvent(ev);
      for(const p of props){
        if(!p.eventId) p.eventId = evId;
        existing.set(key(p), p);
      }
    }

    const next = Array.from(existing.values());
    // keep DB from exploding: keep last ~10 days of SGO props by updatedAt
    const cutoff = Date.now() - 10*24*60*60*1000;
    db.sgoPropLines = next.filter(r=>{
      const t = Date.parse(r.updatedAt||"");
      return !Number.isFinite(t) || t >= cutoff;
    });

    writeDB(db);
    added = db.sgoPropLines.length;

    return { ok:true, scannedEvents, stored: added, startsAfter, startsBefore, leagueID };
  }

  // endpoint: manual pull
  try{
    app.post("/api/odds/sgo/pull", express.json({limit:"1mb"}), async (req,res)=>{
      try{
        const body = req.body || {};
        const limitEvents = Number(body.limitEvents ?? body.limit ?? 60);
        const daysAhead = Number(body.daysAhead ?? 1);
        const result = await pullSgoNbaProps({ limitEvents, daysAhead });
        res.setHeader("Cache-Control","no-store");
        res.json(result);
      }catch(e){
        res.status(500).json({ ok:false, error:String(e.message||e), status:e.status||null, head:e.head||null });
      }
    });

    // endpoint: read stored props (optional filters)
    app.get("/api/odds/sgo/props", (req,res)=>{
      const db = readDB();
      const eventId = String(req.query.eventId||"").trim();
      const player = String(req.query.player||"").trim().toLowerCase();
      const stat = String(req.query.stat||"").trim();
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit||500)));

      let rows = (db.sgoPropLines||[]);
      if(eventId) rows = rows.filter(r=>String(r.eventId)===eventId);
      if(player) rows = rows.filter(r=>String(r.player||"").toLowerCase().includes(player));
      if(stat) rows = rows.filter(r=>String(r.stat||"")===stat);

      rows = rows.slice().sort((a,b)=> String(a.player||"").localeCompare(String(b.player||"")) || String(a.stat||"").localeCompare(String(b.stat||"")));
      res.setHeader("Cache-Control","no-store");
      res.json({ ok:true, count: rows.length, rows: rows.slice(0, limit) });
    });
  }catch(e){ /* ignore */ }

  // ---- daily auto pull ----
  let __lastSgoPullDayET = null;
  async function __autoSgoDaily(){
    try{
      const day = ymdET(new Date());
      if(__lastSgoPullDayET === day) return;
      __lastSgoPullDayET = day;
      await pullSgoNbaProps({ limitEvents: 80, daysAhead: 1 });
      console.log("[auto] SGO props pulled:", day);
    }catch(e){
      console.log("[auto] SGO props pull failed:", String(e.message||e));
    }
  }

  // run shortly after start + then every 10 minutes (but only once/day due to guard)
  setTimeout(__autoSgoDaily, 3000);
  setInterval(__autoSgoDaily, 10*60*1000);

  console.log("[patch] SGO props patch loaded ✅  (POST /api/odds/sgo/pull, GET /api/odds/sgo/props, GET /api/games-map)");
})();

/* ===== PT PATCH: games-map + daily SGO props auto-pull ===== */
(function PT_GAMESMAP_AND_SGO_AUTOPULL(){
  try{
    // --- Helpers ---
    function escStr(x){ return (x==null) ? "" : String(x); }

    function etDateISO(d=new Date()){
      // America/New_York date (no external libs)
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(d);
      const y = parts.find(p=>p.type==="year")?.value;
      const m = parts.find(p=>p.type==="month")?.value;
      const da = parts.find(p=>p.type==="day")?.value;
      return `${y}-${m}-${da}`;
    }

    // Build eventId -> matchup map from db.games + db.teams
    function buildGamesMap(db){
      const teamsById = new Map((db.teams||[]).map(t=>[t.id, t.name || t.displayName || t.abbrev || t.id]));
      const out = {};
      for(const g of (db.games||[])){
        const eid = g.extId || g.eventId || g.id;
        if(!eid) continue;

        const away = (g.awayTeam?.name) || teamsById.get(g.awayTeamId) || g.awayTeamId || "Away";
        const home = (g.homeTeam?.name) || teamsById.get(g.homeTeamId) || g.homeTeamId || "Home";
        const matchup = `${away} @ ${home}`;

        out[String(eid)] = {
          eventId: String(eid),
          league: g.league || "NBA",
          startTime: g.startTime || null,
          matchup,
          awayTeam: away,
          homeTeam: home
        };
      }
      return out;
    }

    // --- 1) Add /api/games-map (for frontend to label eventIds) ---
    if(typeof app !== "undefined" && typeof readDB === "function"){
      // only register once
      const __pt_has_games_map = app?._router?.stack?.some?.(r=>r?.route?.path==="/api/games-map");
      if(!__pt_has_games_map){
        app.get("/api/games-map",(req,res)=>{
          const db = readDB();
          const map = buildGamesMap(db);
          res.setHeader("Cache-Control","no-store");
          res.json({ ok:true, count:Object.keys(map).length, map });
        });
        console.log("[patch] /api/games-map added ✅");
      }
    }

    // --- 2) Auto-pull Sportsgameodds props once per ET day ---
    // Requires: SPORTSGAMEODDS_KEY in .env
    // This calls YOUR existing endpoint: POST /api/odds/sgo/pull
    let __pt_last_sgo_pull_day = null;
    async function __pt_try_sgo_autopull(){
      try{
        const todayET = etDateISO(new Date());
        if(__pt_last_sgo_pull_day === todayET) return;

        // only run if server has the endpoint
        // (don’t hard-crash if it’s missing)
        const url = `http://127.0.0.1:${process.env.PORT || 3000}/api/odds/sgo/pull`;
        const r = await fetch(url, {
          method:"POST",
          headers:{ "content-type":"application/json" },
          body: JSON.stringify({ limit: 50 }) // bump if you want more events per run
        });

        // mark day as pulled even if API says "missing key" to avoid hammering
        __pt_last_sgo_pull_day = todayET;

        const txt = await r.text();
        console.log(`[auto] SGO pull (${todayET}) status=${r.status} head=${txt.slice(0,140).replace(/\s+/g," ")}`);
      }catch(e){
        // don't spam; try again next interval
        console.log("[auto] SGO pull failed:", String(e?.message||e));
      }
    }

    // run soon after boot + then every 10 minutes
    setTimeout(__pt_try_sgo_autopull, 3500);
    setInterval(__pt_try_sgo_autopull, 10*60*1000);

    console.log("[patch] SGO daily auto-pull armed ✅ (needs SPORTSGAMEODDS_KEY in .env)");
  }catch(e){
    console.log("[patch] games-map/autopull patch failed:", String(e?.message||e));
  }
})();

/* ===== PT: GAME MAP (eventId -> teams) ===== */

app.get("/api/games-map", async (req,res)=>{
  try{
    const games = (readDB().games || []);

    const map = {};

    for(const g of games){
      if(!g.eventId) continue;

      map[g.eventId] = {
        eventId: g.eventId,
        label: g.label || "",
        startTime: g.startTime || null
      };
    }

    res.json({ ok:true, count:Object.keys(map).length, map });
  }catch(e){
    res.json({ ok:false, error:String(e) });
  }
});

console.log("[patch] games-map endpoint loaded ✅");

/* ===== PT PATCH: human game labels + daily SGO props pull ===== */
(() => {
  try {
    if (typeof app === "undefined") {
      console.log("[patch] games-map/SGO patch: app not found (skip)");
      return;
    }

    // ---------- A) Better games-map labels ----------
    // Infer matchup label from your existing NBA player stats table (eventId -> 2 teams)
    // Uses the same shape returned by /api/nba/stats/players (eventId, team, ...)
    function inferTeamsFromPlayerStats(eventId) {
      try {
        const tableNames = [
          "nbaPlayerGameStats",
          "nbaPlayerStats",
          "nbaStatsPlayers",
          "playerStatsNBA",
        ];

        let rows = null;

        // db might be an object with arrays OR a lowdb-like object OR something custom.
        // We try a few common patterns defensively.
        for (const t of tableNames) {
          if (rows) break;

          // Pattern 1: db[t] is an array
          if (typeof db !== "undefined" && Array.isArray(db[t])) {
            rows = db[t];
            break;
          }

          // Pattern 2: db.data[t] is an array (lowdb)
          if (typeof db !== "undefined" && db && db.data && Array.isArray(db.data[t])) {
            rows = db.data[t];
            break;
          }
        }

        if (!Array.isArray(rows)) return null;

        // Only rows matching this eventId
        const teams = new Map(); // team -> count
        for (const r of rows) {
          if (!r) continue;
          if (String(r.eventId || "") !== String(eventId)) continue;

          const team = (r.team || "").trim();
          if (!team) continue;

          teams.set(team, (teams.get(team) || 0) + 1);
        }

        if (teams.size < 2) return null;

        // Pick top 2 teams by frequency (most players recorded)
        const top2 = [...teams.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([team]) => team);

        if (top2.length < 2) return null;

        return top2; // [teamA, teamB]
      } catch {
        return null;
      }
    }

    // Override /api/games-map to include better labels but keep the ID
    // NOTE: Express keeps both handlers if we just add another; we want to REPLACE behavior,
    // so we serve a new endpoint and also try to patch the old one if route exists.
    // Easiest stable move: create /api/games-map2 and then your UI can call it.
    app.get("/api/games-map2", (req, res) => {
      try {
        // Reuse the existing map builder if it exists on global
        // else fall back to your existing endpoint logic by calling it (if available).
        // If you already have a games map in memory, use it.
        let base = null;

        // common places the map might live
        if (typeof getGamesMap === "function") base = getGamesMap();
        if (!base && typeof gamesMap !== "undefined") base = gamesMap;
        if (!base && typeof db !== "undefined") {
          // if you have a db table of games, you can build from that later
          base = null;
        }

        // If we can't access your in-memory map, just return a lightweight map inferred from stats.
        // But if you CAN access the old map, we’ll enhance it.
        if (!base || typeof base !== "object") base = {};

        const map = {};
        const keys = Object.keys(base);
        for (const eventId of keys) {
          const g = base[eventId] || {};
          const inferred = inferTeamsFromPlayerStats(eventId);

          let label = g.label || `eventId ${eventId}`;
          if (inferred && inferred.length === 2) {
            // "Team A vs Team B" but keep id in label too
            label = `${inferred[0]} vs ${inferred[1]} (eventId ${eventId})`;
          } else if (!label || label.startsWith("eventId ")) {
            label = `eventId ${eventId}`;
          }

          map[eventId] = {
            ...g,
            eventId: String(eventId),
            label,
          };
        }

        // If base map had no keys (empty), still try to infer from stats by scanning rows quickly
        if (keys.length === 0) {
          // attempt to scan any known stats arrays and build eventIds
          const eventIds = new Set();
          const tables = ["nbaPlayerGameStats", "nbaPlayerStats", "nbaStatsPlayers", "playerStatsNBA"];
          for (const t of tables) {
            const rows =
              (typeof db !== "undefined" && Array.isArray(db[t]) && db[t]) ||
              (typeof db !== "undefined" && db && db.data && Array.isArray(db.data[t]) && db.data[t]) ||
              null;
            if (!rows) continue;
            for (const r of rows) {
              if (r && r.eventId) eventIds.add(String(r.eventId));
            }
          }

          for (const eventId of eventIds) {
            const inferred = inferTeamsFromPlayerStats(eventId);
            const label =
              inferred && inferred.length === 2
                ? `${inferred[0]} vs ${inferred[1]} (eventId ${eventId})`
                : `eventId ${eventId}`;
            map[eventId] = { eventId, label, league: null, startTime: null };
          }
        }

        res.json({ ok: true, count: Object.keys(map).length, map });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    console.log("[patch] games-map2 ready: GET /api/games-map2 ✅");

    // ---------- B) Daily automatic SGO props pull ----------
    // Uses your existing endpoint so we don't need to know internal function names.
    // Requires SPORTSGAMEODDS_KEY in .env (you already set that).
    async function pullSgoPropsOnce() {
      try {
        const r = await fetch("http://127.0.0.1:3000/api/odds/sgo/pull", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const text = await r.text();
        console.log(`[patch] SGO daily pull: status=${r.status} body=${text.slice(0, 200)}...`);
      } catch (e) {
        console.log("[patch] SGO daily pull failed:", String(e?.message || e));
      }
    }

    function msUntilNextET(hour, minute) {
      // schedule in America/New_York by using Intl formatting and reconstructing a Date
      // (good enough for daily scheduling in Termux)
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(now);

      const get = (t) => parts.find((p) => p.type === t)?.value;
      const y = Number(get("year"));
      const m = Number(get("month"));
      const d = Number(get("day"));

      // Create a "target ET" date by starting from local date y-m-d and adding 1 day if already passed.
      // We'll approximate by comparing formatted ET time.
      const hh = Number(get("hour"));
      const mm = Number(get("minute"));

      let target = new Date(now.getTime());
      // move target to today's ET date
      // (we just compute delta based on whether we're past hour/min)
      const past = hh > hour || (hh === hour && mm >= minute);
      if (past) target = new Date(target.getTime() + 24 * 60 * 60 * 1000);

      // set target's ET clock by brute forcing: schedule delay = (targetET - nowET) using minutes
      // compute minutes-from-midnight in ET
      const nowETmins = hh * 60 + mm;
      const targetETmins = hour * 60 + minute;
      let deltaMins = targetETmins - nowETmins;
      if (deltaMins <= 0) deltaMins += 24 * 60;

      return deltaMins * 60 * 1000;
    }

    // Run once shortly after startup, then schedule daily at 6:05 AM ET
    setTimeout(() => {
      pullSgoPropsOnce();
    }, 15 * 1000);

    setTimeout(() => {
      pullSgoPropsOnce();
      setInterval(pullSgoPropsOnce, 24 * 60 * 60 * 1000);
    }, msUntilNextET(6, 5));

    console.log("[patch] SGO daily pull scheduled (6:05 AM ET) ✅");
  } catch (e) {
    console.log("[patch] games-map/SGO patch error:", String(e?.message || e));
  }
})();

/* ===== PT PATCH: AUTO TEAM LABELS FOR EVENT IDS ===== */
/* paste-at-bottom safe patch */

function PT_inferTeamsFromAnyStats(eventId) {
  try {
    const eid = String(eventId);

    const candidates = [];

    const scan = (root) => {
      if (!root || typeof root !== "object") return;
      for (const [k, v] of Object.entries(root)) {
        if (Array.isArray(v) && v.length) {
          candidates.push({ name: k, rows: v });
        }
      }
    };

    if (typeof db !== "undefined") {
      scan(db);
      if (db.data) scan(db.data);
    }

    let best = null;
    let bestScore = 0;

    for (const t of candidates) {
      let score = 0;
      const sample = t.rows.slice(0, 200);

      for (const r of sample) {
        if (!r || typeof r !== "object") continue;
        if ("eventId" in r) score++;
        if ("team" in r) score++;
        if ("player" in r) score++;
      }

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }

    if (!best) return null;

    const teams = new Map();

    for (const r of best.rows) {
      if (!r) continue;
      if (String(r.eventId || "") !== eid) continue;

      const team = String(r.team || "").trim();
      if (!team) continue;

      teams.set(team, (teams.get(team) || 0) + 1);
    }

    if (teams.size < 2) return null;

    const top2 = [...teams.entries()]
      .sort((a,b)=>b[1]-a[1])
      .slice(0,2)
      .map(([t]) => t);

    return top2.length === 2 ? top2 : null;

  } catch {
    return null;
  }
}


/* override games-map2 endpoint safely */
try {
  app.get("/api/games-map2", (req, res) => {
    const map = {};

    if (!globalThis.gamesMap) {
      return res.json({ ok:true, count:0, map:{} });
    }

    for (const [eventId, g] of Object.entries(globalThis.gamesMap)) {
      const teams = PT_inferTeamsFromAnyStats(eventId);

      let label = g.label || `eventId ${eventId}`;

      if (teams && teams.length === 2) {
        label = `${teams[0]} vs ${teams[1]} (eventId ${eventId})`;
      }

      map[eventId] = {
        ...g,
        label
      };
    }

    res.json({
      ok: true,
      count: Object.keys(map).length,
      map
    });
  });

  console.log("[patch] games-map2 team labels enabled ✅");

} catch(e) {
  console.log("[patch] games-map2 patch failed", e.message);
}

/* ===== PT PATCH v2: FIND THE REAL gamesMap + FIX games-map2 ===== */

function PT_findGamesMap() {
  // Try common places this project might store the map.
  // Returns { src, map } or null.
  try {
    // 1) module-scope variable (most likely)
    if (typeof gamesMap !== "undefined" && gamesMap && typeof gamesMap === "object") {
      return { src: "module:gamesMap", map: gamesMap };
    }
  } catch {}

  try {
    // 2) globals
    if (globalThis.gamesMap && typeof globalThis.gamesMap === "object") {
      return { src: "globalThis.gamesMap", map: globalThis.gamesMap };
    }
  } catch {}

  try {
    // 3) app locals
    if (typeof app !== "undefined" && app && app.locals && app.locals.gamesMap) {
      return { src: "app.locals.gamesMap", map: app.locals.gamesMap };
    }
  } catch {}

  try {
    // 4) db containers
    if (typeof db !== "undefined" && db) {
      if (db.gamesMap && typeof db.gamesMap === "object") return { src: "db.gamesMap", map: db.gamesMap };
      if (db.data && db.data.gamesMap && typeof db.data.gamesMap === "object") return { src: "db.data.gamesMap", map: db.data.gamesMap };
    }
  } catch {}

  return null;
}

try {
  // DEBUG: see what we found
  app.get("/api/games-map2-debug", (req, res) => {
    const found = PT_findGamesMap();
    const keys = found?.map ? Object.keys(found.map).slice(0, 30) : [];
    res.json({
      ok: true,
      found: !!found,
      src: found?.src || null,
      sampleKeys: keys,
      sampleCount: found?.map ? Object.keys(found.map).length : 0,
    });
  });

  // OVERRIDE games-map2 to use the correct map source
  app.get("/api/games-map2", (req, res) => {
    const found = PT_findGamesMap();
    if (!found || !found.map) return res.json({ ok: true, count: 0, map: {} });

    const srcMap = found.map;
    const out = {};

    for (const [eventId, g] of Object.entries(srcMap)) {
      const teams = PT_inferTeamsFromAnyStats(eventId);
      let label = g?.label || `eventId ${eventId}`;

      if (teams && teams.length === 2) {
        label = `${teams[0]} vs ${teams[1]} (eventId ${eventId})`;
      } else if (g?.home && g?.away) {
        // if map already has home/away fields
        label = `${g.away} @ ${g.home} (eventId ${eventId})`;
      }

      out[eventId] = { ...(g || {}), eventId: String(eventId), label };
    }

    res.json({ ok: true, src: found.src, count: Object.keys(out).length, map: out });
  });

  console.log("[patch] games-map2 v2 loaded ✅ (auto-detect map source)");

} catch (e) {
  console.log("[patch] games-map2 v2 failed:", e.message);
}

/* ===== PT PATCH v3: games-map2 built from /api/games-map (no hidden vars needed) ===== */

async function PT_getJSON(url) {
  // Node 24 has fetch built-in
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  const txt = await r.text();
  let data = null;
  try { data = JSON.parse(txt); } catch {}
  return { ok: r.ok, status: r.status, text: txt, json: data };
}

try {
  // debug: show if /api/games-map is reachable + sample keys
  app.get("/api/games-map2-debug", async (req, res) => {
    const base = `http://127.0.0.1:${PORT || 3000}`;
    const r = await PT_getJSON(`${base}/api/games-map`);
    const map = r.json?.map || {};
    const keys = Object.keys(map).slice(0, 30);
    res.json({
      ok: true,
      base,
      gamesMapOK: !!r.json?.ok,
      status: r.status,
      count: Object.keys(map).length,
      sampleKeys: keys,
      head: (r.text || "").slice(0, 220),
    });
  });

  // override: generate games-map2 by reading /api/games-map then adding team labels
  app.get("/api/games-map2", async (req, res) => {
    const base = `http://127.0.0.1:${PORT || 3000}`;
    const r = await PT_getJSON(`${base}/api/games-map`);
    const srcMap = r.json?.map || {};
    const out = {};

    for (const [eventId, g] of Object.entries(srcMap)) {
      const teams = PT_inferTeamsFromAnyStats(eventId); // your existing helper from earlier patch
      let label = g?.label || `eventId ${eventId}`;

      if (teams && teams.length === 2) {
        label = `${teams[0]} vs ${teams[1]} (eventId ${eventId})`;
      } else if (g?.home && g?.away) {
        label = `${g.away} @ ${g.home} (eventId ${eventId})`;
      }

      out[eventId] = { ...(g || {}), eventId: String(eventId), label };
    }

    res.json({
      ok: true,
      src: "/api/games-map",
      srcCount: Object.keys(srcMap).length,
      count: Object.keys(out).length,
      map: out
    });
  });

  console.log("[patch] games-map2 v3 loaded ✅ (builds from /api/games-map)");

} catch (e) {
  console.log("[patch] games-map2 v3 failed:", e?.message || e);
}

/* ===== PT: HARD OVERRIDE games-map2 routes (v4) ===== */
(() => {
  try {
    // run once
    if (global.__PT_GAMESMAP2_V4__) return;
    global.__PT_GAMESMAP2_V4__ = true;

    if (typeof app === "undefined" || !app?._router?.stack) {
      console.log("[patch] games-map2 v4 skipped (app router not ready)");
      return;
    }

    // Remove any previously-registered GET handlers for these paths
    const dropGetRoute = (path) => {
      const stack = app._router.stack;
      if (!Array.isArray(stack)) return;
      app._router.stack = stack.filter((layer) => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods || !layer.route.methods.get) return true;
        return false; // drop it
      });
    };

    dropGetRoute("/api/games-map2");
    dropGetRoute("/api/games-map2-debug");

    // Try to find the NBA player stat rows already in memory
    const getPlayerRows = () => {
      const candidates = [
        "nbaPlayerStats",
        "nbaStatsPlayers",
        "nbaPlayers",
        "playerStats",
      ];

      for (const k of candidates) {
        if (Array.isArray(global.db?.[k])) return global.db[k];
        if (Array.isArray(global.db?.data?.[k])) return global.db.data[k];
        if (Array.isArray(db?.[k])) return db[k];
        if (Array.isArray(db?.data?.[k])) return db.data[k];
      }
      return [];
    };

    // Build map keyed by eventId using teams seen in player stats for that eventId
    const buildMap = () => {
      const rows = getPlayerRows();
      const byEvent = new Map();

      for (const r of rows) {
        const eid = String(r?.eventId ?? "").trim();
        if (!eid) continue;

        const team = String(r?.team ?? "").trim();
        if (!byEvent.has(eid)) byEvent.set(eid, new Set());
        if (team) byEvent.get(eid).add(team);
      }

      const map = {};
      for (const [eventId, set] of byEvent.entries()) {
        const teams = [...set].filter(Boolean).slice(0, 4);
        let label = `eventId ${eventId}`;

        if (teams.length >= 2) label = `${teams[0]} vs ${teams[1]}`;
        else if (teams.length === 1) label = teams[0];

        map[eventId] = { eventId, label, teams };
      }

      return map;
    };

    app.get("/api/games-map2-debug", (req, res) => {
      const map = buildMap();
      const keys = Object.keys(map);
      res.json({
        ok: true,
        src: "teams-from-nba-player-stats",
        count: keys.length,
        sampleKeys: keys.slice(0, 30),
        sample: keys.slice(0, 5).map((k) => map[k]),
      });
    });

    app.get("/api/games-map2", (req, res) => {
      const map = buildMap();
      res.json({ ok: true, count: Object.keys(map).length, map });
    });

    console.log("[patch] games-map2 hard override v4 ✅");
  } catch (e) {
    console.log("[patch] games-map2 v4 error:", e?.message || e);
  }
})();

/* ===== PT: HARD OVERRIDE games-map2 routes (v5 - no db refs) ===== */
(() => {
  try {
    if (global.__PT_GAMESMAP2_V5__) return;
    global.__PT_GAMESMAP2_V5__ = true;

    const appRef = global.app || globalThis.app;
    if (!appRef || !appRef._router || !Array.isArray(appRef._router.stack)) {
      console.log("[patch] games-map2 v5 skipped (app router not ready)");
      return;
    }

    // Remove any previously-registered GET handlers for these paths
    const dropGetRoute = (path) => {
      const stack = appRef._router.stack;
      appRef._router.stack = stack.filter((layer) => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods || !layer.route.methods.get) return true;
        return false;
      });
    };

    dropGetRoute("/api/games-map2");
    dropGetRoute("/api/games-map2-debug");

    const safeArr = (x) => (Array.isArray(x) ? x : []);

    // Find player stat rows from ONLY global.db (no "db" variable)
    const getPlayerRows = () => {
      const gdb = global.db || globalThis.db || null;
      if (!gdb) return [];

      const candidates = [
        "nbaPlayerStats",
        "nbaStatsPlayers",
        "nbaPlayers",
        "playerStats",
        "players",
      ];

      for (const k of candidates) {
        if (Array.isArray(gdb[k])) return gdb[k];
        if (gdb.data && Array.isArray(gdb.data[k])) return gdb.data[k];
      }

      // last-ditch: scan top-level arrays for objects with eventId+team+player
      for (const [k, v] of Object.entries(gdb)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object") {
          const sample = v[0] || {};
          if ("eventId" in sample && ("team" in sample || "player" in sample)) return v;
        }
      }

      return [];
    };

    const buildMap = () => {
      const rows = safeArr(getPlayerRows());
      const byEvent = new Map();

      for (const r of rows) {
        const eid = String(r?.eventId ?? "").trim();
        if (!eid) continue;

        const team = String(r?.team ?? "").trim();
        if (!byEvent.has(eid)) byEvent.set(eid, new Set());
        if (team) byEvent.get(eid).add(team);
      }

      const map = {};
      for (const [eventId, set] of byEvent.entries()) {
        const teams = [...set].filter(Boolean).slice(0, 4);
        let label = `eventId ${eventId}`;
        if (teams.length >= 2) label = `${teams[0]} vs ${teams[1]}`;
        else if (teams.length === 1) label = teams[0];
        map[eventId] = { eventId, label, teams };
      }

      return map;
    };

    appRef.get("/api/games-map2-debug", (req, res) => {
      const map = buildMap();
      const keys = Object.keys(map);
      res.json({
        ok: true,
        src: "teams-from-player-stats",
        count: keys.length,
        sampleKeys: keys.slice(0, 30),
        sample: keys.slice(0, 5).map((k) => map[k]),
      });
    });

    appRef.get("/api/games-map2", (req, res) => {
      const map = buildMap();
      res.json({ ok: true, count: Object.keys(map).length, map });
    });

    console.log("[patch] games-map2 hard override v5 ✅");
  } catch (e) {
    console.log("[patch] games-map2 v5 error:", e?.stack || e?.message || e);
  }
})();

/* ===== PT PATCH: games-map2 bottom safety fix ===== */

try {

  // ensure db exists in this scope
  const db = global.db || globalThis.db || {};

  function getPlayerRowsSafe(){
    if (db.playerGameStats && Array.isArray(db.playerGameStats))
      return db.playerGameStats;

    if (db.nbaPlayerStats && Array.isArray(db.nbaPlayerStats))
      return db.nbaPlayerStats;

    return [];
  }

  app.get("/api/games-map2", (req,res)=>{
    try {
      const rows = getPlayerRowsSafe();
      const map = {};

      for(const r of rows){
        if(!r.eventId) continue;
        if(!map[r.eventId]){
          map[r.eventId] = {
            eventId: r.eventId,
            teams: r.team || null
          };
        }
      }

      res.json({ ok:true, count:Object.keys(map).length, map });

    } catch(e){
      res.json({ ok:false, error:String(e) });
    }
  });

  app.get("/api/games-map2-debug", (req,res)=>{
    try {
      const rows = getPlayerRowsSafe();
      res.json({
        ok:true,
        found:true,
        sampleCount: rows.length,
        sampleKeys: rows[0] ? Object.keys(rows[0]) : []
      });
    } catch(e){
      res.json({ ok:false, error:String(e) });
    }
  });

  console.log("[patch] games-map2 bottom override loaded ✅");

} catch(e){
  console.log("[patch] games-map2 bottom override failed", e.message);
}

/* ===== PT PATCH: FORCE OVERRIDE games-map2 routes (remove old + re-add) ===== */

try {
  if (!globalThis.app) {
    console.log("[patch] games-map2 override: app not found");
  } else {
    const appRef = globalThis.app;

    const stripRoute = (path, method) => {
      try {
        const stack = appRef?._router?.stack;
        if (!Array.isArray(stack)) return 0;

        let removed = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
          const layer = stack[i];
          const route = layer && layer.route;
          if (!route) continue;

          const samePath = route.path === path;
          const hasMethod = route.methods && route.methods[method];
          if (samePath && hasMethod) {
            stack.splice(i, 1);
            removed++;
          }
        }
        return removed;
      } catch (e) {
        return 0;
      }
    };

    const removed1 = stripRoute("/api/games-map2", "get");
    const removed2 = stripRoute("/api/games-map2-debug", "get");
    console.log(`[patch] games-map2: removed old routes ✅ (games-map2=${removed1}, debug=${removed2})`);

    // SAFE db accessor
    const db =
      globalThis.db ||
      global.db ||
      globalThis.global?.db ||
      {};

    function getPlayerRowsSafe() {
      const candidates = [
        db.playerGameStats,
        db.nbaPlayerStats,
        db.players,
      ];
      for (const c of candidates) {
        if (Array.isArray(c)) return c;
      }
      return [];
    }

    // Re-add safe routes
    appRef.get("/api/games-map2", (req, res) => {
      try {
        const rows = getPlayerRowsSafe();
        const map = {};

        for (const r of rows) {
          if (!r || !r.eventId) continue;

          if (!map[r.eventId]) {
            map[r.eventId] = {
              eventId: r.eventId,
              label: r.team ? String(r.team) : `eventId ${r.eventId}`,
              startTime: r.dateISO ? String(r.dateISO) : null,
              league: r.league || "NBA",
            };
          }
        }

        res.json({ ok: true, count: Object.keys(map).length, map });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    appRef.get("/api/games-map2-debug", (req, res) => {
      try {
        const rows = getPlayerRowsSafe();
        res.json({
          ok: true,
          found: true,
          sampleCount: rows.length,
          sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map2 FORCE override loaded ✅");
  }
} catch (e) {
  console.log("[patch] games-map2 FORCE override failed ❌", e.message);
}

/* ===== PT PATCH v2: FORCE OVERRIDE games-map2 routes (use local `app`) ===== */

(() => {
  try {
    // Grab express app even if it isn't global
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map2 v2: app not found ❌");
      return;
    }

    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;

      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;

        const samePath = route.path === path;
        const hasMethod = route.methods && route.methods[method];
        if (samePath && hasMethod) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const removedA = stripRoute("/api/games-map2", "get");
    const removedB = stripRoute("/api/games-map2-debug", "get");
    console.log(`[patch] games-map2 v2: removed old routes ✅ (map2=${removedA}, debug=${removedB})`);

    // Safe DB handle (won't throw even if db isn't in scope)
    const dbRef =
      (typeof db !== "undefined" && db) ||
      globalThis.db ||
      global.db ||
      {};

    const getPlayerRowsSafe = () => {
      const candidates = [
        dbRef.playerGameStats,
        dbRef.nbaPlayerStats,
        dbRef.players,
      ];
      for (const c of candidates) if (Array.isArray(c)) return c;
      return [];
    };

    appRef.get("/api/games-map2-debug", (req, res) => {
      try {
        const rows = getPlayerRowsSafe();
        res.json({
          ok: true,
          found: true,
          sampleCount: rows.length,
          sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    appRef.get("/api/games-map2", (req, res) => {
      try {
        const rows = getPlayerRowsSafe();
        const map = {};

        for (const r of rows) {
          if (!r || !r.eventId) continue;

          if (!map[r.eventId]) {
            map[r.eventId] = {
              eventId: String(r.eventId),
              label: r.team ? String(r.team) : `eventId ${r.eventId}`,
              startTime: r.dateISO ? String(r.dateISO) : null,
              league: r.league || "NBA",
            };
          }
        }

        res.json({ ok: true, count: Object.keys(map).length, map });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map2 v2 FORCE override loaded ✅");
  } catch (e) {
    console.log("[patch] games-map2 v2 FORCE override failed ❌", e?.message || e);
  }
})();

/* ===== PT PATCH v3: games-map2 builds from /api/games-map (schedule), not player rows ===== */

(() => {
  try {
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map2 v3: app not found ❌");
      return;
    }

    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;

      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;

        const samePath = route.path === path;
        const hasMethod = route.methods && route.methods[method];
        if (samePath && hasMethod) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const removedA = stripRoute("/api/games-map2", "get");
    const removedB = stripRoute("/api/games-map2-debug", "get");
    console.log(`[patch] games-map2 v3: removed old routes ✅ (map2=${removedA}, debug=${removedB})`);

    // Helper: call your own server endpoint locally
    const http = require("http");

    const fetchLocalJSON = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: 3000, path, method: "GET" },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error("Bad JSON from " + path + ": " + body.slice(0, 200)));
              }
            });
          }
        );
        req.on("error", reject);
        req.end();
      });

    appRef.get("/api/games-map2-debug", async (req, res) => {
      try {
        const gm = await fetchLocalJSON("/api/games-map");
        const keys = gm && gm.map ? Object.keys(gm.map) : [];
        res.json({
          ok: true,
          src: "/api/games-map",
          gamesMapCount: keys.length,
          sample: keys.slice(0, 5).map((k) => gm.map[k]),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    appRef.get("/api/games-map2", async (req, res) => {
      try {
        const gm = await fetchLocalJSON("/api/games-map");
        const srcMap = (gm && gm.map) || {};
        const out = {};

        for (const [eventId, g] of Object.entries(srcMap)) {
          // Try to use real team names if your schedule object has them,
          // otherwise keep label fallback.
          const home = g.homeTeam || g.home || g.ht || null;
          const away = g.awayTeam || g.away || g.at || null;

          const pretty =
            home && away ? `${away} @ ${home}` :
            g.label ? String(g.label) :
            `eventId ${eventId}`;

          out[eventId] = {
            eventId: String(eventId),
            label: pretty,
            startTime: g.startTime || null,
            league: g.league || null,
          };
        }

        res.json({ ok: true, count: Object.keys(out).length, map: out });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map2 v3 loaded ✅ (builds from /api/games-map)");
  } catch (e) {
    console.log("[patch] games-map2 v3 failed ❌", e?.message || e);
  }
})();
/* ===== PT PATCH: games-map includes teams (home/away) when available ===== */
(() => {
  try {
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map teams: app not found ❌");
      return;
    }

    // remove existing /api/games-map route so ours wins
    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;
      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;
        if (route.path === path && route.methods && route.methods[method]) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const removed = stripRoute("/api/games-map", "get");
    console.log(`[patch] games-map teams: removed old route ✅ (removed=${removed})`);

    // Helper: try to discover games list already in memory
    const getKnownGames = () => {
      // Try common names used in patches / server state
      return (
        globalThis.gamesToday ||
        globalThis.games ||
        globalThis.nbaGames ||
        globalThis.allGames ||
        (globalThis.db && (globalThis.db.games || globalThis.db.nbaGames)) ||
        null
      );
    };

    // Helper: normalize team names from various shapes
    const pickTeam = (obj) => {
      if (!obj) return null;
      return obj.shortDisplayName || obj.displayName || obj.name || obj.abbreviation || obj.team || null;
    };

    appRef.get("/api/games-map", async (req, res) => {
      try {
        // Fallback: if your original logic stored a map somewhere, use it
        const base =
          (globalThis.__PT_GAMES_MAP && typeof globalThis.__PT_GAMES_MAP === "object" && globalThis.__PT_GAMES_MAP) ||
          null;

        // If we can find real games objects in memory, enrich from there
        const gArr = getKnownGames();
        const map = {};

        // Start with base if we have it
        if (base && base.map) {
          for (const [k, v] of Object.entries(base.map)) map[k] = { ...v };
        }

        // If we have an array of games, enrich or build
        if (Array.isArray(gArr)) {
          for (const g of gArr) {
            const eventId = String(g.eventId || g.id || g.gameId || "");
            if (!eventId) continue;

            const home =
              pickTeam(g.homeTeam) ||
              pickTeam(g.home) ||
              (g.competitions?.[0]?.competitors || []).find(c => c.homeAway === "home")?.team?.shortDisplayName ||
              null;

            const away =
              pickTeam(g.awayTeam) ||
              pickTeam(g.away) ||
              (g.competitions?.[0]?.competitors || []).find(c => c.homeAway === "away")?.team?.shortDisplayName ||
              null;

            const startTime =
              g.startTime ||
              g.date ||
              g.start ||
              g.competitions?.[0]?.date ||
              null;

            const league = g.league || g.sport || g.group || "NBA";

            const label = (away && home) ? `${away} @ ${home}` : `eventId ${eventId}`;

            map[eventId] = { eventId, label, startTime, league, homeTeam: home, awayTeam: away };
          }
        }

        // If we still have nothing, keep old behavior (minimal map)
        if (Object.keys(map).length === 0) {
          // Try to reuse the already-working games-map2 source behavior if nothing else exists:
          // build a placeholder map using previously-known ids (if you cached them somewhere)
          res.json({ ok: true, count: 0, map: {} });
          return;
        }

        res.json({ ok: true, count: Object.keys(map).length, map });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map teams enabled ✅ (homeTeam/awayTeam fields if available)");
  } catch (e) {
    console.log("[patch] games-map teams failed ❌", e?.message || e);
  }
})();

/* ===== PT: FORCE TEAMS INTO /api/games-map (ESPN SCOREBOARD MERGE) ===== */
(() => {
  try {
    if (typeof app === "undefined" || !app || !app.get) {
      console.log("[patch] games-map teams FORCE: app not found");
      return;
    }

    function removeRoutes(path) {
      const stack = app?._router?.stack;
      if (!Array.isArray(stack)) return 0;
      let removed = 0;

      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (!layer?.route) continue;
        const routePath = layer.route.path;
        if (routePath === path) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    }

    function yyyymmddFromISO(dateISO) {
      // dateISO like "2026-02-16"
      return String(dateISO || "").replaceAll("-", "");
    }

    async function fetchEspnScoreboard(dateISO) {
      const d = yyyymmddFromISO(dateISO);
      if (!d || d.length !== 8) return {};
      const url = `https://site.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${d}`;
      const r = await fetch(url, { headers: { "user-agent": "protracker/1.0" } });
      if (!r.ok) return {};
      const j = await r.json();

      const out = {}; // eventId -> { homeTeam, awayTeam }
      const events = Array.isArray(j?.events) ? j.events : [];
      for (const ev of events) {
        const eventId = ev?.id;
        const comp = ev?.competitions?.[0];
        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        const home = competitors.find(c => c?.homeAway === "home");
        const away = competitors.find(c => c?.homeAway === "away");

        const homeName = home?.team?.displayName || home?.team?.shortDisplayName || home?.team?.name;
        const awayName = away?.team?.displayName || away?.team?.shortDisplayName || away?.team?.name;

        if (eventId && homeName && awayName) {
          out[String(eventId)] = { homeTeam: homeName, awayTeam: awayName };
        }
      }
      return out;
    }

    // Override /api/games-map so it merges teams when possible
    const removed = removeRoutes("/api/games-map");
    console.log(`[patch] games-map teams FORCE override: removed old route ✅ (removed=${removed})`);

    app.get("/api/games-map", async (req, res) => {
      try {
        // pull your existing map from the old source endpoint (which you already have)
        const baseUrl = `http://127.0.0.1:${PORT || 3000}/api/games-map2`;
        let base = null;
        try {
          const r = await fetch(baseUrl);
          if (r.ok) base = await r.json();
        } catch {}

        const map = base?.map && typeof base.map === "object" ? base.map : {};
        const dateISO = req.query.date || new Date().toISOString().slice(0, 10);

        const teams = await fetchEspnScoreboard(dateISO);

        // merge into map
        for (const [eventId, info] of Object.entries(map)) {
          const t = teams[eventId];
          if (t) {
            info.homeTeam = info.homeTeam || t.homeTeam;
            info.awayTeam = info.awayTeam || t.awayTeam;
            // nicer label if we have teams
            if (info.homeTeam && info.awayTeam) {
              info.label = `${info.awayTeam} @ ${info.homeTeam} (eventId ${eventId})`;
            }
          }
        }

        res.json({ ok: true, count: Object.keys(map).length, map, note: "Merged ESPN team names when available." });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    console.log("[patch] games-map teams FORCE override loaded ✅");
  } catch (e) {
    console.log("[patch] games-map teams FORCE override failed:", e?.message || e);
  }
})();

/* ===== PT FIX: /api/games-map?date=YYYY-MM-DD (convert to ESPN YYYYMMDD) ===== */
(function PT_GAMES_MAP_DATE_FIX(){
  try {
    if (typeof app === "undefined") {
      console.log("[patch] games-map date fix skipped (app not found)");
      return;
    }

    // Remove old /api/games-map GET route(s) so our override is the one that runs
    function removeRoute(path, method) {
      let removed = 0;
      const stack = app?._router?.stack;
      if (!Array.isArray(stack)) return removed;

      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (!layer?.route) continue;
        if (layer.route.path !== path) continue;
        const methods = layer.route.methods || {};
        if (methods[method]) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    }

    const removed = removeRoute("/api/games-map", "get");
    console.log(`[patch] games-map date fix: removed old route(s) ✅ (removed=${removed})`);

    async function fetchScoreboardMap(isoDate /* YYYY-MM-DD */) {
      const ymd = String(isoDate || "").trim().replace(/-/g, "");
      if (!/^\d{8}$/.test(ymd)) {
        return { ok: false, error: "Bad date. Use YYYY-MM-DD", ymd };
      }

      const url = `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${ymd}`;
      const r = await fetch(url, { headers: { "user-agent": "protracker/1.0" } });
      const j = await r.json();

      const map = {};
      const events = Array.isArray(j?.events) ? j.events : [];
      for (const ev of events) {
        const eventId = String(ev?.id || "");
        const comp = ev?.competitions?.[0];
        const date = comp?.date || ev?.date || null;

        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        let home = null, away = null;
        for (const c of competitors) {
          const name = c?.team?.displayName || c?.team?.name || null;
          if (!name) continue;
          if (c?.homeAway === "home") home = name;
          if (c?.homeAway === "away") away = name;
        }

        const label =
          home && away ? `${away} @ ${home} (${eventId})` : `eventId ${eventId}`;

        if (eventId) {
          map[eventId] = { eventId, label, startTime: date, league: "NBA", homeTeam: home, awayTeam: away };
        }
      }

      return { ok: true, url, ymd, count: Object.keys(map).length, map };
    }

    // New /api/games-map
    app.get("/api/games-map", async (req, res) => {
      try {
        const isoDate = req.query?.date;

        // If date is provided, return scoreboard map for that day
        if (isoDate) {
          const out = await fetchScoreboardMap(isoDate);
          if (!out.ok) return res.status(400).json(out);
          return res.json({ ok: true, count: out.count, map: out.map, note: "ESPN scoreboard map for requested date", ymd: out.ymd });
        }

        // No date param: keep prior behavior if your app already cached a full map elsewhere.
        // If not cached, at least return an empty map with a helpful note.
        const cached = globalThis.__PT_GAMES_MAP_FULL || globalThis.__PT_GAMES_MAP || null;
        if (cached && typeof cached === "object") {
          return res.json({ ok: true, count: Object.keys(cached).length, map: cached, note: "Returned cached full map" });
        }

        return res.json({ ok: true, count: 0, map: {}, note: "Provide ?date=YYYY-MM-DD for ESPN scoreboard map" });
      } catch (e) {
        return res.status(500).send(String(e?.stack || e));
      }
    });

    console.log("[patch] games-map date fix loaded ✅");
  } catch (e) {
    console.log("[patch] games-map date fix failed ❌", e?.message || e);
  }
})();

/* ===== PT FIX v2: ESPN scoreboard fallbacks for /api/games-map?date=YYYY-MM-DD ===== */
(function PT_GAMES_MAP_DATE_FIX_V2(){
  try {
    if (typeof app === "undefined") {
      console.log("[patch] games-map v2 skipped (app not found)");
      return;
    }

    function removeRoute(path, method) {
      let removed = 0;
      const stack = app?._router?.stack;
      if (!Array.isArray(stack)) return removed;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (!layer?.route) continue;
        if (layer.route.path !== path) continue;
        const methods = layer.route.methods || {};
        if (methods[method]) { stack.splice(i, 1); removed++; }
      }
      return removed;
    }

    const removed = removeRoute("/api/games-map", "get");
    console.log(`[patch] games-map v2: removed old route(s) ✅ (removed=${removed})`);

    async function tryFetchJson(url) {
      try {
        const r = await fetch(url, {
          headers: {
            "user-agent": "protracker/1.0",
            "accept": "application/json,text/plain,*/*"
          }
        });
        const text = await r.text();
        let j = null;
        try { j = JSON.parse(text); } catch {}
        const events = Array.isArray(j?.events) ? j.events : [];
        return { ok: true, url, status: r.status, eventsCount: events.length, json: j };
      } catch (e) {
        return { ok: false, url, error: String(e?.message || e) };
      }
    }

    function buildMapFromScoreboard(j) {
      const map = {};
      const events = Array.isArray(j?.events) ? j.events : [];
      for (const ev of events) {
        const eventId = String(ev?.id || "");
        const comp = ev?.competitions?.[0];
        const date = comp?.date || ev?.date || null;

        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        let home = null, away = null;
        for (const c of competitors) {
          const name = c?.team?.displayName || c?.team?.name || null;
          if (!name) continue;
          if (c?.homeAway === "home") home = name;
          if (c?.homeAway === "away") away = name;
        }

        const label = (home && away) ? `${away} @ ${home} (${eventId})` : `eventId ${eventId}`;
        if (eventId) {
          map[eventId] = { eventId, label, startTime: date, league: "NBA", homeTeam: home, awayTeam: away };
        }
      }
      return map;
    }

    async function fetchScoreboardMap(isoDate /* YYYY-MM-DD */) {
      const ymd = String(isoDate || "").trim().replace(/-/g, "");
      if (!/^\d{8}$/.test(ymd)) return { ok: false, error: "Bad date. Use YYYY-MM-DD", ymd };

      const urls = [
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd}`,
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?date=${ymd}`,
        `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${ymd}`,
        `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?date=${ymd}`,
      ];

      const attempts = [];
      for (const url of urls) {
        const a = await tryFetchJson(url);
        attempts.push({ url: a.url, ok: a.ok, status: a.status, eventsCount: a.eventsCount, error: a.error });
        if (a.ok && a.json && Array.isArray(a.json.events) && a.json.events.length) {
          const map = buildMapFromScoreboard(a.json);
          return { ok: true, ymd, usedUrl: url, attempts, count: Object.keys(map).length, map };
        }
      }

      return { ok: true, ymd, usedUrl: null, attempts, count: 0, map: {} };
    }

    // Debug helper
    removeRoute("/api/games-map-debug", "get");
    app.get("/api/games-map-debug", async (req, res) => {
      const isoDate = req.query?.date;
      const out = await fetchScoreboardMap(isoDate);
      res.json(out);
    });

    // Main endpoint
    app.get("/api/games-map", async (req, res) => {
      try {
        const isoDate = req.query?.date;
        if (!isoDate) {
          return res.json({ ok: true, count: 0, map: {}, note: "Provide ?date=YYYY-MM-DD (NBA ESPN scoreboard)" });
        }
        const out = await fetchScoreboardMap(isoDate);
        return res.json({ ok: true, count: out.count, map: out.map, note: "ESPN scoreboard map for requested date", ymd: out.ymd, usedUrl: out.usedUrl });
      } catch (e) {
        return res.status(500).send(String(e?.stack || e));
      }
    });

    console.log("[patch] games-map v2 loaded ✅ (fallback ESPN urls)");
  } catch (e) {
    console.log("[patch] games-map v2 failed ❌", e?.message || e);
  }
})();

/* ===== PT PATCH: games-map2 FINAL OVERRIDE (date-aware) ===== */
(() => {
  try {
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map2 final override: app not found ❌");
      return;
    }

    // remove existing routes so this one wins
    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;

      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;

        if (route.path === path && route.methods?.[method]) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const r1 = stripRoute("/api/games-map2", "get");
    const r2 = stripRoute("/api/games-map2-debug", "get");

    console.log(`[patch] games-map2 final override removing old routes ✅ (map2=${r1}, debug=${r2})`);

    const http = require("http");

    const fetchLocalJSON = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: 3000, path, method: "GET" },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error("Bad JSON from " + path));
              }
            });
          }
        );
        req.on("error", reject);
        req.end();
      });

    // DEBUG ROUTE
    appRef.get("/api/games-map2-debug", async (req, res) => {
      try {
        const date = req.query?.date
          ? `?date=${encodeURIComponent(req.query.date)}`
          : "";

        const gm = await fetchLocalJSON("/api/games-map" + date);

        const keys = gm?.map ? Object.keys(gm.map) : [];

        res.json({
          ok: true,
          src: "/api/games-map" + date,
          gamesMapCount: keys.length,
          sample: keys.slice(0, 5).map((k) => gm.map[k]),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    // MAIN ROUTE
    appRef.get("/api/games-map2", async (req, res) => {
      try {
        const date = req.query?.date
          ? `?date=${encodeURIComponent(req.query.date)}`
          : "";

        const gm = await fetchLocalJSON("/api/games-map" + date);
        const srcMap = gm?.map || {};

        const out = {};

        for (const [eventId, g] of Object.entries(srcMap)) {
          const home = g.homeTeam || g.home || g.ht || null;
          const away = g.awayTeam || g.away || g.at || null;

          const pretty =
            home && away
              ? `${away} @ ${home}`
              : g.label || `eventId ${eventId}`;

          out[eventId] = {
            eventId: String(eventId),
            label: pretty,
            startTime: g.startTime || null,
            league: g.league || null,
          };
        }

        res.json({
          ok: true,
          count: Object.keys(out).length,
          map: out,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map2 FINAL override loaded ✅ (date-aware)");

  } catch (e) {
    console.log("[patch] games-map2 FINAL override failed ❌", e?.message || e);
  }
})();

/* ===== PT PATCH: games-map FINAL (NO LOOP) + date-aware + ESPN fallback ===== */
(() => {
  try {
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map FINAL: app not found ❌");
      return;
    }

    // remove existing /api/games-map so this wins (prevents games-map <-> games-map2 loop)
    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;

      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;

        if (route.path === path && route.methods?.[method]) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const removed = stripRoute("/api/games-map", "get");
    console.log(`[patch] games-map FINAL: removed old route(s) ✅ (removed=${removed})`);

    const yyyymmdd = (dateISO) => String(dateISO || "").replaceAll("-", "");
    const todayISO_ET = () => {
      // "good enough" local day; your server is ET-oriented in logs
      const d = new Date();
      return d.toISOString().slice(0, 10);
    };

    async function fetchEspnScoreboard(url) {
      try {
        const r = await fetch(url, { headers: { "user-agent": "protracker/1.0" } });
        if (!r.ok) return [];
        const j = await r.json();
        return Array.isArray(j?.events) ? j.events : [];
      } catch {
        return [];
      }
    }

    function mapFromEspnEvents(events, leagueTag) {
      const out = {};
      for (const ev of events) {
        const eventId = ev?.id;
        const comp = ev?.competitions?.[0];
        const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
        const home = competitors.find((c) => c?.homeAway === "home");
        const away = competitors.find((c) => c?.homeAway === "away");

        const homeName = home?.team?.displayName || home?.team?.shortDisplayName || home?.team?.name;
        const awayName = away?.team?.displayName || away?.team?.shortDisplayName || away?.team?.name;
        const startTime = comp?.date || ev?.date || null;

        if (!eventId) continue;

        const label = (homeName && awayName)
          ? `${awayName} @ ${homeName}`
          : `eventId ${eventId}`;

        out[String(eventId)] = {
          eventId: String(eventId),
          label,
          startTime,
          league: leagueTag,
          homeTeam: homeName || null,
          awayTeam: awayName || null,
        };
      }
      return out;
    }

    appRef.get("/api/games-map", async (req, res) => {
      try {
        const dateISO = (req.query?.date ? String(req.query.date) : todayISO_ET());
        const d = yyyymmdd(dateISO);

        // ESPN scoreboards
        // NBA:
        const nbaUrl = `https://site.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${d}`;
        // NCAA Men's Basketball:
        const ncaaUrl = `https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d}`;

        const [nbaEvents, ncaaEvents] = await Promise.all([
          fetchEspnScoreboard(nbaUrl),
          fetchEspnScoreboard(ncaaUrl),
        ]);

        // Merge both into one map
        const map = {
          ...mapFromEspnEvents(nbaEvents, "NBA"),
          ...mapFromEspnEvents(ncaaEvents, "NCAAM"),
        };

        res.json({
          ok: true,
          date: dateISO,
          count: Object.keys(map).length,
          map,
          src: ["ESPN:nba", "ESPN:mens-college-basketball"],
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    console.log("[patch] games-map FINAL loaded ✅ (no loop, ESPN NBA+NCAAM, date-aware)");
  } catch (e) {
    console.log("[patch] games-map FINAL failed ❌", e?.message || e);
  }
})();

/* ===== PT PATCH: games-map2 FINAL-FINAL (force date passthrough from games-map) ===== */
(() => {
  try {
    const appRef =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      global.app;

    if (!appRef) {
      console.log("[patch] games-map2 FINAL-FINAL: app not found ❌");
      return;
    }

    const stripRoute = (path, method) => {
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;
      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        const route = layer && layer.route;
        if (!route) continue;
        if (route.path === path && route.methods?.[method]) {
          stack.splice(i, 1);
          removed++;
        }
      }
      return removed;
    };

    const r1 = stripRoute("/api/games-map2", "get");
    const r2 = stripRoute("/api/games-map2-debug", "get");
    console.log(`[patch] games-map2 FINAL-FINAL: removed old route(s) ✅ (map2=${r1}, debug=${r2})`);

    const http = require("http");
    const fetchLocalJSON = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: 3000, path, method: "GET" },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error("Bad JSON from " + path + ": " + body.slice(0, 120)));
              }
            });
          }
        );
        req.on("error", reject);
        req.end();
      });

    appRef.get("/api/games-map2-debug", async (req, res) => {
      try {
        const date = req.query?.date ? String(req.query.date) : "";
        const path = "/api/games-map" + (date ? `?date=${encodeURIComponent(date)}` : "");
        const gm = await fetchLocalJSON(path);
        const keys = gm?.map ? Object.keys(gm.map) : [];
        res.json({ ok: true, src: path, gamesMapCount: keys.length, sample: keys.slice(0, 5).map((k) => gm.map[k]) });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    appRef.get("/api/games-map2", async (req, res) => {
      try {
        const date = req.query?.date ? String(req.query.date) : "";
        const path = "/api/games-map" + (date ? `?date=${encodeURIComponent(date)}` : "");
        const gm = await fetchLocalJSON(path);

        const srcMap = gm?.map || {};
        const out = {};

        for (const [eventId, g] of Object.entries(srcMap)) {
          const home = g.homeTeam || g.home || g.ht || null;
          const away = g.awayTeam || g.away || g.at || null;
          const pretty =
            home && away ? `${away} @ ${home}` :
            g.label ? String(g.label) :
            `eventId ${eventId}`;

          out[eventId] = {
            eventId: String(eventId),
            label: pretty,
            startTime: g.startTime || null,
            league: g.league || null,
            homeTeam: home,
            awayTeam: away,
          };
        }

        res.json({ ok: true, count: Object.keys(out).length, map: out, src: path });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });

    console.log("[patch] games-map2 FINAL-FINAL loaded ✅ (forced date passthrough)");
  } catch (e) {
    console.log("[patch] games-map2 FINAL-FINAL failed ❌", e?.message || e);
  }
})();

/* ===== PT FIX: choose an "active slate date" from props so edges/props actually show ===== */
(function () {
  const getApp = () => {
    try { return (typeof app !== "undefined" ? app : (globalThis.app || global.app)); } catch (e) { return (globalThis.app || global.app); }
  };
  const getDB = () => {
    try { return (typeof db !== "undefined" ? db : (globalThis.db || global.db)); } catch (e) { return (globalThis.db || global.db); }
  };

  const appRef = getApp();
  const DB = getDB();
  if (!appRef || !DB) {
    console.log("[patch] slate-date: app/db not ready, skipping");
    return;
  }

  function todayET() {
    // YYYY-MM-DD in America/New_York
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")?.value || "0000";
      const m = parts.find(p => p.type === "month")?.value || "00";
      const d = parts.find(p => p.type === "day")?.value || "00";
      return `${y}-${m}-${d}`;
    } catch {
      const dt = new Date();
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
  }

  function pickActiveSlateDate(reqDate) {
    if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) return reqDate;

    const t = todayET();

    // Prefer earliest dateISO >= today that exists in SGO props table.
    // Fallback to today if table empty.
    try {
      const rows = DB.sgoPropLines?.find?.({}) || [];
      let best = null;
      for (const r of rows) {
        const di = r?.dateISO;
        if (!di || !/^\d{4}-\d{2}-\d{2}$/.test(di)) continue;
        if (di < t) continue;
        if (best === null || di < best) best = di;
      }
      return best || t;
    } catch (e) {
      return t;
    }
  }

  // Expose helper for other code if needed
  globalThis.__PT_ACTIVE_SLAKE_DATE__ = pickActiveSlateDate;

  // Route: what slate date are we using?
  try { appRef._router.stack = appRef._router.stack.filter(l => !(l.route && l.route.path === "/api/props/active-date")); } catch {}
  appRef.get("/api/props/active-date", (req, res) => {
    const date = pickActiveSlateDate(req.query.date);
    res.json({ ok: true, date, todayET: todayET() });
  });

  // Route: props for active slate (SGO)
  try { appRef._router.stack = appRef._router.stack.filter(l => !(l.route && l.route.path === "/api/odds/sgo/props-for-date")); } catch {}
  appRef.get("/api/odds/sgo/props-for-date", (req, res) => {
    const date = pickActiveSlateDate(req.query.date);
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || "200", 10)));
    const rowsAll = DB.sgoPropLines?.find?.({}) || [];
    const rows = rowsAll.filter(r => r && r.league === "NBA" && r.dateISO === date).slice(0, limit);
    res.json({ ok: true, date, count: rows.length, rows });
  });

  // Patch edges-today + tiered: auto-use active slate date if none provided
  function wrapEdgesHandler(oldHandlerName) {
    const old = globalThis[oldHandlerName];
    if (typeof old !== "function") return false;

    globalThis[oldHandlerName] = function (req, res) {
      // if user explicitly passes ?date=YYYY-MM-DD, honor it
      const chosen = pickActiveSlateDate(req.query.date);

      // Inject date into query for the existing handler logic to use if it supports it
      // If it doesn't support it, at least your UI can call /api/odds/sgo/props-for-date and show props.
      req.query.__PT_ACTIVE_DATE__ = chosen;
      req.query.date = req.query.date || chosen;

      return old(req, res);
    };
    return true;
  }

  // If your existing code stores handlers, this may not hit; BUT it won't break anything.
  // (Most of your patches have handlers as functions in global scope)
  const ok1 = wrapEdgesHandler("handleEdgesToday");
  const ok2 = wrapEdgesHandler("handleEdgesTodayTiered");
  console.log(`[patch] slate-date enabled ✅ active date will follow props (hooks ok: ${ok1}/${ok2})`);
})();

/* ===== PT: ACTIVE PROPS DATE + DATE-AWARE EDGES (BOTTOM PATCH) ===== */
(() => {
  if (typeof app === "undefined") { console.log("[patch] active-date: app missing"); return; }
  if (typeof db === "undefined")  { console.log("[patch] active-date: db missing"); return; }

  // --- helpers ---
  const ymdET = () => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")?.value || "0000";
      const m = parts.find(p => p.type === "month")?.value || "00";
      const d = parts.find(p => p.type === "day")?.value || "00";
      return `${y}-${m}-${d}`;
    } catch {
      const dt = new Date();
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
  };

  const pickActiveDate = (reqDate) => {
    if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) return reqDate;
    const today = ymdET();

    try {
      const rows = (db.sgoPropLines?.find?.({}) || []);
      let best = null;
      for (const r of rows) {
        const di = r?.dateISO;
        if (!di || !/^\d{4}-\d{2}-\d{2}$/.test(di)) continue;
        if (di < today) continue;
        if (best === null || di < best) best = di;
      }
      return best || today;
    } catch (e) {
      return today;
    }
  };

  const removeRoute = (path, method = "get") => {
    try {
      const m = method.toLowerCase();
      const before = app._router.stack.length;
      app._router.stack = app._router.stack.filter(layer => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods?.[m]) return true;
        return false;
      });
      const removed = before - app._router.stack.length;
      return removed;
    } catch (e) { return 0; }
  };

  const findHandler = (path, method = "get") => {
    try {
      const m = method.toLowerCase();
      for (const layer of app._router.stack) {
        if (!layer.route) continue;
        if (layer.route.path !== path) continue;
        if (!layer.route.methods?.[m]) continue;
        // last handler is usually the one
        const stack = layer.route.stack || [];
        if (!stack.length) continue;
        return stack[stack.length - 1].handle;
      }
    } catch (e) {}
    return null;
  };

  // --- new routes ---
  removeRoute("/api/props/active-date", "get");
  app.get("/api/props/active-date", (req, res) => {
    const date = pickActiveDate(req.query.date);
    res.json({ ok: true, todayET: ymdET(), activeDate: date });
  });

  removeRoute("/api/odds/sgo/props-for-date", "get");
  app.get("/api/odds/sgo/props-for-date", (req, res) => {
    const date = pickActiveDate(req.query.date);
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || "200", 10)));
    const rowsAll = (db.sgoPropLines?.find?.({}) || []);
    const rows = rowsAll.filter(r => r && r.league === "NBA" && r.dateISO === date).slice(0, limit);
    res.json({ ok: true, date, count: rows.length, rows });
  });

  // --- wrap existing edges routes to be date-aware without rewriting internals ---
  const oldEdgesToday = findHandler("/api/nba/edges-today", "get");
  const oldEdgesTiered = findHandler("/api/nba/edges-today-tiered", "get");

  if (oldEdgesToday) {
    removeRoute("/api/nba/edges-today", "get");
    app.get("/api/nba/edges-today", (req, res, next) => {
      const date = pickActiveDate(req.query.date);
      req.query.date = req.query.date || date;
      req.query.__PT_ACTIVE_DATE__ = date;
      return oldEdgesToday(req, res, next);
    });
    console.log("[patch] edges-today now date-aware ✅");
  } else {
    console.log("[patch] edges-today handler not found (skip)");
  }

  if (oldEdgesTiered) {
    removeRoute("/api/nba/edges-today-tiered", "get");
    app.get("/api/nba/edges-today-tiered", (req, res, next) => {
      const date = pickActiveDate(req.query.date);
      req.query.date = req.query.date || date;
      req.query.__PT_ACTIVE_DATE__ = date;
      return oldEdgesTiered(req, res, next);
    });
    console.log("[patch] edges-today-tiered now date-aware ✅");
  } else {
    console.log("[patch] edges-today-tiered handler not found (skip)");
  }

  console.log("[patch] active props date routes loaded ✅");
})();

/* ===== PT: DB AUTO-DETECT + ACTIVE DATE + SGO PROPS-FOR-DATE (BOTTOM FIX) ===== */
(() => {
  if (typeof app === "undefined") { console.log("[patch] active-date v2: app missing"); return; }

  // Try common places where the in-memory DB is stored
  const getDB = () => {
    try {
      if (typeof db !== "undefined" && db) return db;                 // if you DO have db
    } catch {}
    try { if (global && global.db) return global.db; } catch {}
    try { if (global && global.DB) return global.DB; } catch {}
    try { if (app && app.locals && app.locals.db) return app.locals.db; } catch {}
    try { if (app && app.locals && app.locals.DB) return app.locals.DB; } catch {}
    return null;
  };

  const ymdET = () => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")?.value || "0000";
      const m = parts.find(p => p.type === "month")?.value || "00";
      const d = parts.find(p => p.type === "day")?.value || "00";
      return `${y}-${m}-${d}`;
    } catch {
      const dt = new Date();
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
  };

  const removeRoute = (path, method = "get") => {
    try {
      const m = method.toLowerCase();
      const before = app._router.stack.length;
      app._router.stack = app._router.stack.filter(layer => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods?.[m]) return true;
        return false;
      });
      return before - app._router.stack.length;
    } catch { return 0; }
  };

  const pickActiveDate = (DB, reqDate) => {
    if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) return reqDate;
    const today = ymdET();

    try {
      const rows = (DB?.sgoPropLines?.find?.({}) || []);
      let best = null;
      for (const r of rows) {
        const di = r?.dateISO;
        if (!di || !/^\d{4}-\d{2}-\d{2}$/.test(di)) continue;
        if (di < today) continue;
        if (best === null || di < best) best = di;
      }
      return best || today;
    } catch {
      return today;
    }
  };

  // Debug: show what DB we found + what collections exist
  removeRoute("/api/pt/db-debug", "get");
  app.get("/api/pt/db-debug", (req, res) => {
    const DB = getDB();
    const keys = DB ? Object.keys(DB).slice(0, 50) : [];
    res.json({
      ok: true,
      foundDB: !!DB,
      todayET: ymdET(),
      sampleKeys: keys,
      hasSgoPropLines: !!DB?.sgoPropLines,
      hasHardrockPropLines: !!DB?.hardrockPropLines,
    });
  });

  // Active props date
  removeRoute("/api/props/active-date", "get");
  app.get("/api/props/active-date", (req, res) => {
    const DB = getDB();
    if (!DB) return res.status(500).json({ ok: false, error: "DB not found (db/global.db/app.locals.db)" });
    const date = pickActiveDate(DB, req.query.date);
    res.json({ ok: true, todayET: ymdET(), activeDate: date });
  });

  // Props for a date (from SGO)
  removeRoute("/api/odds/sgo/props-for-date", "get");
  app.get("/api/odds/sgo/props-for-date", (req, res) => {
    const DB = getDB();
    if (!DB) return res.status(500).json({ ok: false, error: "DB not found (db/global.db/app.locals.db)" });

    const date = pickActiveDate(DB, req.query.date);
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || "200", 10)));
    const league = (req.query.league || "NBA").toUpperCase();

    const rowsAll = (DB.sgoPropLines?.find?.({}) || []);
    const rows = rowsAll
      .filter(r => r && String(r.league || "").toUpperCase() === league && r.dateISO === date)
      .slice(0, limit);

    res.json({ ok: true, league, date, count: rows.length, rows });
  });

  // Log what we found so you SEE it in protracker.log
  const DB = getDB();
  if (!DB) console.log("[patch] active-date v2: DB NOT FOUND ❌");
  else console.log("[patch] active-date v2: DB found ✅ keys=" + Object.keys(DB).slice(0, 10).join(","));

  console.log("[patch] active-date v2 routes loaded ✅");
})();

/* ===== PT: DB FINDER v3 (SCAN GLOBALS) + ACTIVE DATE + SGO PROPS-FOR-DATE ===== */
(() => {
  if (typeof app === "undefined") { console.log("[patch] db-finder v3: app missing"); return; }

  const removeRoute = (path, method = "get") => {
    try {
      const m = method.toLowerCase();
      const before = app._router.stack.length;
      app._router.stack = app._router.stack.filter(layer => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods?.[m]) return true;
        return false;
      });
      return before - app._router.stack.length;
    } catch { return 0; }
  };

  const ymdET = () => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")?.value || "0000";
      const m = parts.find(p => p.type === "month")?.value || "00";
      const d = parts.find(p => p.type === "day")?.value || "00";
      return `${y}-${m}-${d}`;
    } catch {
      const dt = new Date();
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
  };

  const looksLikeCollection = (c) => {
    if (!c) return false;
    if (typeof c.find === "function") return true;
    if (Array.isArray(c)) return true;
    if (c instanceof Map) return true;
    return false;
  };

  const looksLikeDB = (x) => {
    if (!x || typeof x !== "object") return false;
    // Your project uses these names in logs/endpoints
    if (looksLikeCollection(x.sgoPropLines)) return true;
    if (looksLikeCollection(x.hardrockPropLines)) return true;
    if (looksLikeCollection(x.propLines)) return true;
    if (looksLikeCollection(x.playerProps)) return true;
    return false;
  };

  const scanAppLocals = () => {
    try {
      const L = app?.locals;
      if (!L || typeof L !== "object") return null;
      for (const k of Object.keys(L)) {
        const v = L[k];
        if (looksLikeDB(v)) return { db: v, where: `app.locals.${k}` };
      }
    } catch {}
    return null;
  };

  const scanGlobals = () => {
    try {
      const names = Object.getOwnPropertyNames(globalThis);
      for (const k of names) {
        let v;
        try { v = globalThis[k]; } catch { continue; }
        if (looksLikeDB(v)) return { db: v, where: `globalThis.${k}` };
      }
    } catch {}
    return null;
  };

  const getDB = () => {
    // 1) standard places
    try { if (app?.locals?.db && looksLikeDB(app.locals.db)) return { db: app.locals.db, where: "app.locals.db" }; } catch {}
    try { if (globalThis.db && looksLikeDB(globalThis.db)) return { db: globalThis.db, where: "globalThis.db" }; } catch {}
    try { if (globalThis.DB && looksLikeDB(globalThis.DB)) return { db: globalThis.DB, where: "globalThis.DB" }; } catch {}

    // 2) scan app.locals
    const a = scanAppLocals();
    if (a) return a;

    // 3) scan globalThis (last resort)
    const g = scanGlobals();
    if (g) return g;

    return null;
  };

  const attachDB = (found) => {
    try {
      if (!found?.db) return;
      app.locals.db = found.db;
      globalThis.db = found.db;
    } catch {}
  };

  const pickActiveDate = (DB, reqDate) => {
    if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) return reqDate;
    const today = ymdET();
    try {
      const rows = (DB?.sgoPropLines?.find?.({}) || []);
      let best = null;
      for (const r of rows) {
        const di = r?.dateISO;
        if (!di || !/^\d{4}-\d{2}-\d{2}$/.test(di)) continue;
        if (di < today) continue;
        if (best === null || di < best) best = di;
      }
      return best || today;
    } catch {
      return today;
    }
  };

  // --- Debug route: shows WHERE the DB was found (if found)
  removeRoute("/api/pt/db-debug", "get");
  app.get("/api/pt/db-debug", (req, res) => {
    const found = getDB();
    if (found) attachDB(found);
    res.json({
      ok: true,
      todayET: ymdET(),
      foundDB: !!found?.db,
      where: found?.where || null,
      hasSgoPropLines: !!found?.db?.sgoPropLines,
      hasHardrockPropLines: !!found?.db?.hardrockPropLines,
      sampleDBKeys: found?.db ? Object.keys(found.db).slice(0, 40) : [],
    });
  });

  // --- Active date route
  removeRoute("/api/props/active-date", "get");
  app.get("/api/props/active-date", (req, res) => {
    const found = getDB();
    if (!found?.db) return res.status(500).json({ ok: false, error: "DB not found (scanned app.locals + globalThis)" });
    attachDB(found);
    const date = pickActiveDate(found.db, req.query.date);
    res.json({ ok: true, todayET: ymdET(), activeDate: date, where: found.where });
  });

  // --- Props for date route
  removeRoute("/api/odds/sgo/props-for-date", "get");
  app.get("/api/odds/sgo/props-for-date", (req, res) => {
    const found = getDB();
    if (!found?.db) return res.status(500).json({ ok: false, error: "DB not found (scanned app.locals + globalThis)" });
    attachDB(found);

    const date = pickActiveDate(found.db, req.query.date);
    const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || "200", 10)));
    const league = (req.query.league || "NBA").toUpperCase();

    const rowsAll = (found.db.sgoPropLines?.find?.({}) || []);
    const rows = rowsAll
      .filter(r => r && String(r.league || "").toUpperCase() === league && r.dateISO === date)
      .slice(0, limit);

    res.json({ ok: true, league, date, count: rows.length, where: found.where, rows });
  });

  // Log once at startup
  const found = getDB();
  if (found?.db) {
    attachDB(found);
    console.log(`[patch] db-finder v3: DB FOUND ✅ at ${found.where}`);
  } else {
    console.log("[patch] db-finder v3: DB NOT FOUND ❌");
  }

  console.log("[patch] db-finder v3 routes loaded ✅");
})();

/* ===== PT: FORCE EXPOSE DB (BOTTOM SAFE PATCH) ===== */
setTimeout(() => {
  try {
    if (!globalThis.db) {

      if (app && app.locals && app.locals.db) {
        globalThis.db = app.locals.db;
        console.log("[patch] DB exposed from app.locals ✅");
      }

      // try common names used earlier in file
      if (!globalThis.db && typeof db !== "undefined") {
        globalThis.db = db;
        console.log("[patch] DB exposed from local db ✅");
      }

      if (!globalThis.db && global && global.db) {
        globalThis.db = global.db;
        console.log("[patch] DB exposed from global.db ✅");
      }

      if (!globalThis.db) {
        console.log("[patch] DB expose FAILED ⚠️");
      }
    }
  } catch (e) {
    console.log("[patch] DB expose error", e.message);
  }
}, 2000);

/* ===== PT: DB AUTO-DETECT + EXPOSE (BOTTOM PATCH v2) ===== */
setTimeout(() => {
  try {
    const isDbLike = (v) => {
      if (!v || typeof v !== "object") return false;

      // lowdb-ish
      if (v.data && typeof v.data === "object") {
        if (Array.isArray(v.data.sgoPropLines) || Array.isArray(v.data.hardrockPropLines)) return true;
      }

      // plain object db-ish
      if (Array.isArray(v.sgoPropLines) || Array.isArray(v.hardrockPropLines)) return true;

      // sometimes wrapped
      if (v.db && (Array.isArray(v.db.sgoPropLines) || (v.db.data && Array.isArray(v.db.data.sgoPropLines)))) return true;

      return false;
    };

    // 1) already exposed?
    if (globalThis.db && isDbLike(globalThis.db)) {
      if (typeof app !== "undefined" && app && app.locals) app.locals.db = globalThis.db;
      console.log("[patch] DB already exposed ✅");
      return;
    }

    // 2) app.locals.db?
    if (typeof app !== "undefined" && app && app.locals && app.locals.db && isDbLike(app.locals.db)) {
      globalThis.db = app.locals.db;
      console.log("[patch] DB exposed from app.locals ✅");
      return;
    }

    // 3) scan globals for the real DB (this is the missing piece)
    let foundName = null;
    let foundRef = null;

    const names = Object.getOwnPropertyNames(globalThis);
    for (let i = 0; i < names.length; i++) {
      const k = names[i];
      let v;
      try { v = globalThis[k]; } catch { continue; }

      // quick skip
      if (!v || typeof v !== "object") continue;

      if (isDbLike(v)) { foundName = k; foundRef = v; break; }

      // some libs store it under .db
      if (v.db && isDbLike(v.db)) { foundName = k + ".db"; foundRef = v.db; break; }

      // lowdb wrapper under .default
      if (v.default && isDbLike(v.default)) { foundName = k + ".default"; foundRef = v.default; break; }
    }

    if (foundRef) {
      globalThis.db = foundRef;
      if (typeof app !== "undefined" && app && app.locals) app.locals.db = foundRef;
      console.log(`[patch] DB auto-detected from globalThis.${foundName} ✅`);
    } else {
      console.log("[patch] DB auto-detect FAILED ❌ (no db-like object found)");
    }

    // debug endpoint so you can confirm in curl
    try {
      if (typeof app !== "undefined" && app && app.get) {
        // remove old route if it exists
        if (app._router && app._router.stack) {
          app._router.stack = app._router.stack.filter((l) => !(l.route && l.route.path === "/api/pt/db-scan"));
        }
        app.get("/api/pt/db-scan", (req, res) => {
          const d = (globalThis.db || (app && app.locals && app.locals.db)) || null;
          const info = {
            ok: true,
            found: !!d,
            hasData: !!(d && d.data),
            hasSgo: !!(d && ((d.data && Array.isArray(d.data.sgoPropLines)) || Array.isArray(d.sgoPropLines))),
            hasHardrock: !!(d && ((d.data && Array.isArray(d.data.hardrockPropLines)) || Array.isArray(d.hardrockPropLines))),
          };
          res.json(info);
        });
        console.log("[patch] /api/pt/db-scan ready ✅");
      }
    } catch {}
  } catch (e) {
    console.log("[patch] DB auto-detect error", e && e.message ? e.message : String(e));
  }
}, 1500);

/* ===== PT DB AUTO-EXPOSE (BOTTOM PATCH) ===== */

setTimeout(() => {
  try {
    let found = null;

    // try common locations
    if (typeof db !== "undefined") found = db;
    if (!found && globalThis.db) found = globalThis.db;
    if (!found && globalThis.__PT_DB) found = globalThis.__PT_DB;

    if (!found && typeof app !== "undefined" && app?.locals?.db) {
      found = app.locals.db;
    }

    // scan globals as last resort
    if (!found) {
      for (const k of Object.keys(globalThis)) {
        const v = globalThis[k];
        if (v && typeof v === "object") {
          if (
            v.sgoPropLines ||
            v.hardrockPropLines ||
            v.prepare ||
            v.exec
          ) {
            found = v;
            break;
          }
        }
      }
    }

    if (found) {
      globalThis.db = found;
      globalThis.__PT_DB = found;
      if (typeof app !== "undefined" && app?.locals) {
        app.locals.db = found;
      }
      console.log("[patch] DB auto-exposed from bottom ✅");
    } else {
      console.log("[patch] DB auto-expose FAILED ❌");
    }
  } catch (e) {
    console.log("[patch] DB auto-expose error", e.message);
  }
}, 2000);

/* ===== END PT DB AUTO-EXPOSE ===== */

// =========================
// PT BOTTOM PATCH: expose DB globally from readDB()
// Paste at very bottom of protracker.js
// =========================
(() => {
  try {
    if (typeof readDB !== "function") {
      console.log("[patch] readDB not found at bottom ❌");
      return;
    }

    const _origReadDB = readDB;

    // Wrap readDB so every successful load is cached/exposed everywhere
    readDB = function (...args) {
      // return cached instance if already set
      try {
        if (globalThis.__PT_DB) return globalThis.__PT_DB;
      } catch {}

      const db = _origReadDB.apply(this, args);

      // if it looks like a real db object, expose it
      try {
        const looksLikeDB =
          db &&
          typeof db === "object" &&
          (typeof db.prepare === "function" ||
            typeof db.exec === "function" ||
            typeof db.query === "function");

        if (looksLikeDB) {
          globalThis.__PT_DB = db;
          globalThis.db = db;
          global.db = db;

          try { if (app && app.locals) app.locals.db = db; } catch {}

          console.log("[patch] readDB -> globalThis.db + app.locals.db ✅");
        } else {
          // still expose if it's non-empty object (some wrappers)
          if (db && typeof db === "object" && Object.keys(db).length) {
            globalThis.__PT_DB = db;
            globalThis.db = db;
            global.db = db;
            try { if (app && app.locals) app.locals.db = db; } catch {}
            console.log("[patch] readDB -> exposed (fallback) ✅");
          }
        }
      } catch (e) {
        console.log("[patch] readDB expose failed:", e?.message || e);
      }

      return db;
    };

    console.log("[patch] readDB wrapper installed ✅");
  } catch (e) {
    // IMPORTANT: if you see "Assignment to constant variable",
    // then readDB was declared with const and cannot be overridden at bottom.
    console.log("[patch] readDB wrapper failed ❌:", e?.message || e);
  }
})();

// =========================
// PT BOTTOM PATCH — ACTIVE PROP DATE AUTO-DETECT
// uses nearest available SGO props date if today has none
// =========================
(() => {
  try {

    app.get("/api/props/active-date-auto", (req,res)=>{
      const db = readDB();
      if (!db || !db.sgoPropLines)
        return res.json({ ok:false, error:"No SGO props" });

      const todayET =
        new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});

      const dates = [...new Set(
        db.sgoPropLines.map(r=>String(r.dateISO||""))
      )].filter(Boolean).sort();

      if (!dates.length)
        return res.json({ ok:false, error:"No prop dates found" });

      // pick today if exists, otherwise nearest future date
      let active = dates.find(d=>d===todayET);
      if (!active) {
        active = dates.find(d=>d>=todayET) || dates[dates.length-1];
      }

      res.json({
        ok:true,
        todayET,
        activeDate:active,
        totalDates:dates.length
      });
    });

    console.log("[patch] active prop date auto enabled ✅");

  } catch(e) {
    console.log("[patch] active prop date auto failed:", e.message);
  }
})();

// =========================
// PT BOTTOM PATCH — DATE-AWARE PROPS + EDGES DEFAULT
// =========================
(() => {
  try {
    // helper: get active date (today if available, else nearest future, else latest)
    function getActivePropDate() {
      const db = readDB();
      if (!db || !db.sgoPropLines) return null;

      const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

      const dates = [...new Set(db.sgoPropLines.map(r => String(r.dateISO || "")))]
        .filter(Boolean)
        .sort();

      if (!dates.length) return null;
      return dates.find(d => d === todayET) || dates.find(d => d >= todayET) || dates[dates.length - 1];
    }

    // 1) endpoint UI expects (you currently get "Cannot GET /api/odds/sgo/props-for-date")
    app.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = readDB();
      if (!db || !db.sgoPropLines) return res.status(500).json({ ok: false, error: "No db.sgoPropLines" });

      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const dateISO = String(req.query.date || "") || getActivePropDate();
      if (!dateISO) return res.status(500).json({ ok: false, error: "No prop dates found" });

      const rows = db.sgoPropLines.filter(r => String(r.dateISO || "") === dateISO).slice(0, limit);
      return res.json({ ok: true, date: dateISO, count: rows.length, rows });
    });

    console.log("[patch] /api/odds/sgo/props-for-date enabled ✅");

    // 2) make active-date endpoint return auto active date (so quick links can show the real slate date)
    // remove old route if exists
    try {
      const stack = app?._router?.stack || [];
      let removed = 0;
      for (let i = stack.length - 1; i >= 0; i--) {
        const r = stack[i];
        if (r?.route?.path === "/api/props/active-date") { stack.splice(i, 1); removed++; }
      }
      if (removed) console.log(`[patch] active-date: removed old route ✅ (removed=${removed})`);
    } catch {}

    app.get("/api/props/active-date", (req, res) => {
      const db = readDB();
      if (!db || !db.sgoPropLines) return res.status(500).json({ ok: false, error: "DB not found" });

      const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const activeDate = getActivePropDate() || todayET;

      res.json({ ok: true, todayET, activeDate, where: "readDB()" });
    });

    console.log("[patch] /api/props/active-date now uses auto date ✅");

    // 3) edges endpoint: default date to activeDate if missing
    // (this assumes your existing endpoint already supports `date`, but was defaulting to today)
    // we wrap by replacing route if present, then re-register a proxy wrapper that injects date.
    try {
      const stack = app?._router?.stack || [];
      let found = false;

      for (const layer of stack) {
        if (layer?.route?.path === "/api/nba/edges-today-tiered") found = true;
      }

      if (found) {
        // capture old handler
        const oldLayerIdx = stack.findIndex(l => l?.route?.path === "/api/nba/edges-today-tiered");
        const oldLayer = stack[oldLayerIdx];
        const oldHandler = oldLayer?.route?.stack?.[0]?.handle;

        // remove old
        stack.splice(oldLayerIdx, 1);
        console.log("[patch] edges-today-tiered: removed old route ✅");

        // re-add wrapper
        app.get("/api/nba/edges-today-tiered", (req, res, next) => {
          if (!req.query.date) {
            const active = getActivePropDate();
            if (active) req.query.date = active;
          }
          return oldHandler(req, res, next);
        });

        console.log("[patch] edges-today-tiered now defaults to active prop date ✅");
      } else {
        console.log("[patch] edges-today-tiered route not found (skip wrapper) ⚠️");
      }
    } catch (e) {
      console.log("[patch] edges wrapper failed:", e.message);
    }

  } catch (e) {
    console.log("[patch] date-aware props/edges patch failed:", e.message);
  }
})();

// =========================
// PT BOTTOM PATCH v2 — FIX props-for-date crash + FORCE edges date
// =========================
(() => {
  try {
    // --- safer: no Array.find anywhere ---
    function todayET() {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }

    function getActivePropDateSafe() {
      const db = readDB();
      if (!db || !Array.isArray(db.sgoPropLines)) return null;

      const t = todayET();

      // collect unique dates
      const seen = new Set();
      for (const r of db.sgoPropLines) {
        const d = String(r?.dateISO || "");
        if (d) seen.add(d);
      }
      const dates = Array.from(seen).sort();
      if (!dates.length) return null;

      // prefer: today, else nearest future, else latest
      for (const d of dates) if (d === t) return d;
      for (const d of dates) if (d >= t) return d;
      return dates[dates.length - 1];
    }

    // remove existing route helper
    function removeRoute(path) {
      try {
        const stack = app?._router?.stack || [];
        let removed = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
          const r = stack[i];
          if (r?.route?.path === path) { stack.splice(i, 1); removed++; }
        }
        return removed;
      } catch {
        return 0;
      }
    }

    // 1) FIX: /api/odds/sgo/props-for-date (override broken version)
    const removedPFD = removeRoute("/api/odds/sgo/props-for-date");
    if (removedPFD) console.log(`[patch] props-for-date: removed old route ✅ (removed=${removedPFD})`);

    app.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = readDB();
      if (!db || !Array.isArray(db.sgoPropLines)) {
        return res.status(500).json({ ok: false, error: "No db.sgoPropLines" });
      }

      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const qDate = String(req.query.date || "");
      const active = getActivePropDateSafe();
      const dateISO = qDate || active;

      if (!dateISO) return res.status(500).json({ ok: false, error: "No prop dates found" });

      const rows = [];
      for (const r of db.sgoPropLines) {
        if (String(r?.dateISO || "") === dateISO) {
          rows.push(r);
          if (rows.length >= limit) break;
        }
      }

      return res.json({ ok: true, date: dateISO, count: rows.length, rows });
    });

    console.log("[patch] /api/odds/sgo/props-for-date FIXED ✅");

    // 2) FORCE: edges endpoint uses active date if date missing + force response date field
    // (doesn't change how edges are computed, but prevents UI from thinking it's 'today' when active is future)
    const stack = app?._router?.stack || [];
    const idx = stack.findIndex(l => l?.route?.path === "/api/nba/edges-today-tiered");
    if (idx >= 0) {
      const layer = stack[idx];
      const oldHandler = layer?.route?.stack?.[0]?.handle;

      stack.splice(idx, 1);
      console.log("[patch] edges-today-tiered: removed old route ✅");

      app.get("/api/nba/edges-today-tiered", (req, res, next) => {
        const active = getActivePropDateSafe();
        if (!req.query.date && active) req.query.date = active;

        // wrap res.json to force date in response
        const origJson = res.json.bind(res);
        res.json = (body) => {
          try {
            if (body && typeof body === "object" && active) {
              body.date = String(req.query.date || active);
            }
          } catch {}
          return origJson(body);
        };

        return oldHandler(req, res, next);
      });

      console.log("[patch] edges-today-tiered now defaults to active date + forces response date ✅");
    } else {
      console.log("[patch] edges-today-tiered route not found (skip) ⚠️");
    }

  } catch (e) {
    console.log("[patch] BOTTOM PATCH v2 failed:", e?.message || e);
  }
})();

// =========================
// PT BOTTOM PATCH v3 — SGO-backed edges endpoint (no ESPN event join)
// =========================
(() => {
  try {
    function todayET() {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }

    function getActivePropDateSafe() {
      const db = readDB();
      if (!db || !Array.isArray(db.sgoPropLines)) return null;

      const t = todayET();
      const seen = new Set();
      for (const r of db.sgoPropLines) {
        const d = String(r?.dateISO || "");
        if (d) seen.add(d);
      }
      const dates = Array.from(seen).sort();
      if (!dates.length) return null;

      for (const d of dates) if (d === t) return d;
      for (const d of dates) if (d >= t) return d;
      return dates[dates.length - 1];
    }

    function removeRoute(path) {
      try {
        const stack = app?._router?.stack || [];
        let removed = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
          const r = stack[i];
          if (r?.route?.path === path) { stack.splice(i, 1); removed++; }
        }
        return removed;
      } catch {
        return 0;
      }
    }

    // Override /api/nba/edges-today-tiered to be SGO-based
    const removed = removeRoute("/api/nba/edges-today-tiered");
    console.log(`[patch] edges-today-tiered SGO override: removed old route ✅ (removed=${removed})`);

    app.get("/api/nba/edges-today-tiered", (req, res) => {
      const db = readDB();
      if (!db || !Array.isArray(db.sgoPropLines)) {
        return res.status(500).json({ ok: false, error: "No db.sgoPropLines" });
      }

      const active = getActivePropDateSafe();
      const dateISO = String(req.query.date || active || todayET());

      const minEdge = Number(req.query.minEdge || 0);
      const games = Math.max(1, Math.min(200, Number(req.query.games || 50))); // treat as limit groups
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 2000)));

      // Build "edge rows" directly from SGO props
      // We set edge=1.0 so UI filters like minEdge=0.5 won't drop everything.
      // If you later add real projections, you can compute real edge here.
      const rows = [];
      for (const r of db.sgoPropLines) {
        if (String(r?.dateISO || "") !== dateISO) continue;

        const edge = 1.0;
        if (edge < minEdge) continue;

        rows.push({
          source: "SGO",
          league: r.league || "NBA",
          date: dateISO,
          eventId: r.eventId || null,
          player: r.player || null,
          stat: r.stat || null,
          line: r.line ?? null,
          side: r.side || null,
          bookmaker: r.bookmaker || null,
          odds: r.odds ?? null,
          edge,
          tier: edge >= 2 ? "A" : edge >= 1 ? "B" : "C",
          updatedAt: r.updatedAt || null,
          oddID: (r.oddID == null ? null : String(r.oddID)),
        });

        if (rows.length >= limit) break;
      }

      // Light “tiering” / trimming
      // If UI expects fewer, keep the top N by edge
      rows.sort((a, b) => (b.edge || 0) - (a.edge || 0));

      // "games" param: cap output roughly to that many *players* (not perfect, but works)
      if (rows.length > 0) {
        const seenPlayers = new Set();
        const trimmed = [];
        for (const x of rows) {
          const key = String(x.player || "");
          if (key && !seenPlayers.has(key)) seenPlayers.add(key);
          trimmed.push(x);
          if (seenPlayers.size >= games) break;
        }
        return res.json({ ok: true, date: dateISO, count: trimmed.length, rows: trimmed });
      }

      return res.json({ ok: true, date: dateISO, count: 0, rows: [] });
    });

    console.log("[patch] edges-today-tiered SGO override loaded ✅");
  } catch (e) {
    console.log("[patch] edges-today-tiered SGO override FAILED:", e?.message || e);
  }
})();

// === PATCH: QUICK LINKS DATE SOURCE (paste at bottom) ===
(() => {
  try {
    if (!globalThis.app) return console.log("[patch] quick-links-date skipped (app missing)");

    // Ensure readDB is globally available and stable
    if (typeof globalThis.readDB !== "function") {
      globalThis.readDB = function readDB_global() {
        try { if (app?.locals?.db) return app.locals.db; } catch {}
        try { if (globalThis.db) return globalThis.db; } catch {}
        try { if (global.db) return global.db; } catch {}
        return null;
      };
      console.log("[patch] quick-links-date: global readDB installed ✅");
    }

    // Remove older version of the route if it exists
    try {
      app._router.stack = app._router.stack.filter(
        (l) => !(l?.route?.path === "/api/pt/quick-links" && l.route.methods?.get)
      );
    } catch {}

    function getActiveDateET(db) {
      const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

      // Prefer the latest dateISO present in SGO lines (your slate date)
      try {
        const arr = db?.sgoPropLines;
        if (Array.isArray(arr) && arr.length) {
          const dates = arr
            .map(r => (r?.dateISO ? String(r.dateISO).slice(0, 10) : null))
            .filter(Boolean);
          const uniq = [...new Set(dates)].sort();
          if (uniq.length) return uniq[uniq.length - 1];
        }
      } catch {}

      return todayET;
    }

    app.get("/api/pt/quick-links", (req, res) => {
      const db = globalThis.readDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const activeDate = getActiveDateET(db);

      return res.json({
        ok: true,
        todayET: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
        activeDate,
        links: {
          games: `/api/games-map?date=${activeDate}`,
          games2: `/api/games-map2?date=${activeDate}`,
          edges: `/api/nba/edges-today-tiered?date=${activeDate}&minEdge=0.5&games=20`,
          props: `/api/odds/sgo/props-for-date?date=${activeDate}&limit=50`
        }
      });
    });

    console.log("[patch] quick-links-date ready ✅  GET /api/pt/quick-links");
  } catch (e) {
    console.log("[patch] quick-links-date error ❌", e?.message || e);
  }
})();

// === PATCH: QUICK LINKS (BOTTOM ONLY, auto-finds app) ===
(() => {
  try {
    function findApp() {
      // 1) Common globals
      try { if (globalThis.app && globalThis.app.get) return globalThis.app; } catch {}
      try { if (global.app && global.app.get) return global.app; } catch {}

      // 2) Scan require cache for a module exporting an Express app-like object
      try {
        const cache = require.cache || {};
        for (const k of Object.keys(cache)) {
          const exp = cache[k]?.exports;
          if (!exp) continue;

          // direct export app
          if (exp.get && exp.use && exp.listen) return exp;

          // named export { app }
          if (exp.app && exp.app.get && exp.app.use && exp.app.listen) return exp.app;

          // default export
          if (exp.default && exp.default.get && exp.default.use && exp.default.listen) return exp.default;
        }
      } catch {}

      return null;
    }

    const app = findApp();
    if (!app) {
      console.log("[patch] quick-links-date skipped ❌ (could not find Express app)");
      return;
    }

    // expose for other patches
    try { globalThis.app = app; } catch {}
    try { global.app = app; } catch {}

    // remove older versions of this route if present
    try {
      if (app._router?.stack) {
        app._router.stack = app._router.stack.filter(
          (l) => !(l?.route?.path === "/api/pt/quick-links" && l.route.methods?.get)
        );
      }
    } catch {}

    function readDB() {
      try { if (app?.locals?.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      return null;
    }

    function todayET() {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }

    function getActiveDateET(db) {
      const t = todayET();

      // Prefer latest dateISO found in SGO props if present
      try {
        const arr = db?.sgoPropLines;
        if (Array.isArray(arr) && arr.length) {
          const dates = arr
            .map(r => (r?.dateISO ? String(r.dateISO).slice(0, 10) : null))
            .filter(Boolean);
          const uniq = [...new Set(dates)].sort();
          if (uniq.length) return uniq[uniq.length - 1];
        }
      } catch {}

      return t;
    }

    app.get("/api/pt/quick-links", (req, res) => {
      const db = readDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const activeDate = getActiveDateET(db);

      res.json({
        ok: true,
        todayET: todayET(),
        activeDate,
        links: {
          games: `/api/games-map?date=${activeDate}`,
          games2: `/api/games-map2?date=${activeDate}`,
          edges: `/api/nba/edges-today-tiered?date=${activeDate}&minEdge=0.5&games=20`,
          props: `/api/odds/sgo/props-for-date?date=${activeDate}&limit=50`
        }
      });
    });

    console.log("[patch] quick-links-date ready ✅  GET /api/pt/quick-links");
  } catch (e) {
    console.log("[patch] quick-links-date error ❌", e?.stack || e?.message || e);
  }
})();

;(() => {
  // === FINAL BOTTOM OVERRIDE: expose DB globally + date-aware quick-links ===
  // Safe even if pasted multiple times.

  function _getApp() {
    try { if (typeof app !== "undefined" && app && app.locals) return app; } catch {}
    try { if (globalThis.app && globalThis.app.locals) return globalThis.app; } catch {}
    return null;
  }

  function _getDB(a) {
    // Prefer real DB object from app.locals, else from readDB() if available.
    try { if (a && a.locals && a.locals.db) return a.locals.db; } catch {}
    try { if (typeof readDB === "function") return readDB(); } catch {}
    try { if (globalThis.db) return globalThis.db; } catch {}
    try { if (global.db) return global.db; } catch {}
    return null;
  }

  function _exposeDB(a) {
    const DB = _getDB(a);
    if (!DB) return null;

    try { if (a && a.locals) a.locals.db = DB; } catch {}
    try { globalThis.db = DB; } catch {}
    try { global.db = DB; } catch {}

    return DB;
  }

  function _removeRoute(a, method, path) {
    try {
      if (!a || !a._router || !a._router.stack) return 0;
      const m = String(method || "").toLowerCase();
      const before = a._router.stack.length;
      a._router.stack = a._router.stack.filter((layer) => {
        if (!layer || !layer.route) return true;
        if (layer.route.path !== path) return true;
        const has = layer.route.methods && layer.route.methods[m];
        return !has;
      });
      return before - a._router.stack.length;
    } catch {
      return 0;
    }
  }

  function _ymdET(d = new Date()) {
    // YYYY-MM-DD in America/New_York without needing Intl timeZone support in Termux
    // We already run ET logic elsewhere; this is only a fallback.
    const iso = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString();
    return iso.slice(0, 10);
  }

  function _activePropDate(DB) {
    // Best effort:
    // 1) if DB is a better-sqlite3 handle and has sgoPropLines table, pick newest dateISO
    // 2) else today
    try {
      if (DB && typeof DB.prepare === "function") {
        // Confirm table exists
        const t = DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get("sgoPropLines");
        if (t && t.name) {
          const row = DB.prepare(
            "SELECT dateISO FROM sgoPropLines WHERE dateISO IS NOT NULL AND dateISO != '' ORDER BY dateISO DESC LIMIT 1"
          ).get();
          if (row && row.dateISO) return String(row.dateISO).slice(0, 10);
        }
      }
    } catch {}
    return _ymdET();
  }

  const a = _getApp();
  if (!a) {
    // nothing to do yet
    try { console.log("[patch] quick-links FINAL bottom override: app missing ❌"); } catch {}
    return;
  }

  const DB = _exposeDB(a);
  if (DB) {
    try { console.log("[patch] DB exposed globally ✅ (app.locals.db + globalThis.db)"); } catch {}
  } else {
    try { console.log("[patch] DB expose still missing ⚠️ (readDB/app.locals not available)"); } catch {}
  }

  // Replace route if it exists
  const removed = _removeRoute(a, "get", "/api/pt/quick-links");
  try { if (removed) console.log(`[patch] quick-links: removed old route ✅ (removed=${removed})`); } catch {}

  a.get("/api/pt/quick-links", (req, res) => {
    const dbNow = _exposeDB(a); // re-expose in case DB appeared later
    const activeDate = _activePropDate(dbNow);
    const base = "http://127.0.0.1:3000";

    res.json({
      ok: true,
      activeDate,
      links: {
        activeDate: `${base}/api/props/active-date`,
        activeDateAuto: `${base}/api/props/active-date-auto`,
        gamesMap: `${base}/api/games-map?date=${activeDate}`,
        gamesMap2: `${base}/api/games-map2?date=${activeDate}`,
        sgoPropsForDate: `${base}/api/odds/sgo/props-for-date?date=${activeDate}`,
        edgesTiered: `${base}/api/nba/edges-today-tiered?date=${activeDate}&minEdge=0.5&games=20`
      }
    });
  });

  try { console.log("[patch] quick-links FINAL bottom override loaded ✅  GET /api/pt/quick-links"); } catch {}
})();

/* ===========================
   PROPS DATE HISTORY + ARCHIVE
   paste at bottom of protracker.js
   =========================== */

(() => {
  try {
    const expressApp = (typeof app !== "undefined" ? app : null);
    if (!expressApp) {
      console.log("[patch] props-history skipped (app missing)");
      return;
    }

    // --- helpers ---
    function isoDateET(d = new Date()) {
      // Convert "now" to America/New_York date (YYYY-MM-DD) without needing luxon
      const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
      const dt = new Date(s);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    function addDaysISO(iso, days) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + days);
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }

    // Get db from your working readDB/global/app.locals
    function getDB() {
      try { if (typeof readDB === "function") return readDB(); } catch {}
      try { if (expressApp.locals && expressApp.locals.db) return expressApp.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      return null;
    }

    // Remove existing routes if they exist
    function removeRoute(method, path) {
      try {
        const stack = expressApp?._router?.stack || [];
        let removed = 0;
        expressApp._router.stack = stack.filter((layer) => {
          if (!layer.route) return true;
          if (!layer.route.path || layer.route.path !== path) return true;
          const methods = layer.route.methods || {};
          if (!methods[method]) return true;
          removed++;
          return false;
        });
        if (removed) console.log(`[patch] props-history removed old route ✅ (${method.toUpperCase()} ${path} removed=${removed})`);
      } catch {}
    }

    // --- list dates that exist in db.sgoPropLines ---
    function listPropDates(db) {
      // Works with arrays or keyed objects
      const src = db?.sgoPropLines;
      if (!src) return [];

      const dates = new Set();

      if (Array.isArray(src)) {
        for (const r of src) {
          const di = r?.dateISO || r?.date || r?.slateDate;
          if (di && /^\d{4}-\d{2}-\d{2}$/.test(String(di))) dates.add(String(di));
        }
      } else if (typeof src === "object") {
        for (const k of Object.keys(src)) {
          const r = src[k];
          const di = r?.dateISO || r?.date || r?.slateDate;
          if (di && /^\d{4}-\d{2}-\d{2}$/.test(String(di))) dates.add(String(di));
        }
      }

      return Array.from(dates).sort();
    }

    // --- choose "active" date ---
    function pickActiveDate(db) {
      const today = isoDateET();
      const tomorrow = addDaysISO(today, 1);
      const dates = listPropDates(db);

      // Prefer: tomorrow if exists, else today if exists, else latest in db
      if (dates.includes(tomorrow)) return tomorrow;
      if (dates.includes(today)) return today;
      return dates.length ? dates[dates.length - 1] : today;
    }

    // --- NEW endpoint: list available prop dates (past + future) ---
    removeRoute("get", "/api/props/dates");
    expressApp.get("/api/props/dates", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });
      const dates = listPropDates(db);
      return res.json({ ok: true, todayET: isoDateET(), count: dates.length, dates });
    });

    // --- Update active-date to prefer tomorrow when available ---
    // (Keeps your existing endpoint name so the UI keeps working)
    removeRoute("get", "/api/props/active-date");
    expressApp.get("/api/props/active-date", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });
      const activeDate = pickActiveDate(db);
      return res.json({ ok: true, todayET: isoDateET(), activeDate, where: "props-history" });
    });

    // --- Make props-for-date load ANY date (tomorrow + past days) ---
    removeRoute("get", "/api/odds/sgo/props-for-date");
    expressApp.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const qDate = String(req.query.date || "").trim();
      const useDate = /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : pickActiveDate(db);

      const src = db.sgoPropLines || [];
      const rows = [];

      if (Array.isArray(src)) {
        for (const r of src) if (String(r?.dateISO || r?.date || "") === useDate) rows.push(r);
      } else {
        for (const k of Object.keys(src)) {
          const r = src[k];
          if (String(r?.dateISO || r?.date || "") === useDate) rows.push(r);
        }
      }

      rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

      return res.json({
        ok: true,
        date: useDate,
        count: rows.length,
        rows: rows.slice(0, limit)
      });
    });

    // --- Archive behavior: mark past-day props as archived instead of losing them ---
    // This does NOT delete anything. It just adds a flag so later you can filter.
    function archivePastDays() {
      const db = getDB();
      if (!db || !db.sgoPropLines) return;

      const today = isoDateET();
      const src = db.sgoPropLines;

      let changed = 0;

      function maybeArchive(r) {
        const di = String(r?.dateISO || r?.date || "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(di) && di < today && r.archived !== true) {
          r.archived = true;
          r.archivedAt = new Date().toISOString();
          changed++;
        }
      }

      if (Array.isArray(src)) {
        for (const r of src) maybeArchive(r);
      } else if (typeof src === "object") {
        for (const k of Object.keys(src)) maybeArchive(src[k]);
      }

      if (changed) console.log(`[patch] props-history archived past-day props ✅ (changed=${changed})`);
    }

    // run once on boot, then every 30 minutes
    archivePastDays();
    setInterval(archivePastDays, 30 * 60 * 1000);

    console.log("[patch] props-history loaded ✅ (tomorrow+past dates + archive past days)");
    console.log("[patch] endpoints: GET /api/props/dates, GET /api/props/active-date, GET /api/odds/sgo/props-for-date?date=YYYY-MM-DD");
  } catch (e) {
    console.log("[patch] props-history FAILED ❌", String(e && e.stack || e));
  }
})();

/* ===========================
   ACTIVE DATE PICKER FIX (earliest upcoming)
   paste at bottom of protracker.js
   =========================== */

(() => {
  try {
    if (typeof app === "undefined" || !app?._router) {
      console.log("[patch] active-date picker fix skipped (app missing)");
      return;
    }

    function isoDateET(d = new Date()) {
      const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
      const dt = new Date(s);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    function getDB() {
      try { if (typeof readDB === "function") return readDB(); } catch {}
      try { if (app.locals && app.locals.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      return null;
    }

    function listPropDates(db) {
      const src = db?.sgoPropLines;
      if (!src) return [];
      const dates = new Set();

      const add = (r) => {
        const di = r?.dateISO || r?.date || r?.slateDate;
        if (di && /^\d{4}-\d{2}-\d{2}$/.test(String(di))) dates.add(String(di));
      };

      if (Array.isArray(src)) for (const r of src) add(r);
      else if (typeof src === "object") for (const k of Object.keys(src)) add(src[k]);

      return Array.from(dates).sort(); // ascending
    }

    // NEW RULE:
    // pick the smallest date >= today (earliest upcoming).
    // if none, pick the latest in db.
    function pickActiveDateEarliestUpcoming(db) {
      const today = isoDateET();
      const dates = listPropDates(db);
      const upcoming = dates.filter(d => d >= today);
      if (upcoming.length) return upcoming[0];      // earliest upcoming
      return dates.length ? dates[dates.length - 1] : today; // fallback latest
    }

    // remove old /api/props/active-date
    try {
      const path = "/api/props/active-date";
      const stack = app._router.stack || [];
      let removed = 0;
      app._router.stack = stack.filter((layer) => {
        if (!layer.route) return true;
        if (layer.route.path !== path) return true;
        if (!layer.route.methods?.get) return true;
        removed++;
        return false;
      });
      if (removed) console.log(`[patch] active-date picker fix: removed old route ✅ (removed=${removed})`);
    } catch {}

    // add new /api/props/active-date
    app.get("/api/props/active-date", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const activeDate = pickActiveDateEarliestUpcoming(db);
      return res.json({ ok: true, todayET: isoDateET(), activeDate, where: "earliest-upcoming" });
    });

    console.log("[patch] active-date picker fix loaded ✅ (earliest upcoming slate)");
  } catch (e) {
    console.log("[patch] active-date picker fix FAILED ❌", String(e?.stack || e));
  }
})();

/* ===========================
   PROPS HISTORY + BACKFILL + ARCHIVE
   paste at bottom of protracker.js
   =========================== */

(() => {
  try {
    if (typeof app === "undefined" || !app?._router) {
      console.log("[patch] props-history/archive skipped (app missing)");
      return;
    }

    // ---- helpers ----
    function isoDateET(d = new Date()) {
      const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
      const dt = new Date(s);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    function addDaysISO(iso, n) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + n);
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }
    function getDB() {
      try { if (typeof readDB === "function") return readDB(); } catch {}
      try { if (app.locals && app.locals.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      return null;
    }
    function listPropDatesFromDB(db) {
      const src = db?.sgoPropLines;
      if (!src) return [];
      const dates = new Set();
      const add = (r) => {
        const di = r?.dateISO || r?.date || r?.slateDate;
        if (di && /^\d{4}-\d{2}-\d{2}$/.test(String(di))) dates.add(String(di));
      };
      if (Array.isArray(src)) for (const r of src) add(r);
      else if (typeof src === "object") for (const k of Object.keys(src)) add(src[k]);
      return Array.from(dates).sort();
    }
    function ensureArchive(db) {
      if (!db.propsArchive) db.propsArchive = {}; // { [dateISO]: rows[] }
      return db.propsArchive;
    }

    // remove existing route helper
    function removeGET(path) {
      try {
        const stack = app._router.stack || [];
        let removed = 0;
        app._router.stack = stack.filter((layer) => {
          if (!layer.route) return true;
          if (layer.route.path !== path) return true;
          if (!layer.route.methods?.get) return true;
          removed++;
          return false;
        });
        if (removed) console.log(`[patch] removed old GET ${path} ✅ (removed=${removed})`);
      } catch {}
    }
    function removePOST(path) {
      try {
        const stack = app._router.stack || [];
        let removed = 0;
        app._router.stack = stack.filter((layer) => {
          if (!layer.route) return true;
          if (layer.route.path !== path) return true;
          if (!layer.route.methods?.post) return true;
          removed++;
          return false;
        });
        if (removed) console.log(`[patch] removed old POST ${path} ✅ (removed=${removed})`);
      } catch {}
    }

    // ---------------------------------------
    // 1) Dates endpoint: upcoming by default, all with ?all=1
    // ---------------------------------------
    removeGET("/api/props/dates");
    app.get("/api/props/dates", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const today = isoDateET();
      const all = String(req.query.all || "") === "1";
      const dates = listPropDatesFromDB(db);
      const out = all ? dates : dates.filter(d => d >= today);

      res.json({ ok: true, todayET: today, count: out.length, dates: out, mode: all ? "all" : "upcoming" });
    });
    console.log("[patch] /api/props/dates upgraded ✅ (upcoming default, all=1)");

    // ---------------------------------------
    // 2) Backfill pull endpoint: pull props for any date and store into db.sgoPropLines
    //    Requires you already have an SGO pull function somewhere.
    //    We'll try to call globalThis.sgoPullForDate(dateISO) if you define it,
    //    otherwise we error with a clear message.
    // ---------------------------------------
    removePOST("/api/odds/sgo/pull-for-date");
    app.post("/api/odds/sgo/pull-for-date", async (req, res) => {
      try {
        const db = getDB();
        if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

        const dateISO = String(req.query.date || req.body?.date || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
          return res.status(400).json({ ok: false, error: "Missing/invalid date (use YYYY-MM-DD)" });
        }

        const fn = globalThis.sgoPullForDate || globalThis.pullSgoForDate || null;
        if (typeof fn !== "function") {
          return res.status(500).json({
            ok: false,
            error: "No date-aware SGO pull function found. Define globalThis.sgoPullForDate(dateISO) that fetches+saves to db.sgoPropLines."
          });
        }

        const result = await fn(dateISO, { db, app });
        return res.json({ ok: true, date: dateISO, result });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.stack || e) });
      }
    });
    console.log("[patch] /api/odds/sgo/pull-for-date ready ✅ (needs globalThis.sgoPullForDate)");

    // ---------------------------------------
    // 3) Archive/freeze props for a date into db.propsArchive[date]
    // ---------------------------------------
    removePOST("/api/props/archive");
    app.post("/api/props/archive", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const dateISO = String(req.query.date || req.body?.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
        return res.status(400).json({ ok: false, error: "Missing/invalid date (use YYYY-MM-DD)" });
      }

      const today = isoDateET();
      // allow archiving any date, but warn if it’s in the future
      const isFuture = dateISO > today;

      const archive = ensureArchive(db);

      // collect rows for date from db.sgoPropLines
      const src = db?.sgoPropLines;
      let rows = [];
      if (Array.isArray(src)) rows = src.filter(r => String(r?.dateISO || r?.date || r?.slateDate) === dateISO);
      else if (src && typeof src === "object") {
        rows = Object.keys(src).map(k => src[k]).filter(r => String(r?.dateISO || r?.date || r?.slateDate) === dateISO);
      }

      archive[dateISO] = rows;
      res.json({ ok: true, todayET: today, date: dateISO, archivedCount: rows.length, note: isFuture ? "Archived a future date (allowed)" : "Archived" });
    });
    console.log("[patch] /api/props/archive ready ✅");

    // ---------------------------------------
    // 4) Optional: make props-for-date prefer archive if present
    //    If you already have this route, we won't remove it here.
    //    We'll just add a NEW route for archived reads:
    //    GET /api/odds/sgo/props-for-date-archived?date=YYYY-MM-DD&limit=20
    // ---------------------------------------
    removeGET("/api/odds/sgo/props-for-date-archived");
    app.get("/api/odds/sgo/props-for-date-archived", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const dateISO = String(req.query.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
        return res.status(400).json({ ok: false, error: "Missing/invalid date (use YYYY-MM-DD)" });
      }

      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const archive = ensureArchive(db);
      const rows = Array.isArray(archive[dateISO]) ? archive[dateISO] : [];
      res.json({ ok: true, date: dateISO, archived: true, count: rows.length, rows: rows.slice(0, limit) });
    });
    console.log("[patch] /api/odds/sgo/props-for-date-archived ready ✅");

    // ---------------------------------------
    // 5) Auto-archive yesterday on startup (so "after the day is over" it’s saved)
    //    This just copies whatever is currently stored for yesterday into archive.
    // ---------------------------------------
    try {
      const db = getDB();
      if (db) {
        const today = isoDateET();
        const yesterday = addDaysISO(today, -1);
        const archive = ensureArchive(db);

        if (!archive[yesterday]) {
          const src = db?.sgoPropLines;
          let rows = [];
          if (Array.isArray(src)) rows = src.filter(r => String(r?.dateISO || r?.date || r?.slateDate) === yesterday);
          else if (src && typeof src === "object") rows = Object.keys(src).map(k => src[k]).filter(r => String(r?.dateISO || r?.date || r?.slateDate) === yesterday);

          if (rows.length) {
            archive[yesterday] = rows;
            console.log(`[patch] auto-archived yesterday ✅ (${yesterday}) count=${rows.length}`);
          } else {
            console.log(`[patch] auto-archive yesterday skipped (no rows) (${yesterday})`);
          }
        } else {
          console.log(`[patch] auto-archive yesterday skipped (already archived) (${yesterday})`);
        }
      }
    } catch {}

  } catch (e) {
    console.log("[patch] props-history/archive FAILED ❌", String(e?.stack || e));
  }
})();

/* ===========================
   ARCHIVE-FIRST props-for-date + AUTO-FREEZE
   paste at bottom of protracker.js
   =========================== */

(() => {
  try {
    if (typeof app === "undefined" || !app?._router) {
      console.log("[patch] archive-first skipped (app missing)");
      return;
    }

    // ---- helpers ----
    function isoDateET(d = new Date()) {
      const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
      const dt = new Date(s);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    function addDaysISO(iso, n) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() + n);
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(dt.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }
    function getDB() {
      try { if (typeof readDB === "function") return readDB(); } catch {}
      try { if (app.locals && app.locals.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      return null;
    }
    function ensureArchive(db) {
      if (!db.propsArchive) db.propsArchive = {}; // { [dateISO]: rows[] }
      return db.propsArchive;
    }
    function removeGET(path) {
      try {
        const stack = app._router.stack || [];
        let removed = 0;
        app._router.stack = stack.filter((layer) => {
          if (!layer.route) return true;
          if (layer.route.path !== path) return true;
          if (!layer.route.methods?.get) return true;
          removed++;
          return false;
        });
        if (removed) console.log(`[patch] removed old GET ${path} ✅ (removed=${removed})`);
      } catch {}
    }

    // Pull rows for date from live db.sgoPropLines
    function liveRowsForDate(db, dateISO) {
      const src = db?.sgoPropLines;
      if (!src) return [];
      if (Array.isArray(src)) {
        return src.filter(r => String(r?.dateISO || r?.date || r?.slateDate) === dateISO);
      }
      if (typeof src === "object") {
        return Object.keys(src).map(k => src[k]).filter(r => String(r?.dateISO || r?.date || r?.slateDate) === dateISO);
      }
      return [];
    }

    // ---------------------------------------
    // OVERRIDE: /api/odds/sgo/props-for-date
    // Behavior:
    // - if archived exists for date -> return archived
    // - else return live for date (db.sgoPropLines)
    // ---------------------------------------
    removeGET("/api/odds/sgo/props-for-date");
    app.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const dateISO = String(req.query.date || "").trim() || null;
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const archive = ensureArchive(db);

      // if no date passed, use active-date endpoint if it exists
      let date = dateISO;
      if (!date) {
        try {
          // best effort: if you have a helper already, use it
          if (typeof globalThis.getActivePropDate === "function") date = globalThis.getActivePropDate();
        } catch {}
      }
      if (!date) date = isoDateET(); // final fallback

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ ok: false, error: "Invalid date (use YYYY-MM-DD)" });
      }

      const archivedRows = Array.isArray(archive[date]) ? archive[date] : null;
      if (archivedRows) {
        return res.json({
          ok: true,
          date,
          source: "archive",
          count: archivedRows.length,
          rows: archivedRows.slice(0, limit),
        });
      }

      const live = liveRowsForDate(db, date);
      return res.json({
        ok: true,
        date,
        source: "live",
        count: live.length,
        rows: live.slice(0, limit),
      });
    });
    console.log("[patch] /api/odds/sgo/props-for-date now ARCHIVE-FIRST ✅");

    // ---------------------------------------
    // AUTO-FREEZE: archive yesterday if it’s in live
    // (prevents “past day disappears” even if live gets overwritten later)
    // ---------------------------------------
    try {
      const db = getDB();
      if (db) {
        const today = isoDateET();
        const yday = addDaysISO(today, -1);
        const archive = ensureArchive(db);

        if (!archive[yday]) {
          const rows = liveRowsForDate(db, yday);
          if (rows.length) {
            archive[yday] = rows;
            console.log(`[patch] auto-freeze ✅ archived yesterday ${yday} count=${rows.length}`);
          } else {
            console.log(`[patch] auto-freeze skipped (no rows for yesterday ${yday})`);
          }
        } else {
          console.log(`[patch] auto-freeze skipped (already archived ${yday})`);
        }
      }
    } catch {}

  } catch (e) {
    console.log("[patch] archive-first FAILED ❌", String(e?.stack || e));
  }
})();

// ===== PATCH: NBA stats leaders + route list (paste at absolute bottom) =====
(() => {
  try {
    // List all registered routes (for debugging)
    app.get("/api/pt/routes", (req, res) => {
      try {
        const out = [];
        const stack = app?._router?.stack || [];
        for (const layer of stack) {
          const r = layer?.route;
          if (!r) continue;
          const methods = Object.keys(r.methods || {}).filter(k => r.methods[k]).join(",");
          out.push(`${methods.toUpperCase()} ${r.path}`);
        }
        res.json({ ok: true, count: out.length, routes: out.sort() });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.stack || e) });
      }
    });

    // Remove any old /api/nba/stats/leaders handler if it exists, then re-add it
    try {
      const stack = app?._router?.stack;
      if (Array.isArray(stack)) {
        app._router.stack = stack.filter((layer) => {
          const p = layer?.route?.path;
          const m = layer?.route?.methods;
          return !(p === "/api/nba/stats/leaders" && m && m.get);
        });
      }
    } catch {}

    app.get("/api/nba/stats/leaders", (req, res) => {
      try {
        const db =
          (typeof readDB === "function" ? readDB() : null) ||
          (app?.locals?.db || null) ||
          (globalThis.db || global.db || null) ||
          {};

        const nbaStats = db.nbaStats || db.nba || {};
        const candidates = [
          ["todayLeaders", nbaStats.todayLeaders],
          ["leadersToday", nbaStats.leadersToday],
          ["leaders", nbaStats.leaders],
          ["statsLeaders", nbaStats.statsLeaders],
          ["nbaLeaders", db.nbaLeaders],
          ["nbaStatsLeaders", db.nbaStatsLeaders],
        ];

        let pickedKey = null;
        let picked = null;
        for (const [k, v] of candidates) {
          if (Array.isArray(v) && v.length) { pickedKey = k; picked = v; break; }
          if (v && typeof v === "object" && Object.keys(v).length) { pickedKey = k; picked = v; break; }
        }

        if (!picked) {
          return res.json({
            ok: true,
            source: null,
            leaders: { points: [], rebounds: [], assists: [], threes: [] },
            note: "No leaders found in db yet.",
          });
        }

        return res.json({ ok: true, source: pickedKey, leaders: picked });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.stack || e) });
      }
    });

    console.log("[patch] nba-stats-leaders ready ✅  GET /api/nba/stats/leaders");
    console.log("[patch] /api/pt/routes ready ✅");
  } catch (e) {
    console.log("[patch] nba-stats-leaders failed ❌", e?.message || e);
  }
})();

/* ===========================
   PT PATCH: NBA leaders fallback (compute from db)
   Adds/overrides: GET /api/nba/stats/leaders
   Uses: db.nbaPlayerGameLogs (preferred) or db.nbaStats
=========================== */
(function () {
  try {
    const expressApp =
      (typeof app !== "undefined" && app) ||
      (globalThis && globalThis.app) ||
      (global && global.app) ||
      null;

    if (!expressApp || typeof expressApp.get !== "function") {
      console.log("[patch] nba-stats-leaders fallback skipped (app missing)");
      return;
    }

    // remove old route if present
    try {
      const stack = expressApp?._router?.stack;
      if (Array.isArray(stack)) {
        let removed = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
          const layer = stack[i];
          if (!layer || !layer.route) continue;
          const p = layer.route.path;
          const m = layer.route.methods || {};
          if (p === "/api/nba/stats/leaders" && m.get) {
            stack.splice(i, 1);
            removed++;
          }
        }
        if (removed) console.log(`[patch] nba-stats-leaders fallback: removed old route ✅ (removed=${removed})`);
      }
    } catch {}

    const readDbSafe = () => {
      try {
        if (typeof readDB === "function") return readDB();
      } catch {}
      try {
        return (expressApp.locals && expressApp.locals.db) || globalThis.db || global.db || null;
      } catch {}
      return null;
    };

    const rowsFrom = (col) => {
      if (!col) return [];
      if (Array.isArray(col)) return col;
      if (Array.isArray(col.data)) return col.data; // loki-like
      if (typeof col.all === "function") {
        try {
          const r = col.all();
          if (Array.isArray(r)) return r;
        } catch {}
      }
      if (typeof col.find === "function") {
        // some libs have find(fn) but also find() returning all
        try {
          const r = col.find();
          if (Array.isArray(r)) return r;
        } catch {}
        try {
          const r = col.find(() => true);
          if (Array.isArray(r)) return r;
        } catch {}
      }
      if (typeof col.toArray === "function") {
        try {
          const r = col.toArray();
          if (Array.isArray(r)) return r;
        } catch {}
      }
      return [];
    };

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
      }
      return null;
    };

    const buildFromGameLogs = (rows) => {
      // Expect rows with player name + boxscore fields per game
      const byPlayer = new Map();

      for (const r of rows) {
        const player =
          pick(r, ["player", "playerName", "name", "fullName"]) ||
          (r.player && (r.player.name || r.player.fullName)) ||
          null;

        if (!player) continue;

        const team =
          pick(r, ["team", "teamAbbr", "teamAbbrev", "abbreviation"]) ||
          (r.team && (r.team.abbreviation || r.team.abbr || r.team.name)) ||
          null;

        // common stat keys in logs
        const pts = num(pick(r, ["PTS", "points", "pt", "pts"]));
        const reb = num(pick(r, ["REB", "rebounds", "reb", "trb"]));
        const ast = num(pick(r, ["AST", "assists", "ast"]));
        const threes = num(pick(r, ["FG3M", "fg3m", "3PM", "threeMade", "threesMade"]));

        const key = `${player}||${team || ""}`;
        const cur = byPlayer.get(key) || { player, team, gp: 0, pts: 0, reb: 0, ast: 0, threes: 0 };
        cur.gp += 1;
        cur.pts += pts;
        cur.reb += reb;
        cur.ast += ast;
        cur.threes += threes;
        byPlayer.set(key, cur);
      }

      const arr = Array.from(byPlayer.values())
        .filter((x) => x.gp > 0)
        .map((x) => ({
          player: x.player,
          team: x.team || null,
          gp: x.gp,
          ppg: x.pts / x.gp,
          rpg: x.reb / x.gp,
          apg: x.ast / x.gp,
          tpg: x.threes / x.gp,
        }));

      const top = (field) =>
        arr
          .slice()
          .sort((a, b) => (b[field] || 0) - (a[field] || 0))
          .slice(0, 25)
          .map((x) => ({
            player: x.player,
            team: x.team,
            gp: x.gp,
            value: Number((x[field] || 0).toFixed(2)),
          }));

      return {
        ok: true,
        source: "computed:nbaPlayerGameLogs",
        leaders: {
          points: top("ppg"),
          rebounds: top("rpg"),
          assists: top("apg"),
          threes: top("tpg"),
        },
      };
    };

    const buildFromNbaStats = (rows) => {
      // fallback if your db has a season summary table already
      // tries to read already-averaged fields if present
      const norm = rows
        .map((r) => {
          const player =
            pick(r, ["player", "playerName", "name", "fullName"]) ||
            (r.player && (r.player.name || r.player.fullName)) ||
            null;
          if (!player) return null;

          const team =
            pick(r, ["team", "teamAbbr", "teamAbbrev", "abbreviation"]) ||
            (r.team && (r.team.abbreviation || r.team.abbr || r.team.name)) ||
            null;

          const gp = Math.max(1, num(pick(r, ["GP", "gp", "games", "gamesPlayed"])));

          // if table already has averages, use them; else compute from totals
          const ppg = num(pick(r, ["PPG", "ppg"])) || (num(pick(r, ["PTS", "points", "pts"])) / gp);
          const rpg = num(pick(r, ["RPG", "rpg"])) || (num(pick(r, ["REB", "rebounds", "reb"])) / gp);
          const apg = num(pick(r, ["APG", "apg"])) || (num(pick(r, ["AST", "assists", "ast"])) / gp);
          const tpg = num(pick(r, ["TPG", "tpg", "3PG", "threePerGame"])) || (num(pick(r, ["FG3M", "fg3m", "3PM"])) / gp);

          return { player, team, gp, ppg, rpg, apg, tpg };
        })
        .filter(Boolean);

      const top = (field) =>
        norm
          .slice()
          .sort((a, b) => (b[field] || 0) - (a[field] || 0))
          .slice(0, 25)
          .map((x) => ({
            player: x.player,
            team: x.team,
            gp: x.gp,
            value: Number((x[field] || 0).toFixed(2)),
          }));

      return {
        ok: true,
        source: "computed:nbaStats",
        leaders: {
          points: top("ppg"),
          rebounds: top("rpg"),
          assists: top("apg"),
          threes: top("tpg"),
        },
      };
    };

    expressApp.get("/api/nba/stats/leaders", (req, res) => {
      try {
        const db = readDbSafe();
        if (!db) return res.json({ ok: true, source: null, leaders: { points: [], rebounds: [], assists: [], threes: [] }, note: "No db available." });

        const logs = rowsFrom(db.nbaPlayerGameLogs);
        if (logs.length) return res.json(buildFromGameLogs(logs));

        const stats = rowsFrom(db.nbaStats);
        if (stats.length) return res.json(buildFromNbaStats(stats));

        return res.json({
          ok: true,
          source: null,
          leaders: { points: [], rebounds: [], assists: [], threes: [] },
          note: "No leaders found in db yet (need nbaPlayerGameLogs or nbaStats).",
        });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });

    console.log("[patch] nba-stats-leaders fallback loaded ✅  GET /api/nba/stats/leaders");
  } catch (e) {
    console.log("[patch] nba-stats-leaders fallback FAILED ⚠️", String(e && e.message ? e.message : e));
  }
})();


/* =========================
   BEGIN: NBA stats status + warm patch (bottom-only)
   ========================= */
(() => {
  try {
    if (globalThis.__PT_NBA_STATUS_WARM_PATCH_LOADED) {
      console.log("[patch] nba-stats-status/warm already loaded ✅");
      return;
    }
    globalThis.__PT_NBA_STATUS_WARM_PATCH_LOADED = true;

    const getDB = () => {
      try { if (typeof globalThis.readDB === "function") return globalThis.readDB(); } catch {}
      try { if (typeof readDB === "function") return readDB(); } catch {}
      try { if (typeof app !== "undefined" && app?.locals?.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      return null;
    };

    const len = (x) => (Array.isArray(x) ? x.length : 0);

    // GET /api/nba/stats/status
    try {
      if (typeof app !== "undefined" && app?.get) {
        app.get("/api/nba/stats/status", (req, res) => {
          const db = getDB();
          if (!db) return res.json({ ok: false, error: "DB not found" });

          const keys = Object.keys(db || {});
          const out = {
            ok: true,
            foundDB: true,
            where:
              (app?.locals?.db ? "app.locals.db" : null) ||
              (typeof globalThis.readDB === "function" ? "globalThis.readDB()" : null) ||
              (globalThis.db ? "globalThis.db" : "unknown"),
            dbKeysSample: keys.slice(0, 25),
            counts: {
              nbaPlayerGameLogs: len(db.nbaPlayerGameLogs),
              nbaStats: len(db.nbaStats),
              nbaProcessedEvents: len(db.nbaProcessedEvents),
              sgoPropLines: len(db.sgoPropLines),
              hardrockPropLines: len(db.hardrockPropLines),
            },
            now: new Date().toISOString(),
          };

          if (globalThis.__PT_NBA_LEADERS_CACHE?.ts) {
            out.leadersCache = {
              ts: globalThis.__PT_NBA_LEADERS_CACHE.ts,
              source: globalThis.__PT_NBA_LEADERS_CACHE.source || null,
            };
          }

          return res.json(out);
        });

        console.log("[patch] nba-stats-status ready ✅  GET /api/nba/stats/status");
      } else {
        console.log("[patch] nba-stats-status skipped (app missing) ⚠️");
      }
    } catch (e) {
      console.log("[patch] nba-stats-status failed ⚠️", String(e?.message || e));
    }

    const warmLeaders = () => {
      try {
        if (typeof globalThis.__PT_buildNbaLeaders === "function") {
          const result = globalThis.__PT_buildNbaLeaders();
          globalThis.__PT_NBA_LEADERS_CACHE = {
            ts: new Date().toISOString(),
            source: result?.source || null,
            leaders: result?.leaders || result || null,
          };
          return true;
        }

        const db = getDB();
        if (!db) return false;

        const logs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];
        if (!logs.length) return false;

        const agg = new Map();
        for (const r of logs) {
          const player = r?.player || r?.playerName || r?.name;
          if (!player) continue;
          const team = r?.team || r?.teamName || r?.teamFullName || "";
          const key = `${player}||${team}`;
          if (!agg.has(key)) agg.set(key, { player, team, gp: 0, pts: 0, reb: 0, ast: 0, threes: 0 });
          const a = agg.get(key);
          a.gp += 1;
          a.pts += Number(r?.pts ?? r?.points ?? 0) || 0;
          a.reb += Number(r?.reb ?? r?.rebounds ?? 0) || 0;
          a.ast += Number(r?.ast ?? r?.assists ?? 0) || 0;
          a.threes += Number(r?.fg3m ?? r?.threesMade ?? r?.threePM ?? 0) || 0;
        }

        const arr = Array.from(agg.values()).filter((x) => x.gp > 0);
        const topAvg = (field) =>
          arr
            .map((x) => ({ player: x.player, team: x.team, gp: x.gp, value: x[field] / x.gp }))
            .sort((a, b) => (b.value || 0) - (a.value || 0))
            .slice(0, 25)
            .map((x) => ({ ...x, value: Math.round(x.value * 10) / 10 }));

        const leaders = {
          points: topAvg("pts"),
          rebounds: topAvg("reb"),
          assists: topAvg("ast"),
          threes: topAvg("threes"),
        };

        globalThis.__PT_NBA_LEADERS_CACHE = {
          ts: new Date().toISOString(),
          source: "warm:computed:nbaPlayerGameLogs",
          leaders,
        };
        return true;
      } catch {
        return false;
      }
    };

    // POST /api/nba/stats/warm
    try {
      if (typeof app !== "undefined" && app?.post) {
        app.post("/api/nba/stats/warm", (req, res) => {
          const ok = warmLeaders();
          if (!ok) return res.status(500).json({ ok: false, error: "Warm failed (db/logs missing?)" });
          return res.json({ ok: true, warmed: true, ts: globalThis.__PT_NBA_LEADERS_CACHE?.ts || null });
        });

        console.log("[patch] nba-stats-warm ready ✅  POST /api/nba/stats/warm");
      } else {
        console.log("[patch] nba-stats-warm skipped (app missing) ⚠️");
      }
    } catch (e) {
      console.log("[patch] nba-stats-warm failed ⚠️", String(e?.message || e));
    }

    setTimeout(() => {
      try {
        const db = getDB();
        if (!db) return;
        if (!globalThis.__PT_NBA_LEADERS_CACHE?.leaders) {
          const ok = warmLeaders();
          if (ok) console.log("[patch] nba leaders auto-warm ✅", globalThis.__PT_NBA_LEADERS_CACHE?.ts || "");
          else console.log("[patch] nba leaders auto-warm skipped (no data) ⏭️");
        }
      } catch {}
    }, 3000);
  } catch (e) {
    console.log("[patch] nba-stats-status/warm wrapper failed ⚠️", String(e?.message || e));
  }
})();
/* =========================
   END: NBA stats status + warm patch
   ========================= */


/* ===========================
   NBA STATS: request logger + wildcard fallback
   Paste-at-bottom block
   =========================== */
(() => {
  try {
    if (!app || typeof app.use !== "function") {
      console.log("[patch] nba-stats wildcard skipped (app missing)");
      return;
    }

    // Log any stats-related request so we can see what the UI is actually calling.
    app.use((req, res, next) => {
      try {
        if (req.path && req.path.startsWith("/api/nba/stats")) {
          console.log(`[stats-hit] ${req.method} ${req.originalUrl}`);
        }
      } catch {}
      next();
    });

    const send = (res, code, obj) => {
      try { return res.status(code).json(obj); } catch { return; }
    };

    // Wildcard: if the UI calls ANY /api/nba/stats/* route, respond safely.
    // This prevents blank tabs caused by 404s or unexpected endpoints.
    app.all("/api/nba/stats/*", async (req, res) => {
      try {
        const p = String(req.path || "");
        // Canonical routes (if UI calls variants like /leaders/ or /leaders.json etc)
        if (p.includes("/leaders")) return res.redirect(302, "/api/nba/stats/leaders");
        if (p.includes("/status"))  return res.redirect(302, "/api/nba/stats/status");
        if (p.includes("/warm"))    return res.redirect(307, "/api/nba/stats/warm");

        // Default fallback payload (never 404)
        return send(res, 200, {
          ok: true,
          fallback: true,
          path: req.path,
          note: "Wildcard fallback hit. UI called a stats endpoint that was not explicitly defined; returning safe JSON."
        });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    });

    console.log("[patch] nba-stats wildcard+logger loaded ✅");
  } catch (e) {
    console.log("[patch] nba-stats wildcard+logger FAILED ❌", e && e.message ? e.message : e);
  }
})();


/* ===========================
   NBA STATS: aliases + debug page
   Paste-at-bottom block
   =========================== */
(() => {
  try {
    if (!app || typeof app.get !== "function") {
      console.log("[patch] nba-stats aliases skipped (app missing)");
      return;
    }

    // Helper to safely call existing leaders handler via internal fetch to self
    async function getLeadersJSON() {
      const url = "http://127.0.0.1:3000/api/nba/stats/leaders";
      const r = await fetch(url);
      const t = await r.text();
      try { return JSON.parse(t); } catch { return { ok:false, error:"leaders not json", raw: t.slice(0,300) }; }
    }

    // Aliases: if the frontend calls any of these, return leaders JSON
    const aliasPaths = [
      "/api/nba/stats",                 // common “base” call
      "/api/nba/stats/",                // trailing slash
      "/api/nba/leaders",               // older naming
      "/api/nba/stats/leaderboard",
      "/api/nba/stats/leaders.json",
      "/api/nba/stats/leaders/",        // trailing slash
      "/api/nba/stats/summary"
    ];

    for (const p of aliasPaths) {
      app.get(p, async (req, res) => {
        try {
          console.log(`[stats-hit] GET ${req.originalUrl} (alias->leaders)`);
          const data = await getLeadersJSON();
          return res.json(data);
        } catch (e) {
          return res.status(500).json({ ok:false, error: String(e?.message || e) });
        }
      });
    }

    // Warm: support GET too (some UIs do GET by accident)
    app.get("/api/nba/stats/warm", async (req, res) => {
      try {
        console.log(`[stats-hit] GET ${req.originalUrl} (warm via GET)`);
        // Call the POST warm endpoint internally
        const r = await fetch("http://127.0.0.1:3000/api/nba/stats/warm", { method: "POST" });
        const t = await r.text();
        try { return res.json(JSON.parse(t)); } catch { return res.json({ ok:true, note:"warm returned non-json", raw:t.slice(0,200) }); }
      } catch (e) {
        return res.status(500).json({ ok:false, error: String(e?.message || e) });
      }
    });

    // Debug page you can open in the phone browser: shows what fetch returns
    app.get("/pt/debug/stats", async (req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="font-family: monospace; padding: 12px">
  <h3>Stats Debug</h3>
  <button onclick="go()">Fetch /api/nba/stats/leaders</button>
  <pre id="out">Tap the button.</pre>
  <script>
    async function go(){
      const out = document.getElementById('out');
      out.textContent = 'loading...';
      try{
        const r = await fetch('/api/nba/stats/leaders', { cache: 'no-store' });
        const t = await r.text();
        out.textContent = 'HTTP ' + r.status + '\\n\\n' + t;
      }catch(e){
        out.textContent = 'FETCH ERROR: ' + (e && e.message ? e.message : String(e));
      }
    }
  </script>
</body>
</html>`);
    });

    console.log("[patch] nba-stats aliases+debug loaded ✅  GET /pt/debug/stats");
  } catch (e) {
    console.log("[patch] nba-stats aliases+debug FAILED ❌", e && e.message ? e.message : e);
  }
})();

/* ===========================
   PT CONSOLIDATED BOTTOM PATCH
   - games-map (ESPN NBA+NCAAM, date-aware)
   - games-map2 (pretty labels)
   - active slate date from SGO props
   - props-for-date (SGO, date-aware)
   - edges endpoints date injection wrapper
   - stats leaders/status/warm + aliases + wildcard
   - optional props archive/dates
   Paste at ABSOLUTE BOTTOM of protracker.js
   =========================== */
(() => {
  "use strict";

  // ---- guard (safe if pasted multiple times) ----
  if (globalThis.__PT_CONSOLIDATED_PATCH_LOADED__) {
    try { console.log("[pt] consolidated patch already loaded ✅"); } catch {}
    return;
  }
  globalThis.__PT_CONSOLIDATED_PATCH_LOADED__ = true;

  // ---- find app (Express) ----
  const getApp = () => {
    try { if (typeof app !== "undefined" && app?.get && app?.use) return app; } catch {}
    try { if (globalThis.app?.get && globalThis.app?.use) return globalThis.app; } catch {}
    try { if (global?.app?.get && global?.app?.use) return global.app; } catch {}
    // last-resort: scan require.cache exports
    try {
      const cache = require.cache || {};
      for (const k of Object.keys(cache)) {
        const exp = cache[k]?.exports;
        if (!exp) continue;
        if (exp?.get && exp?.use && exp?.listen) return exp;
        if (exp?.app?.get && exp?.app?.use && exp?.app?.listen) return exp.app;
        if (exp?.default?.get && exp?.default?.use && exp?.default?.listen) return exp.default;
      }
    } catch {}
    return null;
  };

  const appRef = getApp();
  if (!appRef) {
    try { console.log("[pt] consolidated patch: app not found ❌"); } catch {}
    return;
  }

  // expose app (helps other patches)
  try { globalThis.app = appRef; } catch {}
  try { global.app = appRef; } catch {}

  // ---- fetch polyfill (Node<18) ----
  const getFetch = () => {
    try { if (typeof fetch === "function") return fetch; } catch {}
    try { return require("node-fetch"); } catch {}
    return null;
  };
  const _fetch = getFetch();

  // ---- helpers: route removal + handler lookup ----
  const removeRoute = (path, method = "get") => {
    try {
      const m = String(method).toLowerCase();
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return 0;
      const before = stack.length;
      appRef._router.stack = stack.filter((layer) => {
        if (!layer?.route) return true;
        if (layer.route.path !== path) return true;
        return !(layer.route.methods && layer.route.methods[m]);
      });
      return before - appRef._router.stack.length;
    } catch {
      return 0;
    }
  };

  const findHandler = (path, method = "get") => {
    try {
      const m = String(method).toLowerCase();
      const stack = appRef?._router?.stack;
      if (!Array.isArray(stack)) return null;
      for (const layer of stack) {
        const r = layer?.route;
        if (!r) continue;
        if (r.path !== path) continue;
        if (!r.methods?.[m]) continue;
        const hs = r.stack || [];
        if (!hs.length) continue;
        return hs[hs.length - 1].handle; // last handler
      }
    } catch {}
    return null;
  };

  // ---- time helpers (America/New_York) ----
  const isoDateET = (d = new Date()) => {
    try {
      const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
      const dt = new Date(s);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    } catch {
      // fallback: local date
      const dt = new Date();
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    }
  };

  const yyyymmdd = (dateISO) => String(dateISO || "").replaceAll("-", "");

  // ---- DB detection (supports arrays, lowdb .data, sqlite handles, loki-ish collections) ----
  const isCollectionLike = (v) => {
    if (!v) return false;
    if (Array.isArray(v)) return true;
    if (v instanceof Map) return true;
    if (typeof v.find === "function") return true;
    if (typeof v.all === "function") return true;
    if (typeof v.toArray === "function") return true;
    return false;
  };

  const isDbLike = (v) => {
    if (!v || typeof v !== "object") return false;

    // sqlite handle (better-sqlite3)
    if (typeof v.prepare === "function") return true;

    // lowdb-ish
    if (v.data && typeof v.data === "object") {
      if (Array.isArray(v.data.sgoPropLines) || Array.isArray(v.data.hardrockPropLines)) return true;
    }

    // plain object DB-ish
    if (isCollectionLike(v.sgoPropLines) || isCollectionLike(v.hardrockPropLines)) return true;
    if (isCollectionLike(v.nbaPlayerGameLogs) || isCollectionLike(v.nbaStats)) return true;

    return false;
  };

  const unwrapDb = (v) => {
    if (!v) return null;
    if (isDbLike(v)) return v;
    if (v.db && isDbLike(v.db)) return v.db;
    if (v.default && isDbLike(v.default)) return v.default;
    if (v.data && isDbLike(v.data)) return v.data;
    return null;
  };

  const getDB = () => {
    // prefer existing exposures
    try { if (unwrapDb(appRef?.locals?.db)) return unwrapDb(appRef.locals.db); } catch {}
    try { if (unwrapDb(globalThis.db)) return unwrapDb(globalThis.db); } catch {}
    try { if (unwrapDb(global.db)) return unwrapDb(global.db); } catch {}
    try { if (typeof readDB === "function") return unwrapDb(readDB()) || readDB(); } catch {}

    // scan app.locals
    try {
      const L = appRef?.locals;
      if (L && typeof L === "object") {
        for (const k of Object.keys(L)) {
          const u = unwrapDb(L[k]);
          if (u) return u;
        }
      }
    } catch {}

    // scan globals (last resort)
    try {
      const names = Object.getOwnPropertyNames(globalThis);
      for (const k of names) {
        let v;
        try { v = globalThis[k]; } catch { continue; }
        const u = unwrapDb(v);
        if (u) return u;
      }
    } catch {}

    return null;
  };

  const exposeDB = () => {
    const dbNow = getDB();
    if (!dbNow) return null;
    try { appRef.locals.db = dbNow; } catch {}
    try { globalThis.db = dbNow; } catch {}
    try { global.db = dbNow; } catch {}
    return dbNow;
  };

  // ---- normalize "rows from collection" helper ----
  const rowsFrom = (col) => {
    if (!col) return [];
    if (Array.isArray(col)) return col;

    // lowdb wrapper
    if (Array.isArray(col.data)) return col.data;

    // loki-like
    if (typeof col.find === "function") {
      try {
        const r = col.find();
        if (Array.isArray(r)) return r;
      } catch {}
      try {
        const r = col.find(() => true);
        if (Array.isArray(r)) return r;
      } catch {}
    }

    if (typeof col.all === "function") {
      try {
        const r = col.all();
        if (Array.isArray(r)) return r;
      } catch {}
    }

    if (typeof col.toArray === "function") {
      try {
        const r = col.toArray();
        if (Array.isArray(r)) return r;
      } catch {}
    }

    // map/object
    if (col && typeof col === "object") {
      try { return Object.keys(col).map((k) => col[k]).filter(Boolean); } catch {}
    }

    return [];
  };

  // ---- Active slate date based on SGO props (earliest upcoming >= today) ----
  const listPropDates = (DB) => {
    const dates = new Set();

    // sqlite
    try {
      if (DB && typeof DB.prepare === "function") {
        // ensure table exists
        const t = DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get("sgoPropLines");
        if (t?.name) {
          const rows = DB.prepare(
            "SELECT DISTINCT dateISO as d FROM sgoPropLines WHERE dateISO IS NOT NULL AND dateISO != ''"
          ).all();
          for (const r of rows || []) {
            const d = String(r?.d || "").slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
          }
          return Array.from(dates).sort();
        }
      }
    } catch {}

    // memory collections/arrays
    try {
      const src = DB?.sgoPropLines || (DB?.data && DB.data.sgoPropLines) || null;
      const arr = rowsFrom(src);
      for (const r of arr) {
        const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
      }
    } catch {}

    return Array.from(dates).sort();
  };

  const pickActiveDate = (reqDate) => {
    if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(String(reqDate))) return String(reqDate);
    const DB = exposeDB();
    const today = isoDateET();

    if (!DB) return today;

    const dates = listPropDates(DB);
    if (!dates.length) return today;

    // earliest upcoming
    for (const d of dates) if (d >= today) return d;

    // fallback: latest
    return dates[dates.length - 1] || today;
  };

  // expose helper
  try { globalThis.__PT_pickActiveDate__ = pickActiveDate; } catch {}

  // ---- ESPN scoreboard -> games map ----
  const fetchEspnEvents = async (url) => {
    if (!_fetch) return [];
    try {
      const r = await _fetch(url, { headers: { "user-agent": "protracker/1.0" } });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j?.events) ? j.events : [];
    } catch {
      return [];
    }
  };

  const mapFromEspnEvents = (events, leagueTag) => {
    const out = {};
    for (const ev of events || []) {
      const eventId = ev?.id;
      if (!eventId) continue;

      const comp = ev?.competitions?.[0];
      const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
      const home = competitors.find((c) => c?.homeAway === "home");
      const away = competitors.find((c) => c?.homeAway === "away");

      const homeName =
        home?.team?.displayName || home?.team?.shortDisplayName || home?.team?.name || null;
      const awayName =
        away?.team?.displayName || away?.team?.shortDisplayName || away?.team?.name || null;

      const startTime = comp?.date || ev?.date || null;

      const label = homeName && awayName ? `${awayName} @ ${homeName}` : `eventId ${eventId}`;

      out[String(eventId)] = {
        eventId: String(eventId),
        label,
        startTime,
        league: leagueTag,
        homeTeam: homeName,
        awayTeam: awayName,
      };
    }
    return out;
  };

  // ---- /api/games-map (no loop, date-aware, ESPN NBA + NCAAM) ----
  removeRoute("/api/games-map", "get");
  appRef.get("/api/games-map", async (req, res) => {
    try {
      const dateISO = pickActiveDate(req.query?.date) || isoDateET();
      const d = yyyymmdd(dateISO);

      const nbaUrl = `https://site.api.espn.com/apis/v2/sports/basketball/nba/scoreboard?dates=${d}`;
      const ncaaUrl = `https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d}`;

      const [nbaEvents, ncaaEvents] = await Promise.all([
        fetchEspnEvents(nbaUrl),
        fetchEspnEvents(ncaaUrl),
      ]);

      const map = {
        ...mapFromEspnEvents(nbaEvents, "NBA"),
        ...mapFromEspnEvents(ncaaEvents, "NCAAM"),
      };

      return res.json({
        ok: true,
        date: dateISO,
        count: Object.keys(map).length,
        map,
        src: ["ESPN:nba", "ESPN:mens-college-basketball"],
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
  try { console.log("[pt] /api/games-map loaded ✅ (ESPN NBA+NCAAM, date-aware, no loop)"); } catch {}

  // ---- local fetch helper for /api/games-map2 (prevents duplication) ----
  const http = (() => { try { return require("http"); } catch { return null; } })();
  const fetchLocalJSON = (path, port = 3000) =>
    new Promise((resolve, reject) => {
      if (!http) return reject(new Error("http module unavailable"));
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (resp) => {
          let body = "";
          resp.on("data", (c) => (body += c));
          resp.on("end", () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error("Bad JSON from " + path + ": " + body.slice(0, 200))); }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

  // ---- /api/games-map2 (formatted view of games-map) ----
  removeRoute("/api/games-map2", "get");
  removeRoute("/api/games-map2-debug", "get");

  appRef.get("/api/games-map2-debug", async (req, res) => {
    try {
      const dateISO = pickActiveDate(req.query?.date) || "";
      const path = "/api/games-map" + (dateISO ? `?date=${encodeURIComponent(dateISO)}` : "");
      const gm = await fetchLocalJSON(path);
      const keys = gm?.map ? Object.keys(gm.map) : [];
      return res.json({
        ok: true,
        src: path,
        gamesMapCount: keys.length,
        sample: keys.slice(0, 5).map((k) => gm.map[k]),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  appRef.get("/api/games-map2", async (req, res) => {
    try {
      const dateISO = pickActiveDate(req.query?.date) || "";
      const path = "/api/games-map" + (dateISO ? `?date=${encodeURIComponent(dateISO)}` : "");
      const gm = await fetchLocalJSON(path);
      const srcMap = gm?.map || {};
      const out = {};

      for (const [eventId, g] of Object.entries(srcMap)) {
        const home = g.homeTeam || g.home || g.ht || null;
        const away = g.awayTeam || g.away || g.at || null;
        const label =
          home && away ? `${away} @ ${home}` :
          g.label ? String(g.label) :
          `eventId ${eventId}`;

        out[eventId] = {
          eventId: String(eventId),
          label,
          startTime: g.startTime || null,
          league: g.league || null,
          homeTeam: home,
          awayTeam: away,
        };
      }

      return res.json({ ok: true, count: Object.keys(out).length, map: out, src: path });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  try { console.log("[pt] /api/games-map2 loaded ✅ (formatted passthrough)"); } catch {}

  // ---- /api/props/dates + /api/props/active-date ----
  removeRoute("/api/props/dates", "get");
  appRef.get("/api/props/dates", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) return res.status(500).json({ ok: false, error: "DB not found" });

      const today = isoDateET();
      const all = String(req.query?.all || "") === "1";
      const dates = listPropDates(DB);
      const out = all ? dates : dates.filter((d) => d >= today);

      return res.json({ ok: true, todayET: today, count: out.length, dates: out, mode: all ? "all" : "upcoming" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  removeRoute("/api/props/active-date", "get");
  appRef.get("/api/props/active-date", (req, res) => {
    try {
      const today = isoDateET();
      const activeDate = pickActiveDate(req.query?.date);
      return res.json({ ok: true, todayET: today, activeDate, where: "consolidated" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- optional archive store (in-memory) ----
  const ensureArchive = (DB) => {
    if (!DB.propsArchive || typeof DB.propsArchive !== "object") DB.propsArchive = {};
    return DB.propsArchive;
  };

  // ---- /api/odds/sgo/props-for-date (date-aware, archive-first) ----
  removeRoute("/api/odds/sgo/props-for-date", "get");
  appRef.get("/api/odds/sgo/props-for-date", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) return res.status(500).json({ ok: false, error: "DB not found" });

      const limit = Math.max(1, Math.min(5000, Number(req.query?.limit || 200)));
      const league = String(req.query?.league || "NBA").toUpperCase();

      let dateISO = String(req.query?.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) dateISO = pickActiveDate();

      const archive = ensureArchive(DB);
      const archivedRows = Array.isArray(archive[dateISO]) ? archive[dateISO] : null;
      if (archivedRows) {
        const rows = archivedRows
          .filter((r) => String(r?.league || "").toUpperCase() === league)
          .slice(0, limit);
        return res.json({ ok: true, source: "archive", league, date: dateISO, count: rows.length, rows });
      }

      // sqlite
      try {
        if (typeof DB.prepare === "function") {
          const t = DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get("sgoPropLines");
          if (t?.name) {
            const rows = DB.prepare(
              "SELECT * FROM sgoPropLines WHERE dateISO = ? AND UPPER(COALESCE(league,'')) = ? LIMIT ?"
            ).all(dateISO, league, limit);
            return res.json({ ok: true, source: "sqlite", league, date: dateISO, count: rows.length, rows });
          }
        }
      } catch {}

      // memory
      const src = DB.sgoPropLines || (DB.data && DB.data.sgoPropLines) || null;
      const arr = rowsFrom(src);

      const rows = [];
      for (const r of arr) {
        const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
        if (d !== dateISO) continue;
        if (String(r?.league || "").toUpperCase() !== league) continue;
        rows.push(r);
        if (rows.length >= limit) break;
      }

      return res.json({ ok: true, source: "live", league, date: dateISO, count: rows.length, rows });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- archive endpoint (copies current live rows into archive[date]) ----
  removeRoute("/api/props/archive", "post");
  appRef.post("/api/props/archive", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) return res.status(500).json({ ok: false, error: "DB not found" });

      const dateISO = String(req.query?.date || req.body?.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
        return res.status(400).json({ ok: false, error: "Missing/invalid date (use YYYY-MM-DD)" });
      }

      const src = DB.sgoPropLines || (DB.data && DB.data.sgoPropLines) || null;
      const arr = rowsFrom(src);

      const rows = arr.filter((r) => String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10) === dateISO);

      const archive = ensureArchive(DB);
      archive[dateISO] = rows;

      return res.json({ ok: true, date: dateISO, archivedCount: rows.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- auto-freeze yesterday once (best effort) ----
  try {
    const DB = exposeDB();
    if (DB) {
      const today = isoDateET();
      const yday = (() => {
        const [y, m, d] = today.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - 1);
        const yy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(dt.getUTCDate()).padStart(2, "0");
        return `${yy}-${mm}-${dd}`;
      })();

      const archive = ensureArchive(DB);
      if (!archive[yday]) {
        const src = DB.sgoPropLines || (DB.data && DB.data.sgoPropLines) || null;
        const arr = rowsFrom(src);
        const rows = arr.filter((r) => String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10) === yday);
        if (rows.length) {
          archive[yday] = rows;
          try { console.log(`[pt] auto-freeze archived yesterday ✅ ${yday} count=${rows.length}`); } catch {}
        }
      }
    }
  } catch {}

  // ---- edges endpoints: wrap to inject active date when ?date missing ----
  const wrapDateInto = (path) => {
    const old = findHandler(path, "get");
    if (!old) return false;
    removeRoute(path, "get");
    appRef.get(path, (req, res, next) => {
      try {
        if (!req.query) req.query = {};
        if (!req.query.date) req.query.date = pickActiveDate();
        req.query.__PT_ACTIVE_DATE__ = req.query.date;
      } catch {}
      return old(req, res, next);
    });
    return true;
  };

  const okEdges1 = wrapDateInto("/api/nba/edges-today");
  const okEdges2 = wrapDateInto("/api/nba/edges-today-tiered");
  try { console.log(`[pt] edges wrappers loaded ✅ (edges=${okEdges1}, tiered=${okEdges2})`); } catch {}

  // =========================
  // NBA STATS: leaders/status/warm + aliases + wildcard logger
  // =========================

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const pick = (obj, keys) => {
    for (const k of keys) if (obj && obj[k] != null) return obj[k];
    return null;
  };

  const buildLeadersFromGameLogs = (rows) => {
    const byPlayer = new Map();

    for (const r of rows) {
      const player =
        pick(r, ["player", "playerName", "name", "fullName"]) ||
        (r.player && (r.player.name || r.player.fullName)) ||
        null;
      if (!player) continue;

      const team =
        pick(r, ["team", "teamAbbr", "teamAbbrev", "abbreviation"]) ||
        (r.team && (r.team.abbreviation || r.team.abbr || r.team.name)) ||
        null;

      const pts = num(pick(r, ["PTS", "points", "pt", "pts"]));
      const reb = num(pick(r, ["REB", "rebounds", "reb", "trb"]));
      const ast = num(pick(r, ["AST", "assists", "ast"]));
      const threes = num(pick(r, ["FG3M", "fg3m", "3PM", "threeMade", "threesMade"]));

      const key = `${player}||${team || ""}`;
      const cur = byPlayer.get(key) || { player, team, gp: 0, pts: 0, reb: 0, ast: 0, threes: 0 };
      cur.gp += 1;
      cur.pts += pts;
      cur.reb += reb;
      cur.ast += ast;
      cur.threes += threes;
      byPlayer.set(key, cur);
    }

    const arr = Array.from(byPlayer.values())
      .filter((x) => x.gp > 0)
      .map((x) => ({
        player: x.player,
        team: x.team || null,
        gp: x.gp,
        ppg: x.pts / x.gp,
        rpg: x.reb / x.gp,
        apg: x.ast / x.gp,
        tpg: x.threes / x.gp,
      }));

    const top = (field) =>
      arr
        .slice()
        .sort((a, b) => (b[field] || 0) - (a[field] || 0))
        .slice(0, 25)
        .map((x) => ({ player: x.player, team: x.team, gp: x.gp, value: Number((x[field] || 0).toFixed(2)) }));

    return {
      ok: true,
      source: "computed:nbaPlayerGameLogs",
      leaders: {
        points: top("ppg"),
        rebounds: top("rpg"),
        assists: top("apg"),
        threes: top("tpg"),
      },
    };
  };

  const buildLeadersFromNbaStats = (rows) => {
    const norm = rows
      .map((r) => {
        const player =
          pick(r, ["player", "playerName", "name", "fullName"]) ||
          (r.player && (r.player.name || r.player.fullName)) ||
          null;
        if (!player) return null;

        const team =
          pick(r, ["team", "teamAbbr", "teamAbbrev", "abbreviation"]) ||
          (r.team && (r.team.abbreviation || r.team.abbr || r.team.name)) ||
          null;

        const gp = Math.max(1, num(pick(r, ["GP", "gp", "games", "gamesPlayed"])));
        const ppg = num(pick(r, ["PPG", "ppg"])) || (num(pick(r, ["PTS", "points", "pts"])) / gp);
        const rpg = num(pick(r, ["RPG", "rpg"])) || (num(pick(r, ["REB", "rebounds", "reb"])) / gp);
        const apg = num(pick(r, ["APG", "apg"])) || (num(pick(r, ["AST", "assists", "ast"])) / gp);
        const tpg = num(pick(r, ["TPG", "tpg", "3PG", "threePerGame"])) || (num(pick(r, ["FG3M", "fg3m", "3PM"])) / gp);

        return { player, team, gp, ppg, rpg, apg, tpg };
      })
      .filter(Boolean);

    const top = (field) =>
      norm
        .slice()
        .sort((a, b) => (b[field] || 0) - (a[field] || 0))
        .slice(0, 25)
        .map((x) => ({ player: x.player, team: x.team, gp: x.gp, value: Number((x[field] || 0).toFixed(2)) }));

    return {
      ok: true,
      source: "computed:nbaStats",
      leaders: {
        points: top("ppg"),
        rebounds: top("rpg"),
        assists: top("apg"),
        threes: top("tpg"),
      },
    };
  };

  // ---- leaders endpoint ----
  removeRoute("/api/nba/stats/leaders", "get");
  appRef.get("/api/nba/stats/leaders", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) {
        return res.json({
          ok: true,
          source: null,
          leaders: { points: [], rebounds: [], assists: [], threes: [] },
          note: "No db available.",
        });
      }

      const logs = rowsFrom(DB.nbaPlayerGameLogs || (DB.data && DB.data.nbaPlayerGameLogs));
      if (logs.length) return res.json(buildLeadersFromGameLogs(logs));

      const stats = rowsFrom(DB.nbaStats || (DB.data && DB.data.nbaStats));
      if (stats.length) return res.json(buildLeadersFromNbaStats(stats));

      // cache fallback if warm ran
      if (globalThis.__PT_NBA_LEADERS_CACHE?.leaders) {
        return res.json({
          ok: true,
          source: globalThis.__PT_NBA_LEADERS_CACHE.source || "cache",
          leaders: globalThis.__PT_NBA_LEADERS_CACHE.leaders,
          ts: globalThis.__PT_NBA_LEADERS_CACHE.ts || null,
        });
      }

      return res.json({
        ok: true,
        source: null,
        leaders: { points: [], rebounds: [], assists: [], threes: [] },
        note: "No leaders found (need nbaPlayerGameLogs or nbaStats).",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- status endpoint ----
  removeRoute("/api/nba/stats/status", "get");
  appRef.get("/api/nba/stats/status", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) return res.json({ ok: false, error: "DB not found" });

      const len = (x) => (Array.isArray(x) ? x.length : rowsFrom(x).length);

      return res.json({
        ok: true,
        now: new Date().toISOString(),
        where: (appRef?.locals?.db ? "app.locals.db" : null) || (globalThis.db ? "globalThis.db" : "unknown"),
        counts: {
          nbaPlayerGameLogs: len(DB.nbaPlayerGameLogs),
          nbaStats: len(DB.nbaStats),
          sgoPropLines: len(DB.sgoPropLines),
          hardrockPropLines: len(DB.hardrockPropLines),
        },
        leadersCache: globalThis.__PT_NBA_LEADERS_CACHE
          ? { ts: globalThis.__PT_NBA_LEADERS_CACHE.ts || null, source: globalThis.__PT_NBA_LEADERS_CACHE.source || null }
          : null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- warm endpoint (precompute cache) ----
  const warmLeaders = () => {
    const DB = exposeDB();
    if (!DB) return false;

    const logs = rowsFrom(DB.nbaPlayerGameLogs || (DB.data && DB.data.nbaPlayerGameLogs));
    if (!logs.length) return false;

    const built = buildLeadersFromGameLogs(logs);
    globalThis.__PT_NBA_LEADERS_CACHE = {
      ts: new Date().toISOString(),
      source: built.source,
      leaders: built.leaders,
    };
    return true;
  };

  removeRoute("/api/nba/stats/warm", "post");
  appRef.post("/api/nba/stats/warm", (req, res) => {
    try {
      const ok = warmLeaders();
      if (!ok) return res.status(500).json({ ok: false, error: "Warm failed (db/logs missing?)" });
      return res.json({ ok: true, warmed: true, ts: globalThis.__PT_NBA_LEADERS_CACHE?.ts || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- aliases (frontend might call different paths) ----
  const aliasPaths = [
    "/api/nba/stats",
    "/api/nba/stats/",
    "/api/nba/leaders",
    "/api/nba/stats/leaderboard",
    "/api/nba/stats/leaders.json",
    "/api/nba/stats/leaders/",
    "/api/nba/stats/summary",
  ];
  for (const p of aliasPaths) {
    removeRoute(p, "get");
    appRef.get(p, (req, res) => {
      try { req.url = "/api/nba/stats/leaders"; } catch {}
      return appRef._router.handle(req, res, () => {});
    });
  }

  // allow GET warm too (some UIs mistakenly do GET)
  removeRoute("/api/nba/stats/warm", "get");
  appRef.get("/api/nba/stats/warm", (req, res) => {
    try {
      const ok = warmLeaders();
      if (!ok) return res.status(500).json({ ok: false, error: "Warm failed (db/logs missing?)" });
      return res.json({ ok: true, warmed: true, ts: globalThis.__PT_NBA_LEADERS_CACHE?.ts || null, via: "GET" });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- request logger for stats ----
  try {
    appRef.use((req, res, next) => {
      try {
        if (req?.path && String(req.path).startsWith("/api/nba/stats")) {
          console.log(`[stats-hit] ${req.method} ${req.originalUrl}`);
        }
      } catch {}
      next();
    });
  } catch {}

  // ---- wildcard fallback for unknown /api/nba/stats/* so UI never blanks on 404 ----
  // NOTE: must be AFTER explicit handlers to avoid intercepting them.
  removeRoute("/api/nba/stats/*", "all");
  try {
    appRef.all("/api/nba/stats/*", (req, res) => {
      try {
        const p = String(req.path || "");
        if (p.includes("/leaders")) return res.redirect(302, "/api/nba/stats/leaders");
        if (p.includes("/status")) return res.redirect(302, "/api/nba/stats/status");
        if (p.includes("/warm")) return res.redirect(307, "/api/nba/stats/warm");
        return res.status(200).json({
          ok: true,
          fallback: true,
          path: req.path,
          note: "Wildcard fallback hit. Define this stats endpoint if UI expects more data.",
        });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });
  } catch {}

  // ---- quick-links endpoint (date-aware) ----
  removeRoute("/api/pt/quick-links", "get");
  appRef.get("/api/pt/quick-links", (req, res) => {
    try {
      const activeDate = pickActiveDate(req.query?.date);
      return res.json({
        ok: true,
        todayET: isoDateET(),
        activeDate,
        links: {
          activeDate: `/api/props/active-date`,
          propDates: `/api/props/dates`,
          gamesMap: `/api/games-map?date=${activeDate}`,
          gamesMap2: `/api/games-map2?date=${activeDate}`,
          props: `/api/odds/sgo/props-for-date?date=${activeDate}&league=NBA&limit=50`,
          edgesTiered: `/api/nba/edges-today-tiered?date=${activeDate}&minEdge=0.5&games=20`,
          statsLeaders: `/api/nba/stats/leaders`,
          statsStatus: `/api/nba/stats/status`,
        },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- db debug endpoint ----
  removeRoute("/api/pt/db-debug", "get");
  appRef.get("/api/pt/db-debug", (req, res) => {
    try {
      const DB = exposeDB();
      if (!DB) return res.json({ ok: true, foundDB: false });
      const keys = Object.keys(DB || {}).slice(0, 60);
      return res.json({
        ok: true,
        foundDB: true,
        todayET: isoDateET(),
        sampleKeys: keys,
        hasSgoPropLines: !!(DB.sgoPropLines || (DB.data && DB.data.sgoPropLines)),
        hasNbaLogs: !!(DB.nbaPlayerGameLogs || (DB.data && DB.data.nbaPlayerGameLogs)),
        hasNbaStats: !!(DB.nbaStats || (DB.data && DB.data.nbaStats)),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- routes listing (debug) ----
  removeRoute("/api/pt/routes", "get");
  appRef.get("/api/pt/routes", (req, res) => {
    try {
      const out = [];
      const stack = appRef?._router?.stack || [];
      for (const layer of stack) {
        const r = layer?.route;
        if (!r) continue;
        const methods = Object.keys(r.methods || {}).filter((k) => r.methods[k]).join(",");
        out.push(`${methods.toUpperCase()} ${r.path}`);
      }
      return res.json({ ok: true, count: out.length, routes: out.sort() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ---- initial DB expose attempt + optional auto-warm ----
  try {
    const DB = exposeDB();
    if (DB) console.log("[pt] DB exposed ✅");
    else console.log("[pt] DB not found yet ⚠️");
  } catch {}

  setTimeout(() => {
    try {
      const ok = warmLeaders();
      if (ok) console.log("[pt] nba leaders auto-warm ✅", globalThis.__PT_NBA_LEADERS_CACHE?.ts || "");
    } catch {}
  }, 3000);

  try { console.log("[pt] consolidated patch loaded ✅"); } catch {}
})();


/* ===========================
   PT FORCE ROUTE RESET (paste at absolute bottom)
   - Removes/re-adds key routes cleanly
   - Does NOT add wildcard middleware/loggers (prevents multiplying)
   =========================== */
(() => {
  try {
    if (globalThis.__PT_FORCE_RESET_LOADED__) {
      try { console.log("[patch] PT FORCE RESET already loaded ✅"); } catch {}
      return;
    }
    globalThis.__PT_FORCE_RESET_LOADED__ = true;

    const log = (...a) => { try { console.log(...a); } catch {} };

    const app =
      (() => {
        try { if (globalThis.app?.get) return globalThis.app; } catch {}
        try { if (global.app?.get) return global.app; } catch {}
        return null;
      })();

    if (!app || !app._router?.stack) {
      log("[patch] FORCE RESET: app not found ❌");
      return;
    }

    function removeRoute(method, path) {
      try {
        const m = String(method).toLowerCase();
        const before = app._router.stack.length;
        app._router.stack = app._router.stack.filter((layer) => {
          const r = layer?.route;
          if (!r) return true;
          if (r.path !== path) return true;
          if (!r.methods?.[m]) return true;
          return false;
        });
        return before - app._router.stack.length;
      } catch {
        return 0;
      }
    }

    function ymdET() {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date());
        const y = parts.find(p => p.type === "year")?.value || "0000";
        const m = parts.find(p => p.type === "month")?.value || "00";
        const d = parts.find(p => p.type === "day")?.value || "00";
        return `${y}-${m}-${d}`;
      } catch {
        const dt = new Date();
        return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
      }
    }

    function getDB() {
      try { if (app.locals?.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      try { if (typeof globalThis.readDB === "function") return globalThis.readDB(); } catch {}
      try { if (typeof readDB === "function") return readDB(); } catch {}
      return null;
    }

    function exposeDB() {
      const db = getDB();
      if (!db) return null;
      try { app.locals.db = db; } catch {}
      try { globalThis.db = db; } catch {}
      try { global.db = db; } catch {}
      return db;
    }

    // ---- hard remove key routes ----
    const paths = [
      "/api/pt/quick-links",
      "/api/pt/routes",
      "/api/props/active-date",
      "/api/props/dates",
      "/api/odds/sgo/props-for-date",
      "/api/nba/stats/leaders",
      "/api/nba/stats/status",
      "/api/nba/stats/warm",
      "/pt/debug/stats",
    ];
    let removed = 0;
    for (const p of paths) {
      removed += removeRoute("get", p);
      removed += removeRoute("post", p);
      removed += removeRoute("all", p);
    }
    log(`[patch] FORCE RESET: removed handlers ✅ (removed=${removed})`);

    // ---- re-add clean routes ----
    app.get("/api/pt/routes", (req, res) => {
      try {
        const out = [];
        for (const layer of (app._router.stack || [])) {
          const r = layer?.route;
          if (!r) continue;
          const methods = Object.keys(r.methods || {}).filter(k => r.methods[k]).join(",");
          out.push(`${methods.toUpperCase()} ${r.path}`);
        }
        res.json({ ok: true, count: out.length, routes: out.sort() });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    });

    app.get("/api/props/active-date", (req, res) => {
      const db = exposeDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });
      // simple default: today (you can upgrade later)
      return res.json({ ok: true, todayET: ymdET(), activeDate: ymdET(), note: "force-reset default" });
    });

    app.get("/api/props/dates", (req, res) => {
      const db = exposeDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });
      // lightweight: show unique dates from array/object sgoPropLines
      const src = db?.sgoPropLines;
      const set = new Set();
      const add = (r) => {
        const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
      };
      if (Array.isArray(src)) for (const r of src) add(r);
      else if (src && typeof src === "object") for (const k of Object.keys(src)) add(src[k]);
      const dates = Array.from(set).sort();
      res.json({ ok: true, todayET: ymdET(), count: dates.length, dates });
    });

    app.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = exposeDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });
      const dateISO = String(req.query.date || ymdET()).slice(0, 10);
      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const src = db?.sgoPropLines;
      let rows = [];
      if (Array.isArray(src)) rows = src.filter(r => String(r?.dateISO || r?.date || "").slice(0,10) === dateISO);
      else if (src && typeof src === "object") rows = Object.keys(src).map(k => src[k]).filter(r => String(r?.dateISO || r?.date || "").slice(0,10) === dateISO);
      res.json({ ok: true, date: dateISO, count: rows.length, rows: rows.slice(0, limit) });
    });

    // NBA leaders/status/warm placeholders (won't 404)
    app.get("/api/nba/stats/status", (req, res) => {
      const db = exposeDB();
      if (!db) return res.json({ ok: false, error: "DB not found" });
      const len = (x) => (Array.isArray(x) ? x.length : 0);
      res.json({
        ok: true,
        todayET: ymdET(),
        counts: {
          nbaPlayerGameLogs: len(db.nbaPlayerGameLogs),
          nbaStats: len(db.nbaStats),
          sgoPropLines: len(db.sgoPropLines),
        },
      });
    });

    app.get("/api/nba/stats/leaders", (req, res) => {
      res.json({ ok: true, source: "force-reset placeholder", leaders: { points: [], rebounds: [], assists: [], threes: [] } });
    });

    app.post("/api/nba/stats/warm", (req, res) => {
      res.json({ ok: true, warmed: true, ts: new Date().toISOString() });
    });

    app.get("/pt/debug/stats", (req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="font-family: monospace; padding: 12px">
  <h3>Stats Debug (Force Reset)</h3>
  <button onclick="go()">Fetch /api/nba/stats/status</button>
  <pre id="out">Tap the button.</pre>
  <script>
    async function go(){
      const out = document.getElementById('out');
      out.textContent = 'loading...';
      try{
        const r = await fetch('/api/nba/stats/status', { cache: 'no-store' });
        const t = await r.text();
        out.textContent = 'HTTP ' + r.status + '\\n\\n' + t;
      }catch(e){
        out.textContent = 'FETCH ERROR: ' + (e && e.message ? e.message : String(e));
      }
    }
  </script>
</body></html>`);
    });

    app.get("/api/pt/quick-links", (req, res) => {
      const db = exposeDB();
      const d = ymdET();
      res.json({
        ok: true,
        todayET: d,
        foundDB: !!db,
        links: {
          routes: "/api/pt/routes",
          status: "/api/nba/stats/status",
          propsDates: "/api/props/dates",
          props: `/api/odds/sgo/props-for-date?date=${d}&limit=50`,
          debug: "/pt/debug/stats",
        }
      });
    });

    log("[patch] FORCE RESET loaded ✅  Try GET /api/pt/quick-links");
  } catch (e) {
    try { console.log("[patch] FORCE RESET failed ❌", e?.stack || e?.message || e); } catch {}
  }
})();


/* ===========================
   PT HOTFIX v1 — quick-links date consistency + props-for-date fallback
   Paste at absolute bottom
   =========================== */
(() => {
  try {
    const safeLog = (...a) => { try { console.log(...a); } catch {} };

    // find express app
    const app =
      (typeof globalThis !== "undefined" && globalThis.app && typeof globalThis.app.get === "function" && globalThis.app) ||
      (typeof global !== "undefined" && global.app && typeof global.app.get === "function" && global.app) ||
      (typeof app !== "undefined" && typeof app.get === "function" && app) ||
      null;

    if (!app || !app._router || !Array.isArray(app._router.stack)) {
      safeLog("[hotfix] app missing; skip");
      return;
    }

    function removeGET(path) {
      try {
        const before = app._router.stack.length;
        app._router.stack = app._router.stack.filter(l => !(l?.route?.path === path && l?.route?.methods?.get));
        const removed = before - app._router.stack.length;
        if (removed) safeLog(`[hotfix] removed old GET ${path} ✅ (removed=${removed})`);
      } catch {}
    }

    function isoDateET(d = new Date()) {
      try {
        const s = new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
        const dt = new Date(s);
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, "0");
        const day = String(dt.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      } catch {
        const dt = new Date();
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      }
    }

    function getDB() {
      try { if (app?.locals?.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      try { if (typeof globalThis.readDB === "function") return globalThis.readDB(); } catch {}
      try { if (typeof readDB === "function") return readDB(); } catch {}
      return null;
    }

    function listPropDatesFromDB(db) {
      const dates = new Set();

      // sqlite table
      try {
        if (db && typeof db.prepare === "function") {
          const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get("sgoPropLines");
          if (has?.name) {
            const rows = db.prepare("SELECT DISTINCT dateISO AS d FROM sgoPropLines WHERE dateISO IS NOT NULL AND dateISO != ''").all();
            for (const r of rows || []) {
              const d = String(r?.d || "").slice(0, 10);
              if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
            }
            return Array.from(dates).sort();
          }
        }
      } catch {}

      // array/object
      try {
        const src = db?.sgoPropLines;
        if (Array.isArray(src)) {
          for (const r of src) {
            const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
          }
        } else if (src && typeof src === "object") {
          for (const k of Object.keys(src)) {
            const r = src[k];
            const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
          }
        }
      } catch {}

      return Array.from(dates).sort();
    }

    // Rule: earliest upcoming >= today; else latest; else today
    function pickActiveDate(db, maybeDate) {
      const d0 = String(maybeDate || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d0)) return d0;

      const today = isoDateET();
      const dates = listPropDatesFromDB(db);
      const upcoming = dates.filter(d => d >= today);
      if (upcoming.length) return upcoming[0];
      if (dates.length) return dates[dates.length - 1];
      return today;
    }

    // 1) FIX quick-links to use earliest-upcoming activeDate
    removeGET("/api/pt/quick-links");
    app.get("/api/pt/quick-links", (req, res) => {
      const db = getDB();
      const todayET = isoDateET();
      const activeDate = db ? pickActiveDate(db, null) : todayET;

      safeLog(`[hotfix] quick-links activeDate=${activeDate} todayET=${todayET}`);

      res.json({
        ok: true,
        todayET,
        activeDate,
        links: {
          routes: "http://127.0.0.1:3000/api/pt/routes",
          dbDebug: "http://127.0.0.1:3000/api/pt/db-debug",
          activeDate: "http://127.0.0.1:3000/api/props/active-date",
          propDates: "http://127.0.0.1:3000/api/props/dates",
          gamesMap: `http://127.0.0.1:3000/api/games-map?date=${activeDate}`,
          gamesMap2: `http://127.0.0.1:3000/api/games-map2?date=${activeDate}`,
          sgoPropsForDate: `http://127.0.0.1:3000/api/odds/sgo/props-for-date?date=${activeDate}&limit=50`,
          edgesTiered: `http://127.0.0.1:3000/api/nba/edges-today-tiered?date=${activeDate}&minEdge=0.5&games=20`,
          leaders: "http://127.0.0.1:3000/api/nba/stats/leaders",
          status: "http://127.0.0.1:3000/api/nba/stats/status",
          debugPage: "http://127.0.0.1:3000/pt/debug/stats",
        }
      });
    });

    // 2) Make props-for-date tolerant: invalid/missing date => activeDate
    removeGET("/api/odds/sgo/props-for-date");
    app.get("/api/odds/sgo/props-for-date", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 200)));
      const date = pickActiveDate(db, req.query.date);

      let src = db.sgoPropLines || [];
      let rows = [];
      if (Array.isArray(src)) {
        for (const r of src) {
          const di = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
          if (di === date) rows.push(r);
          if (rows.length >= limit) break;
        }
      } else if (src && typeof src === "object") {
        for (const k of Object.keys(src)) {
          const r = src[k];
          const di = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
          if (di === date) rows.push(r);
          if (rows.length >= limit) break;
        }
      }

      safeLog(`[hotfix] props-for-date date=${date} count=${rows.length}`);

      return res.json({ ok: true, date, count: rows.length, rows });
    });

    safeLog("[hotfix] PT HOTFIX v1 loaded ✅");
  } catch (e) {
    try { console.log("[hotfix] failed ❌", e?.stack || e?.message || e); } catch {}
  }
})();

/* ============================================================
   PT DB-WAIT INSTALLER (paste at absolute bottom)
   - Waits for app + db to exist, then installs your DB routes
   ============================================================ */
(() => {
  try {
    if (globalThis.__PT_DB_WAIT_INSTALLER__) return;
    globalThis.__PT_DB_WAIT_INSTALLER__ = true;

    const log = (...a) => { try { console.log(...a); } catch {} };

    function findApp() {
      try { if (globalThis.app?.get) return globalThis.app; } catch {}
      try { if (global.app?.get) return global.app; } catch {}

      // scan require cache for express-like app
      try {
        const cache = require.cache || {};
        for (const k of Object.keys(cache)) {
          const exp = cache[k]?.exports;
          if (!exp) continue;
          const cand =
            (exp.get && exp.use && exp.listen) ? exp :
            (exp.app?.get && exp.app?.use && exp.app?.listen) ? exp.app :
            (exp.default?.get && exp.default?.use && exp.default?.listen) ? exp.default :
            null;
          if (cand) return cand;
        }
      } catch {}
      return null;
    }

    function getDB(app) {
      try { if (app?.locals?.db) return app.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (global.db) return global.db; } catch {}
      try { if (typeof globalThis.readDB === "function") return globalThis.readDB(); } catch {}
      try { if (typeof readDB === "function") return readDB(); } catch {}
      return null;
    }

    function removeRoute(app, method, path) {
      try {
        const m = String(method || "get").toLowerCase();
        const stack = app?._router?.stack;
        if (!Array.isArray(stack)) return 0;
        const before = stack.length;
        app._router.stack = stack.filter(layer => {
          const r = layer?.route;
          if (!r) return true;
          if (r.path !== path) return true;
          if (!r.methods?.[m]) return true;
          return false;
        });
        return before - app._router.stack.length;
      } catch { return 0; }
    }

    function ymdET() {
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
        }).formatToParts(new Date());
        const y = parts.find(p => p.type === "year")?.value || "0000";
        const m = parts.find(p => p.type === "month")?.value || "00";
        const d = parts.find(p => p.type === "day")?.value || "00";
        return `${y}-${m}-${d}`;
      } catch {
        const dt = new Date();
        return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
      }
    }

    function listPropDatesFromDB(db) {
      const dates = new Set();
      try {
        const src = db?.sgoPropLines;
        if (Array.isArray(src)) {
          for (const r of src) {
            const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
          }
        } else if (src && typeof src === "object") {
          for (const k of Object.keys(src)) {
            const r = src[k];
            const d = String(r?.dateISO || r?.date || r?.slateDate || "").slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
          }
        }
      } catch {}
      return Array.from(dates).sort();
    }

    function pickActiveDate(db, reqDate) {
      if (reqDate && /^\d{4}-\d{2}-\d{2}$/.test(String(reqDate))) return String(reqDate);
      const today = ymdET();
      const dates = listPropDatesFromDB(db);
      const upcoming = dates.filter(d => d >= today);
      if (upcoming.length) return upcoming[0];
      if (dates.length) return dates[dates.length - 1];
      return today;
    }

    function install(app, db) {
      // expose db so other patches stop failing
      try { app.locals.db = db; } catch {}
      try { globalThis.db = db; } catch {}
      try { global.db = db; } catch {}

      // Replace the “active-date” routes cleanly
      removeRoute(app, "get", "/api/props/active-date");
      app.get("/api/props/active-date", (req, res) => {
        const db2 = getDB(app);
        if (!db2) return res.status(500).json({ ok:false, error:"DB not found" });
        const activeDate = pickActiveDate(db2, req.query.date);
        res.json({ ok:true, todayET: ymdET(), activeDate, where:"db-wait-installer" });
      });

      removeRoute(app, "get", "/api/props/active-date-auto");
      app.get("/api/props/active-date-auto", (req, res) => {
        const db2 = getDB(app);
        if (!db2) return res.status(500).json({ ok:false, error:"DB not found" });
        const activeDate = pickActiveDate(db2, null);
        res.json({ ok:true, todayET: ymdET(), activeDate, where:"db-wait-installer" });
      });

      log("[patch] DB-WAIT installer: DB found ✅ routes installed ✅");
      globalThis.__PT_DB_WAIT_READY__ = true;
    }

    // Poll until ready (max 20s)
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        const app = findApp();
        if (!app) {
          if (Date.now() - started > 20_000) { clearInterval(timer); log("[patch] DB-WAIT: app not found ❌"); }
          return;
        }
        const db = getDB(app);
        if (!db) {
          if (Date.now() - started > 20_000) { clearInterval(timer); log("[patch] DB-WAIT: DB still missing after 20s ❌"); }
          return;
        }
        clearInterval(timer);
        install(app, db);
      } catch {}
    }, 250);

  } catch (e) {
    try { console.log("[patch] DB-WAIT installer failed ❌", e?.message || e); } catch {}
  }
})();

/* =========================
   PT FINAL SERVER START (Render + Local Safe)
   Paste at VERY BOTTOM of protracker.js
   ========================= */

(() => {
  try {
    if (!app || typeof app.listen !== "function") {
      console.log("[pt] listen skipped (app missing)");
      return;
    }

    // Prevent double listen if patches re-run
    if (globalThis.__PT_SERVER_STARTED__) {
      console.log("[pt] server already started, skipping");
      return;
    }
    globalThis.__PT_SERVER_STARTED__ = true;

    const PORT = process.env.PORT || 3000;
    const HOST = "0.0.0.0";

    app.listen(PORT, HOST, () => {
      console.log(`[pt] ProTracker running on port ${PORT}`);
    });

  } catch (e) {
    console.log("[pt] server start FAILED ❌", e?.stack || e?.message || e);
  }
})();

// ===== Render/Cloud hosting listen fix =====
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

// If you have `server` (http.createServer(app)), use server.listen.
// Otherwise use app.listen. Do ONE, not both.

if (typeof server !== "undefined" && server && typeof server.listen === "function") {
  server.listen(PORT, HOST, () => {
    console.log(`ProTracker running at http://${HOST}:${PORT}`);
  });
} else {
  app.listen(PORT, HOST, () => {
    console.log(`ProTracker running at http://${HOST}:${PORT}`);
  });
}

// Health endpoint for Render health checks
app.get("/health", (req, res) => res.status(200).send("ok"));


