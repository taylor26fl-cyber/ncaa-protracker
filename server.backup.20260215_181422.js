const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = 3000;
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

function fmtLine(n) {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + Number(n).toFixed(1);
}
function fmtOdds(n) {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
function impliedProb(odds) {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}
function americanFromProb(p) {
  const pp = Math.min(0.999, Math.max(0.001, p));
  return pp >= 0.5 ? Math.round(-(pp / (1 - pp)) * 100) : Math.round(((1 - pp) / pp) * 100);
}
function profitFromOdds(odds, stake) {
  if (!odds || odds === 0) return 0;
  if (odds > 0) return (odds / 100) * stake;
  return (100 / Math.abs(odds)) * stake;
}
function edgeSpread(proj, market) {
  if (proj == null || market == null) return null;
  return proj - market;
}
function edgeTotal(proj, market) {
  if (proj == null || market == null) return null;
  return proj - market;
}
function edgeML(projProbHome, marketMlHome) {
  if (projProbHome == null || marketMlHome == null) return null;
  return projProbHome - impliedProb(marketMlHome);
}

function latestLines(db) {
  const byGame = new Map();
  for (const l of db.lines) {
    if (l.sportsbook !== "HARDROCK") continue;
    const arr = byGame.get(l.gameId) || [];
    arr.push(l);
    byGame.set(l.gameId, arr);
  }
  const latest = new Map();
  const prev = new Map();
  for (const [gid, arr] of byGame.entries()) {
    arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (arr[0]) latest.set(gid, arr[0]);
    if (arr[1]) prev.set(gid, arr[1]);
  }
  return { latest, prev };
}

function shell(title, innerHtml) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root{--b:#e5e7eb;--m:#6b7280;--chip:#f3f4f6;}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;background:#fff;}
  .nav{border-bottom:1px solid var(--b);}
  .navin{max-width:1100px;margin:0 auto;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;}
  .links{display:flex;gap:14px;font-size:13px;}
  a{text-decoration:none;color:inherit;}
  .wrap{max-width:1100px;margin:0 auto;padding:16px;}
  .card{border:1px solid var(--b);border-radius:14px;padding:14px;background:#fff;}
  .grid{display:grid;gap:12px;}
  .grid2{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr));}
  .grid4{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr));}
  @media(max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:600px){.grid2,.grid4{grid-template-columns:1fr}}
  .h1{font-size:22px;font-weight:700;margin:0;}
  .p{margin:6px 0 0;color:var(--m);font-size:13px;}
  .small{font-size:12px;color:var(--m);}
  .chip{display:inline-block;padding:4px 8px;background:var(--chip);border-radius:999px;font-size:12px;}
  .btn{border:1px solid var(--b);background:#fff;border-radius:10px;padding:8px 10px;font-size:13px;}
  .btnP{background:#111827;color:#fff;border-color:#111827;}
  .inp,.sel{width:100%;border:1px solid var(--b);border-radius:10px;padding:8px 10px;font-size:13px;}
  table{width:100%;border-collapse:collapse;}
  th,td{border-top:1px solid var(--b);padding:10px 12px;font-size:13px;text-align:left;vertical-align:top;}
  thead th{background:#f9fafb;border-top:none;font-size:12px;color:var(--m);}
</style>
</head>
<body>
  <div class="nav"><div class="navin">
    <a href="/"><b>NCAA ProTracker</b></a>
    <div class="links">
      <a href="/games">Games</a>
      <a href="/bets">Bets</a>
    </div>
  </div></div>
  <div class="wrap">${innerHtml}</div>
</body>
</html>`;
}

/* ---------- API ---------- */

app.get("/api/summary", (req, res) => {
  const db = ppReadDB();
  const totalStaked = db.bets.reduce((s, b) => s + Number(b.stake || 0), 0);
  const totalProfit = db.bets.reduce((s, b) => s + Number(b.payout || 0), 0);
  const settled = db.bets.filter(b => b.result && b.result !== "PENDING");
  const wins = settled.filter(b => b.result === "WIN").length;
  const losses = settled.filter(b => b.result === "LOSS").length;
  const roi = totalStaked > 0 ? totalProfit / totalStaked : 0;
  res.json({ totalStaked, totalProfit, wins, losses, roi });
});

app.get("/api/games", (req, res) => {
  const db = ppReadDB();
  const teamById = new Map(db.teams.map(t => [t.id, t]));
  const { latest, prev } = latestLines(db);

  const rows = db.games
    .slice()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .map(g => {
      const ll = latest.get(g.id) || null;
      const pl = prev.get(g.id) || null;
      const eS = edgeSpread(g.projSpreadHome, ll?.spreadHome ?? null);
      const eT = edgeTotal(g.projTotal, ll?.total ?? null);
      const eM = edgeML(g.projWinProbHome, ll?.mlHome ?? null);

      return {
        ...g,
        homeTeam: teamById.get(g.homeTeamId),
        awayTeam: teamById.get(g.awayTeamId),
        latestLine: ll,
        prevLine: pl,
        edges: { spread: eS, total: eT, ml: eM },
        fairMlHome: g.projWinProbHome == null ? null : americanFromProb(g.projWinProbHome)
      };
    });

  res.json(rows);
});

app.patch("/api/games/:id", (req, res) => {
  const db = ppReadDB();
  const idx = db.games.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");

  const p = req.body || {};
  const cur = db.games[idx];

  const next = {
    ...cur,
    projSpreadHome: p.projSpreadHome === undefined ? cur.projSpreadHome : p.projSpreadHome,
    projTotal: p.projTotal === undefined ? cur.projTotal : p.projTotal,
    projWinProbHome: p.projWinProbHome === undefined ? cur.projWinProbHome : p.projWinProbHome
  };

  db.games[idx] = next;
  ppWriteDB(db);
  res.json(next);
});

app.get("/api/bets", (req, res) => {
  const db = ppReadDB();
  res.json(db.bets.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post("/api/bets", (req, res) => {
  const db = ppReadDB();
  const b = req.body || {};
  if (!b.gameId) return res.status(400).send("gameId required");

  const bet = {
    id: id("b"),
    createdAt: new Date().toISOString(),
    gameId: b.gameId,
    betType: b.betType || "SPREAD",
    side: b.side || "HOME",
    line: b.line ?? null,
    price: b.price ?? null,
    stake: Number(b.stake ?? 1),
    result: "PENDING",
    payout: null
  };

  db.bets.push(bet);
  ppWriteDB(db);
  res.status(201).json(bet);
});

app.patch("/api/bets/:id", (req, res) => {
  const db = ppReadDB();
  const idx = db.bets.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");

  const p = req.body || {};
  const cur = db.bets[idx];

  let payout = p.payout !== undefined ? p.payout : cur.payout;

  if (p.result && p.payout === undefined) {
    const stake = Number(cur.stake || 1);
    const odds = Number(cur.price || -110);
    if (p.result === "WIN") payout = profitFromOdds(odds, stake);
    else if (p.result === "LOSS") payout = -stake;
    else if (p.result === "PUSH") payout = 0;
    else payout = null;
  }

  db.bets[idx] = { ...cur, ...p, payout };
  ppWriteDB(db);
  res.json(db.bets[idx]);
});

app.post("/api/sync/hardrock", (req, res) => {
  const db = ppReadDB();
  const now = new Date().toISOString();
  const season = Number((req.body && req.body.season) || 2026);

  function jitter() {
    const r = Math.random();
    return r < 0.33 ? -0.5 : r < 0.66 ? 0 : 0.5;
  }

  const seasonGames = db.games.filter(g => g.season === season);

  for (const g of seasonGames) {
    const last = db.lines
      .filter(l => l.gameId === g.id && l.sportsbook === "HARDROCK")
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    const j = jitter();
    db.lines.push({
      id: id("l"),
      gameId: g.id,
      sportsbook: "HARDROCK",
      createdAt: now,
      spreadHome: (last?.spreadHome ?? -3.5) + j,
      total: (last?.total ?? 149.5) + j,
      mlHome: last?.mlHome ?? -160,
      mlAway: last?.mlAway ?? 135
    });
  }

  ppWriteDB(db);
  res.json({ ok: true, season, snapshotsCreated: seasonGames.length });
});

const { syncHardRockToday } = require("./sync_oddsapi");

app.post("/api/sync/hardrock-today", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const out = await syncHardRockToday({ season });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

const { syncApiSportsToday } = require("./sync_apisports_today");




const { syncEspnToday } = require("./sync_espn_today");

app.post("/api/sync/espn-today", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const out = await syncEspnToday({ season });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

const { syncEspnDate } = require("./sync_espn_date");

app.post("/api/sync/espn-date", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const date = String((req.body && req.body.date) || "");
    const out = await syncEspnDate({ season, date });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

const { syncEspnNbaDate } = require("./sync_espn_nba_date");
const { fetchEspnNbaSummary, extractPlayerLines } = require("./espn_nba_players");

app.post("/api/sync/espn-nba-date", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const date = String((req.body && req.body.date) || "");
    const out = await syncEspnNbaDate({ season, date });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && (e.message || e)) });
  }
});

app.get("/api/nba/game/:eventId/players", async (req, res) => {
  try {
    const summary = await fetchEspnNbaSummary(req.params.eventId);
    const lines = extractPlayerLines(summary);
    res.json({ ok: true, eventId: req.params.eventId, players: lines });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e && (e.message || e)) });
  }
});



const { readDB: ppReadDB, writeDB: ppWriteDB, ensure: ppEnsure, id: ppId, gradeProp } = require("./player_props");

app.get("/api/player-props", (req,res)=>{
  const db = ppReadDB();
  ppEnsure(db);
  res.json(db.playerProps);
});

app.post("/api/player-props", (req,res)=>{
  const db = ppReadDB();
  ppEnsure(db);

  const prop = {
    id: ppId("pp"),
    player: String(req.body.player || ""),
    stat: String(req.body.stat || ""),
    line: Number(req.body.line),
    projection: Number(req.body.projection),
    type: String(req.body.type || "OVER"),
    gameEventId: String(req.body.gameEventId || ""),
    result: "PENDING",
    actual: null
  };

  db.playerProps.push(prop);
  ppWriteDB(db);
  res.json(prop);
});


const { gradePendingProps } = require("./auto_grade_props");

// --- Bulk add props (paste an array of props)
app.post("/api/player-props/bulk", (req, res) => {
  try {
    const db = ppReadDB();
    ppEnsure(db);

    const arr = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.props) ? req.body.props : null);
    if (!arr) return res.status(400).json({ ok:false, error:"Send JSON array, or {props:[...]}" });

    const created = [];
    for (const r of arr) {
      const prop = {
        id: ppId("pp"),
        player: String(r.player || ""),
        stat: String(r.stat || ""),
        line: Number(r.line),
        projection: Number(r.projection),
        type: String(r.type || "OVER"),
        gameEventId: String(r.gameEventId || ""),
        result: "PENDING",
        actual: null
      };
      created.push(prop);
      db.playerProps.push(prop);
    }
    ppWriteDB(db);
    res.json({ ok:true, created: created.length, props: created });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e && (e.message || e)) });
  }
});

// --- Get auto-loaded player list for an NBA or NCAAB ESPN eventId
app.get("/api/players/:eventId", async (req, res) => {
  try {
    const eventId = String(req.params.eventId);

    // Try NBA first
    let out = null;
    try {
      const r = await fetch(`http://127.0.0.1:3000/api/nba/game/${eventId}/players`);
      if (r.ok) out = await r.json();
    } catch(e){}

    // If NBA failed, try NCAAB summary directly
    if (!out || !out.ok) {
      const url = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${encodeURIComponent(eventId)}`;
      const resp = await fetch(url);
      if(!resp.ok) throw new Error(`ESPN NCAAB summary error ${resp.status}`);
      const summary = await resp.json();

      const players = [];
      const blocks = summary?.boxscore?.players || [];
      for(const teamBlock of blocks){
        const teamName = teamBlock?.team?.displayName || teamBlock?.team?.name || "Team";
        const statsBlocks = teamBlock?.statistics || [];
        for(const cat of statsBlocks){
          const athletes = cat?.athletes || [];
          for(const a of athletes){
            const name = a?.athlete?.displayName || a?.athlete?.fullName || "Player";
            players.push({ team: teamName, player: name });
          }
        }
      }
      // unique
      const seen = new Set();
      const uniq = [];
      for(const x of players){
        const k = x.team + "||" + x.player;
        if(!seen.has(k)){ seen.add(k); uniq.push(x); }
      }
      return res.json({ ok:true, eventId, league:"NCAAB", players: uniq });
    }

    // If NBA ok: return slim list
    const slim = (out.players || []).map(p => ({ team: p.team, player: p.player }));
    const seen = new Set(); const uniq = [];
    for(const x of slim){
      const k = x.team + "||" + x.player;
      if(!seen.has(k)){ seen.add(k); uniq.push(x); }
    }
    res.json({ ok:true, eventId, league:"NBA", players: uniq });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e && (e.message || e)) });
  }
});

// --- Manual grade trigger (also runs automatically every minute)
app.post("/api/player-props/grade", async (req, res) => {
  try {
    const db = ppReadDB();
    ppEnsure(db);

    // map eventId -> league using games table (best effort)
    const leagueOfEventId = (eventId) => {
      const g = (db.games || []).find(x => String(x.extId) === String(eventId));
      return g?.league || "NCAAB";
    };

    const out = await gradePendingProps({ db, writeDB: ppWriteDB, leagueOfEventId });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e && (e.message || e)) });
  }
});





app.get("/props", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ProTracker — Props</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:16px;max-width:980px}
    nav a{margin-right:12px}
    textarea{width:100%;min-height:140px}
    table{border-collapse:collapse;width:100%;margin-top:12px}
    th,td{border:1px solid #ddd;padding:8px;font-size:14px}
    th{background:#f6f6f6;text-align:left}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
    button{padding:10px 12px}
    code{background:#f6f6f6;padding:2px 4px;border-radius:4px}
  </style>
</head>
<body>
  <nav>
    <a href="/games">Games</a>
    <a href="/props"><b>Props</b></a>
    <a href="/players">Players</a>
  </nav>

  <h2>Player Props</h2>

  <div class="row">
    <button id="refresh">Refresh</button>
    <button id="grade">Grade now</button>
  </div>

  <h3>Bulk Add (paste JSON array)</h3>
  <p>Format: <code>[{"player":"Name","stat":"PTS","line":18.5,"projection":21.2,"type":"OVER","gameEventId":"401..."}]</code></p>
  <textarea id="bulk"></textarea>
  <div class="row">
    <button id="addBulk">Add Bulk Props</button>
  </div>

  <h3>Saved Props</h3>
  <div id="out">Loading…</div>

<script>
async function jget(url){ const r=await fetch(url); return r.json(); }
async function jpost(url, body){
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return r.json();
}
function esc(s){ return String(s??"").replace(/[&<>"']/g,function(m){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]);}); }

function render(rows){
  var out = document.getElementById("out");
  if(!rows || !rows.length){ out.innerHTML = "<p>No props yet.</p>"; return; }

  var html = "<table><thead><tr>"
    + "<th>Player</th><th>Stat</th><th>Type</th><th>Line</th><th>Proj</th><th>Actual</th><th>Result</th><th>Event</th>"
    + "</tr></thead><tbody>";

  for(var i=0;i<rows.length;i++){
    var p = rows[i];
    html += "<tr>"
      + "<td>"+esc(p.player)+"</td>"
      + "<td>"+esc(p.stat)+"</td>"
      + "<td>"+esc(p.type)+"</td>"
      + "<td>"+esc(p.line)+"</td>"
      + "<td>"+esc(p.projection)+"</td>"
      + "<td>"+esc(p.actual)+"</td>"
      + "<td>"+esc(p.result)+"</td>"
      + "<td>"+esc(p.gameEventId)+"</td>"
      + "</tr>";
  }
  html += "</tbody></table>";
  out.innerHTML = html;
}

async function refresh(){
  var rows = await jget("/api/player-props");
  render(rows);
}

document.getElementById("refresh").onclick = refresh;
document.getElementById("grade").onclick = async function(){ await jpost("/api/player-props/grade", {}); await refresh(); };

document.getElementById("addBulk").onclick = async function(){
  var txt = document.getElementById("bulk").value;
  var arr;
  try { arr = JSON.parse(txt); } catch(e){ alert("Bad JSON"); return; }
  var resp = await jpost("/api/player-props/bulk", arr);
  if(!resp.ok){ alert(resp.error || "bulk add failed"); return; }
  document.getElementById("bulk").value = "";
  await refresh();
};

refresh();
</script>
</body>
</html>`);
});

app.get("/players", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ProTracker — Players</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:16px;max-width:980px}
    nav a{margin-right:12px}
    input{padding:10px;width:260px}
    button{padding:10px 12px}
    table{border-collapse:collapse;width:100%;margin-top:12px}
    th,td{border:1px solid #ddd;padding:8px;font-size:14px}
    th{background:#f6f6f6;text-align:left}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
    .muted{color:#666}
  </style>
</head>
<body>
  <nav>
    <a href="/games">Games</a>
    <a href="/props">Props</a>
    <a href="/players"><b>Players</b></a>
  </nav>

  <h2>Players</h2>
  <p class="muted">Paste an ESPN eventId (example: 401838140). This loads the roster.</p>

  <div class="row">
    <input id="eid" placeholder="eventId (401...)" />
    <button id="load">Load</button>
  </div>

  <div id="out">Waiting…</div>

<script>
async function jget(url){ const r=await fetch(url); return r.json(); }
function esc(s){ return String(s??"").replace(/[&<>"']/g,function(m){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]);}); }

function renderPlayers(list){
  if(!list || !list.length) return "<p>No players returned.</p>";
  var html = "<table><thead><tr><th>Team</th><th>Player</th></tr></thead><tbody>";
  for(var i=0;i<list.length;i++){
    html += "<tr><td>"+esc(list[i].team)+"</td><td>"+esc(list[i].player)+"</td></tr>";
  }
  html += "</tbody></table>";
  return html;
}

// Auto-load if opened with ?eventId=...
(function(){
  try{
    var q = new URLSearchParams(window.location.search);
    var eid = q.get("eventId");
    if(eid){
      var sel = document.getElementById("gameSel");
      if(sel){
        for(var i=0;i<sel.options.length;i++){
          if(sel.options[i].value === eid){ sel.selectedIndex = i; break; }
        }
      }
      setTimeout(function(){
        var btn = document.getElementById("load");
        if(btn) btn.click();
      }, 200);
    }
  }catch(e){}
})();

document.getElementById("load").onclick = async function(){
  var id = document.getElementById("gameSel").value.trim();
  document.getElementById("picked").innerHTML = "Loading eventId: " + esc(id);
  if(!id) return;
  var r = await jget("/api/players/" + encodeURIComponent(id));
  var out = document.getElementById("out");
  if(!r.ok){ out.innerHTML = "<pre>"+esc(r.error||"error")+"</pre>"; return; }
  out.innerHTML = "<p><b>League:</b> "+esc(r.league)+" | <b>Event:</b> "+esc(r.eventId)+"</p>" + renderPlayers(r.players);
};
</script>

</body>
</html>`);
});

const { runDailySync, yyyymmddLocal } = require("./daily_sync");

app.post("/api/sync/daily", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const daysAhead = Number((req.body && req.body.daysAhead) || 1);
    const out = await runDailySync({ season, daysAhead });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e && (e.message || e)) });
  }
});


app.get("/api/game-picker", (req, res) => {
  const db = readDB();
  const teamById = new Map((db.teams||[]).map(t=>[t.id,t]));
  const games = (db.games||[])
    .slice()
    .sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
    .map(g=>{
      const home = teamById.get(g.homeTeamId)?.name || g.homeTeamId;
      const away = teamById.get(g.awayTeamId)?.name || g.awayTeamId;
      const t = new Date(g.startTime);
      const hh = String(t.getHours()).padStart(2,"0");
      const mm = String(t.getMinutes()).padStart(2,"0");
      const label = `${g.league || "NCAAB"} ${hh}:${mm}  ${away} @ ${home}`;
      return { id: g.id, league: g.league || "NCAAB", startTime: g.startTime, label, eventId: String(g.extId||"") };
    });
  res.json({ ok:true, games });
});


app.post("/api/sync/espn-nba-range", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const start = String((req.body && req.body.start) || "20260201"); // YYYYMMDD
    const end   = String((req.body && req.body.end)   || "20260228"); // YYYYMMDD

    if(!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) {
      return res.status(400).json({ ok:false, error:"start/end must be YYYYMMDD" });
    }

    const toDate = (yyyymmdd) => new Date(Number(yyyymmdd.slice(0,4)), Number(yyyymmdd.slice(4,6))-1, Number(yyyymmdd.slice(6,8)));
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;

    let d0 = toDate(start);
    let d1 = toDate(end);
    if(d0 > d1) [d0, d1] = [d1, d0];

    let days = 0;
    let importedTotal = 0;
    const perDay = [];

    for(let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)){
      const date = fmt(d);
      const out = await syncEspnNbaDate({ season, date });
      perDay.push(out);
      importedTotal += Number(out.importedGames || 0);
      days++;
      // tiny delay so ESPN doesn't rate-limit
      await new Promise(r => setTimeout(r, 150));
      // safety guard on phone
      if(days > 370) break;
    }

    res.json({ ok:true, season, start:fmt(d0), end:fmt(d1), days, importedTotal, perDay });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e && (e.message || e)) });
  }
});


app.post("/api/sync/espn-ncaab-range", async (req, res) => {
  try {
    const season = Number((req.body && req.body.season) || 2026);
    const start = String((req.body && req.body.start) || "20260215"); // YYYYMMDD
    const end   = String((req.body && req.body.end)   || "20260515"); // YYYYMMDD

    if(!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) {
      return res.status(400).json({ ok:false, error:"start/end must be YYYYMMDD" });
    }

    const toDate = (yyyymmdd) => new Date(Number(yyyymmdd.slice(0,4)), Number(yyyymmdd.slice(4,6))-1, Number(yyyymmdd.slice(6,8)));
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;

    let d0 = toDate(start);
    let d1 = toDate(end);
    if(d0 > d1) [d0, d1] = [d1, d0];

    let days = 0;
    let importedTotal = 0;
    const perDay = [];

    for(let d = new Date(d0); d <= d1; d.setDate(d.getDate()+1)){
      const date = fmt(d);
      const out = await syncEspnDate({ season, date });
      perDay.push(out);
      importedTotal += Number(out.importedGames || 0);
      days++;
      await new Promise(r => setTimeout(r, 150));
      if(days > 370) break;
    }

    res.json({ ok:true, league:"NCAAB", season, start:fmt(d0), end:fmt(d1), days, importedTotal });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e && (e.message || e)) });
  }
});

/* ---------- Pages ---------- */

app.get("/", (req, res) => {
  const body = `
    <div class="grid" style="gap:14px">
      <div>
        <h1 class="h1">Dashboard</h1>
        <div class="p">Spread + ML projections, edges vs Hard Rock, and bet ROI.</div>
      </div>
      <div class="grid4" id="stats"></div>
      <div class="card">
        <b>Go to Games</b>
        <div class="small" style="margin-top:8px">Edit projections, see edges, and sync line snapshots.</div>
      </div>
    </div>

<script>
(async function(){
  const s = await (await fetch('/api/summary')).json();
  const el = document.getElementById('stats');
  const money = (x)=>'$'+Number(x||0).toFixed(2);
  el.innerHTML =
    '<div class="card"><div class="small">Total Profit</div><div style="font-size:22px;font-weight:700;margin-top:6px">'+money(s.totalProfit)+'</div></div>'+
    '<div class="card"><div class="small">Total Staked</div><div style="font-size:22px;font-weight:700;margin-top:6px">'+money(s.totalStaked)+'</div></div>'+
    '<div class="card"><div class="small">ROI</div><div style="font-size:22px;font-weight:700;margin-top:6px">'+(s.roi*100).toFixed(1)+'%</div></div>'+
    '<div class="card"><div class="small">Record</div><div style="font-size:22px;font-weight:700;margin-top:6px">'+s.wins+'-'+s.losses+'</div></div>';
})();
</script>
  `;
  res.send(shell("Dashboard", body));
});

app.get("/games", (req, res) => {
  // ProTracker nav
  const NAV = `<nav style="margin:16px 0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <a href="/games" style="margin-right:12px">Games</a><a href="/quick" style="margin-right:12px">Quick</a>
    <a href="/props" style="margin-right:12px">Props</a>
    <a href="/players" style="margin-right:12px">Players</a>
  </nav>`;
  res.setHeader("Cache-Control","no-store");

  const body = `
    <div class="grid" style="gap:14px">
      <div>
        <h1 class="h1">Games</h1>
        <div class="p">Hard Rock lines + your projections + edges.</div>
      </div>

      <div class="card">
        <button class="btn btnP" onclick="sync()">Sync Hard Rock</button>
        <button class="btn" style="margin-left:8px" onclick="load()">Refresh</button>
        <div class="small" style="margin-top:8px">Negative spread edge = HOME lean. Positive ML edge = value on HOME ML.</div>
      </div>

      <div id="list" class="grid"></div>
    </div>

<script>
function fmtLine(n){ if(n==null) return '—'; var s=n>0?'+':''; return s+Number(n).toFixed(1); }
function fmtOdds(n){ if(n==null) return '—'; return n>0?('+'+n):(''+n); }

async function load(){
  const games = await (await fetch('/api/games')).json();
  const el = document.getElementById('list');
  el.innerHTML = games.map(g=>{
    const ll=g.latestLine||{};
    const e=g.edges||{};
    const fair = (g.fairMlHome==null) ? '—' : (g.fairMlHome>0?('+'+g.fairMlHome):(''+g.fairMlHome));
    return (
      '<div class="card">'+
        '<div class="small">'+new Date(g.startTime).toLocaleString()+' • <span class="chip">'+g.status+'</span></div>'+
        '<div style="font-size:18px;font-weight:700;margin-top:6px">'+g.awayTeam.shortName+' @ '+g.homeTeam.shortName+'</div>'+

        '<div class="grid4" style="margin-top:12px">'+
          '<div class="card"><div class="small">HR Spread (Home)</div><div style="font-weight:700">'+fmtLine(ll.spreadHome)+'</div></div>'+
          '<div class="card"><div class="small">HR Total</div><div style="font-weight:700">'+fmtLine(ll.total)+'</div></div>'+
          '<div class="card"><div class="small">HR ML (H/A)</div><div style="font-weight:700">'+fmtOdds(ll.mlHome)+' / '+fmtOdds(ll.mlAway)+'</div></div>'+
          '<div class="card"><div class="small">Edges (S/T/ML)</div><div style="font-weight:700">'+
            (e.spread==null?'—':(e.spread.toFixed(1)+' pts'))+' / '+
            (e.total==null?'—':(e.total.toFixed(1)+' pts'))+' / '+
            (e.ml==null?'—':((e.ml*100).toFixed(1)+'%'))+
          '</div></div>'+
        '</div>'+

        '<div class="grid2" style="margin-top:12px">'+
          '<div class="card">'+
            '<div style="font-weight:700">Your Projections</div>'+
            '<div class="small" style="margin-top:8px">Proj Spread (Home)</div>'+
            '<input class="inp" value="'+(g.projSpreadHome??'')+'" onblur="saveProj(\\''+g.id+'\\', {projSpreadHome: this.value===\\'\\'?null:Number(this.value)})" placeholder="-4.0"/>'+
            '<div class="small" style="margin-top:8px">Proj Total</div>'+
            '<input class="inp" value="'+(g.projTotal??'')+'" onblur="saveProj(\\''+g.id+'\\', {projTotal: this.value===\\'\\'?null:Number(this.value)})" placeholder="148.5"/>'+
            '<div class="small" style="margin-top:8px">Proj Home Win% (0–1)</div>'+
            '<input class="inp" value="'+(g.projWinProbHome??'')+'" onblur="saveProj(\\''+g.id+'\\', {projWinProbHome: this.value===\\'\\'?null:Number(this.value)})" placeholder="0.62"/>'+
            '<div class="small" style="margin-top:8px">Fair ML (Home): <b>'+fair+'</b></div>'+
          '</div>'+
          '<div class="card"><div style="font-weight:700">Meaning</div><div class="small" style="margin-top:8px">'+
            'Spread edge negative = HOME lean<br> Total edge negative = UNDER lean<br> ML edge positive = value HOME ML'+
          '</div></div>'+
        '</div>'+
      '</div>'
    );
  }).join('');
}

async function saveProj(id, patch){
  await fetch('/api/games/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
  load();
}
async function sync(){
  await fetch('/api/sync/hardrock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({season:2026})});
  load();
}
load();
</script>
  `;
  res.send(NAV + shell("Games", body));
});

app.get("/bets", (req, res) => {
  const body = `
    <div class="grid" style="gap:14px">
      <div>
        <h1 class="h1">Bets</h1>
        <div class="p">Log picks, mark results, auto-calc profit from odds.</div>
      </div>

      <div class="card">
        <div class="grid2">
          <div><div class="small">Game</div><select id="game" class="sel"></select></div>
          <div><div class="small">Type</div>
            <select id="type" class="sel" onchange="typeChanged()">
              <option>SPREAD</option><option>TOTAL</option><option>MONEYLINE</option>
            </select>
          </div>
          <div><div class="small">Side</div><select id="side" class="sel"></select></div>
          <div><div class="small">Line</div><input id="line" class="inp" value="-3.5"></div>
          <div><div class="small">Odds</div><input id="odds" class="inp" value="-110"></div>
          <div><div class="small">Stake</div><input id="stake" class="inp" value="1"></div>
        </div>
        <button class="btn btnP" style="margin-top:10px" onclick="addBet()">Add Bet</button>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>Bet</th><th>Odds</th><th>Stake</th><th>Result</th><th>P/L</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>

<script>
function fmtLine(n){ if(n==null) return '—'; var s=n>0?'+':''; return s+Number(n).toFixed(1); }
function fmtOdds(n){ if(n==null) return '—'; return n>0?('+'+n):(''+n); }
function money(x){ return '$'+Number(x||0).toFixed(2); }

let gamesCache = [];

async function loadGames(){
  gamesCache = await (await fetch('/api/games')).json();
  const sel = document.getElementById('game');
  sel.innerHTML = gamesCache.map(g=>'<option value="'+g.id+'">'+g.awayTeam.shortName+' @ '+g.homeTeam.shortName+' — '+new Date(g.startTime).toLocaleString()+'</option>').join('');
  typeChanged();
}

function typeChanged(){
  const t=document.getElementById('type').value;
  const side=document.getElementById('side');
  const line=document.getElementById('line');
  if(t==='TOTAL'){
    side.innerHTML='<option>OVER</option><option>UNDER</option>';
    line.disabled=false; line.value='141.5';
  }else if(t==='MONEYLINE'){
    side.innerHTML='<option>HOME</option><option>AWAY</option>';
    line.disabled=true; line.value='';
  }else{
    side.innerHTML='<option>HOME</option><option>AWAY</option>';
    line.disabled=false; line.value='-3.5';
  }
}

async function addBet(){
  const payload={
    gameId: document.getElementById('game').value,
    betType: document.getElementById('type').value,
    side: document.getElementById('side').value,
    line: document.getElementById('line').disabled ? null : Number(document.getElementById('line').value),
    price: Number(document.getElementById('odds').value),
    stake: Number(document.getElementById('stake').value)
  };
  await fetch('/api/bets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  loadBets();
}

async function loadBets(){
  const bets = await (await fetch('/api/bets')).json();
  const gm = new Map(gamesCache.map(g=>[g.id,g]));
  const tbody=document.getElementById('rows');
  tbody.innerHTML = bets.map(b=>{
    const g=gm.get(b.gameId);
    const label = g ? (g.awayTeam.shortName+' @ '+g.homeTeam.shortName+' • '+b.betType+' '+b.side+' '+(b.line==null?'':fmtLine(b.line))) : b.gameId;
    return '<tr>'+
      '<td><b>'+label+'</b><div class="small">'+new Date(b.createdAt).toLocaleString()+'</div></td>'+
      '<td>'+fmtOdds(b.price)+'</td>'+
      '<td>'+b.stake+'</td>'+
      '<td><select class="sel" onchange="setResult(\\''+b.id+'\\', this.value)">'+
        ['PENDING','WIN','LOSS','PUSH'].map(x=>'<option '+(b.result===x?'selected':'')+'>'+x+'</option>').join('')+
      '</select></td>'+
      '<td><b>'+money(b.payout)+'</b></td>'+
    '</tr>';
  }).join('');
}

async function setResult(id, result){
  await fetch('/api/bets/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({result})});
  loadBets();
}

loadGames().then(loadBets);
</script>
  `;
  res.send(shell("Bets", body));
});

// AUTO_GRADE_LOOP: grade pending props every 60 seconds
setInterval(async () => {
  try {
    const db = ppReadDB();
    ppEnsure(db);
    const leagueOfEventId = (eventId) => {
      const g = (db.games || []).find(x => String(x.extId) === String(eventId));
      return g?.league || "NCAAB";
    };
    await gradePendingProps({ db, writeDB: ppWriteDB, leagueOfEventId });
  } catch(e) {}
}, 60_000);

// AUTO_DAILY_SYNC_LOOP: sync once on boot + whenever the local date changes
let __lastSyncDate = null;
async function __maybeSyncDaily(){
  try{
    const today = yyyymmddLocal(new Date());
    if(__lastSyncDate !== today){
      __lastSyncDate = today;
      await runDailySync({ season: 2026, daysAhead: 1 }); // today + tomorrow
    }
  }catch(e){}
}
__maybeSyncDaily();
setInterval(__maybeSyncDaily, 60_000); // check every minute

app.listen(PORT, "0.0.0.0", () => {
  console.log("ProTracker running at http://127.0.0.1:" + PORT);
});
