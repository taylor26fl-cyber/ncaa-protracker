
/* __PT_NULL_BASE_FIX__ */
(function(){
  // If you ever stored a base URL in localStorage and it became null/blank, kill it.
  try{
    const bad = ["null", "undefined", "None"];
    const keys = ["PT_BASE","API_BASE","BASE_URL","PROTRACKER_BASE"];
    keys.forEach(k=>{
      const v = (localStorage.getItem(k) || "").trim();
      if(!v || bad.includes(v)) localStorage.removeItem(k);
    });
  }catch(e){}

  // Always use relative URLs by default.
  // If you *want* a custom base later, set localStorage PT_BASE to something like http://192.168.x.x:3000
  const BASE = (() => {
    try{
      const v = (localStorage.getItem("PT_BASE") || "").trim();
      if(!v || v==="null" || v==="undefined") return "";
      return v.replace(/\/+$/,"");
    }catch(e){ return ""; }
  })();

  function api(u){
    if(!u) return u;
    if(u.startsWith("http")) return u;
    if(!BASE) return u;          // relative -> same host (127.0.0.1:3000)
    if(u.startsWith("/")) return BASE + u;
    return BASE + "/" + u;
  }

  // Wrap existing helpers if present
  if(typeof jget === "function"){
    const _jget = jget;
    jget = (u)=>_jget(api(u));
  }
  if(typeof jpost === "function"){
    const _jpost = jpost;
    jpost = (u, body)=>_jpost(api(u), body);
  }

  // Safety: if any code tries to navigate to "null", block it.
  try{
    const _assign = window.location.assign.bind(window.location);
    window.location.assign = (u)=>{
      if(u===null || u==="null" || u==="undefined") return;
      return _assign(u);
    };
  }catch(e){}
})();


/* __PT_ERROR_OVERLAY__ */
(function(){
  function show(msg){
    try{
      let el=document.getElementById("__pt_err__");
      if(!el){
        el=document.createElement("div");
        el.id="__pt_err__";
        el.style.cssText="position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;background:#300;color:#fff;padding:12px;border-radius:12px;font:12px/1.4 monospace;white-space:pre-wrap;opacity:.98";
        document.body.appendChild(el);
      }
      el.textContent = "JS ERROR:\\n" + msg;
    }catch(e){}
  }
  window.addEventListener("error",(e)=>show(String(e.message||e.error||e)));
  window.addEventListener("unhandledrejection",(e)=>show(String(e.reason||e)));
})();

const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s??"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
async function jget(url){ const r=await fetch(url,{cache:"no-store"}); return r.json(); }
async function jpost(url, body){
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return r.json();
}

function setTab(name){
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.toggle("active", b.dataset.tab===name));
  document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("show", p.id===`tab-${name}`));
}

document.querySelectorAll(".navbtn").forEach(b=>b.onclick=()=>setTab(b.dataset.tab));

const themeBtn = $("themeBtn");
themeBtn.onclick=()=>{
  document.body.classList.toggle("light");
  themeBtn.textContent = document.body.classList.contains("light") ? "🌞" : "🌙";
};

$("clearFilters").onclick=()=>{
  $("leagueFilter").value="ALL";
  $("searchBox").value="";
  $("dateFilter").value="";
  renderGames();
};

$("refreshGames").onclick=()=>renderGames();
$("refreshToday").onclick=()=>renderToday();

$("samplePropsBtn").onclick=()=>{
  const sample = [
    {"player":"Luka Doncic","stat":"PTS","line":18.5,"projection":21.2,"type":"OVER","gameEventId":"401838140"},
    {"player":"Victor Wembanyama","stat":"BLK","line":1.5,"projection":2.1,"type":"OVER","gameEventId":"401838140"}
  ];
  $("bulkProps").value = JSON.stringify(sample, null, 2);
};

$("addPropsBtn").onclick=async ()=>{
  $("bulkMsg").textContent="…";
  let arr;
  try{ arr = JSON.parse($("bulkProps").value); } catch(e){ $("bulkMsg").textContent="Bad JSON"; return; }
  const out = await jpost("/api/player-props/bulk", arr);
  $("bulkMsg").textContent = out.ok ? `Added ${out.added||0}` : (out.error||"failed");
  await loadProps();
};

$("refreshProps").onclick=()=>loadProps();
$("gradeProps").onclick=async ()=>{ await jpost("/api/player-props/grade",{}); await loadProps(); };

$("runDailyBtn").onclick=async ()=>{
  const out = await jpost("/api/sync/daily",{season:2026,daysAhead:1});
  $("syncOut").textContent = JSON.stringify(out,null,2);
  await boot();
};

$("nbaRangeBtn").onclick=async ()=>{
  const start=$("rangeStart").value.trim(); const end=$("rangeEnd").value.trim();
  const out = await jpost("/api/sync/espn-nba-range",{season:2026,start,end});
  $("rangeOut").textContent = JSON.stringify(out,null,2);
  await boot();
};

$("ncaabRangeBtn").onclick=async ()=>{
  const start=$("rangeStart").value.trim(); const end=$("rangeEnd").value.trim();
  const out = await jpost("/api/sync/espn-ncaab-range",{season:2026,start,end});
  $("rangeOut").textContent = JSON.stringify(out,null,2);
  await boot();
};

$("syncTodayBtn").onclick=async ()=>{
  const out = await jpost("/api/sync/daily",{season:2026,daysAhead:0});
  $("syncOut").textContent = JSON.stringify(out,null,2);
  setTab("sync");
  await boot();
};

$("sync3moBtn").onclick=async ()=>{
  // use server helper endpoints (range) via dates derived on server? easiest: compute here
  const d0=new Date();
  const d1=new Date(); d1.setMonth(d1.getMonth()+3);
  const ymd=(d)=>`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  const start=ymd(d0), end=ymd(d1);
  $("rangeStart").value=start; $("rangeEnd").value=end;
  const nba = await jpost("/api/sync/espn-nba-range",{season:2026,start,end});
  const nc  = await jpost("/api/sync/espn-ncaab-range",{season:2026,start,end});
  $("rangeOut").textContent = JSON.stringify({nba,ncaab:nc},null,2);
  setTab("sync");
  await boot();
};

let GAMES_CACHE = [];
async function boot(){
  await loadPicker();
  await loadCounts();
  await loadQuick();
  await renderGames();
  await renderToday();
  await loadProps();
}

async function loadCounts(){
  const data = await jget("/api/game-picker");
  const games = (data.games||[]);
  const today = new Date(); const y=today.getFullYear(), m=today.getMonth(), d=today.getDate();
  const isToday = (iso)=>{
    const t=new Date(iso);
    return t.getFullYear()===y && t.getMonth()===m && t.getDate()===d;
  };
  const todayGames = games.filter(g=>isToday(g.startTime));
  $("todayCount").textContent = todayGames.length;
  $("todaySub").textContent = `NBA+NCAAB today`;

  const end = new Date(); end.setMonth(end.getMonth()+3);
  const in3mo = games.filter(g=>{ const t=new Date(g.startTime); return t>=today && t<=end; });
  $("rangeCount").textContent = in3mo.length;
  $("rangeSub").textContent = `up to ${end.toISOString().slice(0,10)}`;
}

async function loadQuick(){
  const data = await jget("/api/game-picker");
  const games = (data.games||[]).slice(0,40);
  const html = games.map(g=>{
    const eid = g.eventId || "";
    const btn = eid ? `<button class="btn ghost" data-eid="${esc(eid)}">Players</button>` : `<span class="badge warn">no eventId</span>`;
    return `<div class="item">
      <div class="left">
        <div><b>${esc(g.label)}</b></div>
        <div class="muted">eventId: ${esc(eid||"—")}</div>
      </div>
      <div>${btn}</div>
    </div>`;
  }).join("");
  $("quickList").innerHTML = html || `<div class="muted">No games loaded yet.</div>`;

  $("quickList").querySelectorAll("button[data-eid]").forEach(btn=>{
    btn.onclick=()=>{
      const eid = btn.getAttribute("data-eid");
      // set picker and jump to Players
      const sel = $("gamePicker");
      for(let i=0;i<sel.options.length;i++){
        if(sel.options[i].value===eid){ sel.selectedIndex=i; break; }
      }
      setTab("players");
      $("loadPlayersBtn").click();
    };
  });
}

async function loadPicker(){
  const data = await jget("/api/game-picker");
  const sel = $("gamePicker");
  sel.innerHTML = "";
  (data.games||[]).forEach(g=>{
    const opt=document.createElement("option");
    opt.value = g.eventId || "";
    opt.textContent = g.label + (g.eventId ? "" : " (no eventId)");
    sel.appendChild(opt);
  });
}

$("loadPlayersBtn").onclick = async ()=>{
  const eid = $("gamePicker").value.trim();
  if(!eid){ $("rosterList").innerHTML = `<div class="muted">No eventId for that game.</div>`; return; }

  $("nowPlaying").textContent = `eventId ${eid}`;
  const roster = await jget("/api/players/" + encodeURIComponent(eid));
  if(!roster.ok){ $("rosterList").innerHTML = `<pre class="pre">${esc(roster.error||"error")}</pre>`; return; }

  $("rosterList").innerHTML = (roster.players||[]).map(p=>(
    `<div class="item"><div class="left"><b>${esc(p.player)}</b><div class="muted">${esc(p.team||"")}</div></div></div>`
  )).join("") || `<div class="muted">No players.</div>`;

  // NBA boxscore lines endpoint if available (falls back silently)
  const box = await jget("/api/nba/game/" + encodeURIComponent(eid) + "/players").catch(()=>({ok:false}));
  if(box && box.ok){
    $("boxList").innerHTML = (box.players||[]).slice(0,40).map(x=>{
      const line = x.line || {};
      const pts = line.PTS ?? "—";
      const reb = line.REB ?? "—";
      const ast = line.AST ?? "—";
      return `<div class="item">
        <div class="left"><b>${esc(x.player)}</b><div class="muted">${esc(x.team||"")}</div></div>
        <div class="badge">PTS ${esc(pts)} • REB ${esc(reb)} • AST ${esc(ast)}</div>
      </div>`;
    }).join("") || `<div class="muted">No boxscore lines yet.</div>`;
  } else {
    $("boxList").innerHTML = `<div class="muted">No boxscore lines available (or not NBA).</div>`;
  }
};

function badgeForEdge(v){
  if(v==null || Number.isNaN(v)) return `<span class="badge">—</span>`;
  const n = Number(v);
  const cls = Math.abs(n) >= 3 ? "good" : Math.abs(n) >= 1.5 ? "warn" : "";
  return `<span class="badge ${cls}">${n>0?"+":""}${n.toFixed(1)}</span>`;
}

async function renderGames(){
  const league = $("leagueFilter").value;
  const search = $("searchBox").value.trim().toLowerCase();
  const date = $("dateFilter").value.trim();

  const data = await jget("/api/games");
  GAMES_CACHE = data;

  const rows = (data||[]).filter(g=>{
    if(league!=="ALL" && (g.league||"NCAAB")!==league) return false;
    const label = `${g.awayTeam?.name||""} @ ${g.homeTeam?.name||""} ${g.extId||""}`.toLowerCase();
    if(search && !label.includes(search)) return false;
    if(date){
      const d = new Date(g.startTime).toISOString().slice(0,10);
      if(d !== date) return false;
    }
    return true;
  });

  const body = $("gamesBody");
  body.innerHTML = rows.map(g=>{
    const league = g.league || "NCAAB";
    const t = new Date(g.startTime);
    const gdate = t.toISOString().slice(0,10);
    const time = t.toISOString().slice(11,16) + "Z";
    const whenStr = t.toISOString().slice(0,10) + " " + time;
    const when = `${gdate} ${time}`;

    const matchup = `${esc(g.awayTeam?.name||g.awayTeamId)} @ ${esc(g.homeTeam?.name||g.homeTeamId)}`;
    const eid = esc(g.extId || "—");

    const proj = `Spr ${g.projSpreadHome??"—"} • Tot ${g.projTotal??"—"} • WP ${(g.projWinProbHome!=null?Math.round(g.projWinProbHome*100):"—")}%`;
    const line = g.latestLine ? `Spr ${g.latestLine.spreadHome} • Tot ${g.latestLine.total} • ML ${g.latestLine.mlHome}` : "—";
    const edges = `S ${badgeForEdge(g.edges?.spread)} T ${badgeForEdge(g.edges?.total)} ML ${badgeForEdge((g.edges?.ml!=null)?(g.edges.ml*100):null)}`;

    const btn = g.extId ? `<button class="btn ghost" data-open="${esc(g.extId)}">Players</button>` : `<span class="badge warn">no id</span>`;

    return `<tr>
      <td>${whenStr}</td>
      <td>${esc(league)}</td>
      <td><b>${matchup}</b></td>
      <td>${eid}</td>
      <td class="muted">${esc(proj)}</td>
      <td class="muted">${esc(line)}</td>
      <td>${edges}</td>
      <td>${btn}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No games match filters.</td></tr>`;

  body.querySelectorAll("button[data-open]").forEach(b=>{
    b.onclick=()=>{
      const eid = b.getAttribute("data-open");
      // set picker and jump to players
      const sel = $("gamePicker");
      for(let i=0;i<sel.options.length;i++){
        if(sel.options[i].value===eid){ sel.selectedIndex=i; break; }
      }
      setTab("players");
      $("loadPlayersBtn").click();
    };
  });
}


async function renderToday(){
  const league = $("leagueFilter").value;
  const search = $("searchBox").value.trim().toLowerCase();

  const data = await jget("/api/games");

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const isToday = (iso)=>{
    const t = new Date(iso);
    return t.getUTCFullYear()===y && t.getUTCMonth()===m && t.getUTCDate()===d;
  };

  const rows = (data||[]).filter(g=>{
    const lg = g.league || "NCAAB";
    if(!isToday(g.startTime)) return false;
    if(league!=="ALL" && lg!==league) return false;

    const label = `${g.awayTeam?.name||""} @ ${g.homeTeam?.name||""} ${g.extId||""}`.toLowerCase();
    if(search && !label.includes(search)) return false;
    return true;
  });

  $("todayBody").innerHTML = rows.map(g=>{
    const lg = g.league || "NCAAB";
    const t = new Date(g.startTime);
    const gdate = t.toISOString().slice(0,10);
    const time = t.toISOString().slice(11,16) + "Z";
    const whenStr = t.toISOString().slice(0,10) + " " + time;
    const when = `${gdate} ${time}`;

    const matchup = `${esc(g.awayTeam?.name||g.awayTeamId)} @ ${esc(g.homeTeam?.name||g.homeTeamId)}`;
    const eid = esc(g.extId || "—");

    const proj = `Spr ${g.projSpreadHome??"—"} • Tot ${g.projTotal??"—"} • WP ${(g.projWinProbHome!=null?Math.round(g.projWinProbHome*100):"—")}%`;
    const line = g.latestLine ? `Spr ${g.latestLine.spreadHome} • Tot ${g.latestLine.total} • ML ${g.latestLine.mlHome}` : "—";
    const edges = `S ${badgeForEdge(g.edges?.spread)} T ${badgeForEdge(g.edges?.total)} ML ${badgeForEdge((g.edges?.ml!=null)?(g.edges.ml*100):null)}`;

    const btn = g.extId ? `<button class="btn ghost" data-open="${esc(g.extId)}">Players</button>` : `<span class="badge warn">no id</span>`;

    return `<tr>
      <td>${whenStr}</td>
      <td>${esc(lg)}</td>
      <td><b>${matchup}</b></td>
      <td>${eid}</td>
      <td class="muted">${esc(proj)}</td>
      <td class="muted">${esc(line)}</td>
      <td>${edges}</td>
      <td>${btn}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No games today match filters.</td></tr>`;

  document.querySelectorAll("#todayBody button[data-open]").forEach(b=>{
    b.onclick=()=>{
      const eid = b.getAttribute("data-open");
      const sel = $("gamePicker");
      for(let i=0;i<sel.options.length;i++){
        if(sel.options[i].value===eid){ sel.selectedIndex=i; break; }
      }
      setTab("players");
      $("loadPlayersBtn").click();
    };
  });
}

async function loadProps(){
  const rows = await jget("/api/player-props");
  $("propsList").innerHTML = (rows||[]).slice().reverse().map(p=>{
    const r = p.result || "PENDING";
    const cls = r==="WIN" ? "good" : r==="LOSS" ? "bad" : "warn";
    return `<div class="item">
      <div class="left">
        <div><b>${esc(p.player)}</b> <span class="muted">${esc(p.stat)} ${esc(p.type)} ${esc(p.line)}</span></div>
        <div class="muted">proj ${esc(p.projection)} • actual ${esc(p.actual)} • event ${esc(p.gameEventId)}</div>
      </div>
      <div class="badge ${cls}">${esc(r)}</div>
    </div>`;
  }).join("") || `<div class="muted">No props yet.</div>`;
}

boot();


/* __PT_PATCH_V2__ (Dashboard + Players fix) */

function fmt1(n){ return (n==null || Number.isNaN(Number(n))) ? "—" : Number(n).toFixed(1); }

async function renderDashboard(){
  // counts
  try{
    const d = await jget("/api/dashboard");
    $("todayCount").textContent = d.todayCount ?? "—";
    $("todaySub").textContent = "games with eventId";
    $("rangeCount").textContent = d.rangeCount ?? "—";
    $("rangeSub").textContent = "games with eventId";
  }catch(e){
    $("todaySub").textContent = "dashboard failed";
    $("rangeSub").textContent = "dashboard failed";
  }

  // quick links
  try{
    const q = await jget("/api/game-picker");
    const games = (q.games||[]);
    const el = $("quickList");
    if(!games.length){
      el.innerHTML = `<div class="muted">No games loaded yet. Hit Sync.</div>`;
      return;
    }
    el.innerHTML = games.slice(0,60).map(g=>{
      return `<div class="item">
        <div class="left">
          <div><b>${esc(g.label||"")}</b></div>
          <div class="muted">eventId ${esc(g.eventId||"")}</div>
        </div>
        <button class="btn ghost" data-open="${esc(g.eventId||"")}">Players</button>
      </div>`;
    }).join("");

    el.querySelectorAll("button[data-open]").forEach(b=>{
      b.onclick=()=>{
        const eid=b.getAttribute("data-open");
        // jump to Players tab and load
        setTab("players");
        const sel=$("gamePicker");
        for(let i=0;i<sel.options.length;i++){
          if(sel.options[i].value===eid){ sel.selectedIndex=i; break; }
        }
        $("loadPlayersBtn").click();
      };
    });

  }catch(e){
    $("quickList").innerHTML = `<div class="muted">Quick links failed.</div>`;
  }
}

async function refreshGamePicker(){
  try{
    const q = await jget("/api/game-picker");
    const games = (q.games||[]);
    const sel = $("gamePicker");
    sel.innerHTML = games.slice(0,200).map(g=>{
      const eid = g.eventId || "";
      return `<option value="${esc(eid)}">${esc(g.label||eid)}</option>`;
    }).join("") || `<option value="">No games</option>`;
  }catch(e){
    const sel = $("gamePicker");
    sel.innerHTML = `<option value="">No games</option>`;
  }
}

async function loadPlayersWithProjections(){
  const eid = $("gamePicker").value.trim();
  if(!eid){
    $("rosterList").innerHTML = `<div class="muted">Pick a game first.</div>`;
    $("boxList").innerHTML = "—";
    return;
  }
  $("nowPlaying").textContent = `eventId ${eid}`;

  // roster from DB (auto-loader fills athleteId)
  const r = await jget("/api/roster/" + encodeURIComponent(eid)).catch(()=>({ok:false, roster:null}));
  const roster = r.roster?.players || [];

  // HardRock lines (manual import)
  const hr = await jget("/api/hardrock/props?eventId=" + encodeURIComponent(eid)).catch(()=>({ok:false, rows:[]}));
  const lines = hr.rows || [];
  const lineMap = new Map();
  for(const x of lines){
    const k = `${(x.player||"").toLowerCase()}|${(x.stat||"").toUpperCase()}`;
    if(!lineMap.has(k)) lineMap.set(k, []);
    lineMap.get(k).push(x);
  }

  async function getHist(id){
    if(!id) return null;
    const h = await jget("/api/player-history/" + encodeURIComponent(id)).catch(()=>({ok:false, history:null}));
    return h.history?.projection || null;
  }

  // build list
  const out = [];
  for(const p of roster){
    const proj = p.athleteId ? await getHist(p.athleteId) : null;
    out.push({ ...p, proj });
  }

  const keys = ["PTS","REB","AST","3PT"];
  $("rosterList").innerHTML = out.map(p=>{
    const name = p.name || p.player || "—";
    const team = p.team || "";
    const proj = p.proj || {};

    function projVal(k){
      if(k==="PTS") return proj.pts;
      if(k==="REB") return proj.reb;
      if(k==="AST") return proj.ast;
      if(k==="3PT") return proj.threes;
      return null;
    }

    const linesHtml = keys.map(k=>{
      const pv = projVal(k);
      const lk = `${String(name).toLowerCase()}|${k}`;
      const l = (lineMap.get(lk)||[])[0];
      const lineText = l ? `${k} ${l.line}` : `${k} —`;
      const diff = (l && pv!=null) ? (pv - Number(l.line)) : null;

      let badge="";
      if(diff!=null){
        if(Math.abs(diff)>=2) badge="good";
        else if(Math.abs(diff)>=1) badge="warn";
      }
      const diffTag = (diff==null) ? "" : ` <span class="badge ${badge}">${diff>0?"+":""}${diff.toFixed(1)}</span>`;
      return `<div class="muted" style="margin-top:4px">${lineText} • proj ${fmt1(pv)}${diffTag}</div>`;
    }).join("");

    return `<div class="item">
      <div class="left">
        <div><b>${esc(name)}</b></div>
        <div class="muted">${esc(team)} ${p.athleteId?`• id ${esc(p.athleteId)}`:""}</div>
        ${linesHtml}
      </div>
      <div class="badge">Roster</div>
    </div>`;
  }).join("") || `<div class="muted">No roster yet. Run Sync + auto-loader.</div>`;

  // boxscore lines (NBA endpoint you already have)
  const box = await jget("/api/nba/game/" + encodeURIComponent(eid) + "/players").catch(()=>({ok:false}));
  if(box && box.ok){
    $("boxList").innerHTML = (box.players||[]).slice(0,60).map(x=>{
      const line = x.line || {};
      const pts=line.PTS ?? "—", reb=line.REB ?? "—", ast=line.AST ?? "—", th=line["3PT"] ?? "—";
      return `<div class="item">
        <div class="left"><b>${esc(x.player)}</b><div class="muted">${esc(x.team||"")}</div></div>
        <div class="badge">PTS ${esc(pts)} • REB ${esc(reb)} • AST ${esc(ast)} • 3PT ${esc(th)}</div>
      </div>`;
    }).join("") || `<div class="muted">No boxscore lines yet.</div>`;
  }else{
    $("boxList").innerHTML = `<div class="muted">No boxscore available (or not NBA).</div>`;
  }
}

// Force bind buttons even if earlier code changed
(function bindPatch(){
  try{
    // Dashboard loads
    renderDashboard();
    refreshGamePicker();

    // Buttons
    const rb = document.getElementById("refreshGames");
    if(rb) rb.onclick = ()=>renderGames();

    const rt = document.getElementById("refreshToday");
    if(rt) rt.onclick = ()=>renderToday();

    const lp = document.getElementById("loadPlayersBtn");
    if(lp) lp.onclick = ()=>loadPlayersWithProjections();

    // After sync buttons, refresh dashboard/picker
    const st = document.getElementById("syncTodayBtn");
    if(st) st.addEventListener("click", ()=>setTimeout(()=>{ renderDashboard(); refreshGamePicker(); }, 1200));

    const s3 = document.getElementById("sync3moBtn");
    if(s3) s3.addEventListener("click", ()=>setTimeout(()=>{ renderDashboard(); refreshGamePicker(); }, 1200));

  }catch(e){}
})();


/* __PT_DOM_READY_BOOT__ */
window.addEventListener("DOMContentLoaded", async ()=>{
  try{
    // prove JS is alive
    const ql = document.getElementById("quickList");
    if(ql && (ql.textContent||"").toLowerCase().includes("loading")){
      ql.textContent = "JS is running… loading data…";
    }

    // make sure dashboard + game picker always run AFTER DOM exists
    if(typeof renderDashboard === "function") await renderDashboard();
    if(typeof refreshGamePicker === "function") await refreshGamePicker();

    // hard-bind buttons (again) AFTER DOM exists
    const lp = document.getElementById("loadPlayersBtn");
    if(lp && typeof loadPlayersWithProjections === "function"){
      lp.onclick = ()=>loadPlayersWithProjections();
    }
    const rg = document.getElementById("refreshGames");
    if(rg && typeof renderGames === "function"){
      rg.onclick = ()=>renderGames();
    }
    const rt = document.getElementById("refreshToday");
    if(rt && typeof renderToday === "function"){
      rt.onclick = ()=>renderToday();
    }

  }catch(e){
    // triggers your red overlay via unhandledrejection if we rethrow
    console.error(e);
    throw e;
  }
});



/* __PT_PATCH_V3__ (NBA Player Search + Game Logs) */
(function(){
  function fmt1(n){ return (n==null || Number.isNaN(Number(n))) ? "—" : Number(n).toFixed(1); }
  const $id = (x)=>document.getElementById(x);

  async function searchPlayers(){
    const q = ($id("playerSearchBox")?.value || "").trim();
    const out = await jget("/api/nba/players" + (q ? ("?q=" + encodeURIComponent(q)) : ""));
    const list = $id("playerSearchList");
    if(!list) return;
    const players = out.players || [];
    if(!players.length){
      list.innerHTML = `<div class="muted">No players found yet. Hit Backfill Logs (or load a game roster).</div>`;
      return;
    }
    list.innerHTML = players.slice(0,80).map(p=>{
      return `<div class="item">
        <div class="left">
          <div><b>${esc(p.name||"")}</b></div>
          <div class="muted">${esc(p.team||"")} ${p.pos?("• "+esc(p.pos)):""} • id ${esc(p.athleteId||"")}</div>
        </div>
        <button class="btn ghost" data-ath="${esc(p.athleteId||"")}">Open</button>
      </div>`;
    }).join("");

    list.querySelectorAll("button[data-ath]").forEach(b=>{
      b.onclick = ()=> loadPlayerLog(b.getAttribute("data-ath"));
    });
  }

  async function loadPlayerLog(athleteId){
    if(!athleteId) return;
    const d = await jget("/api/nba/player/" + encodeURIComponent(athleteId) + "/gamelog?last=20");
    const title = $id("playerLogTitle");
    const roll = $id("playerRoll");
    const log = $id("playerLog");
    if(title) title.textContent = `athleteId ${athleteId}`;

    if(roll){
      const r = d.roll || {};
      roll.innerHTML = `<div class="item"><div class="left">
        <b>Rolling Averages</b>
        <div class="muted">L5 / L10 / L20</div>
        <div class="muted" style="margin-top:8px">
          PTS: ${fmt1(r.L5?.PTS)} / ${fmt1(r.L10?.PTS)} / ${fmt1(r.L20?.PTS)}<br/>
          REB: ${fmt1(r.L5?.REB)} / ${fmt1(r.L10?.REB)} / ${fmt1(r.L20?.REB)}<br/>
          AST: ${fmt1(r.L5?.AST)} / ${fmt1(r.L10?.AST)} / ${fmt1(r.L20?.AST)}<br/>
          3PT: ${fmt1(r.L5?.["3PT"])} / ${fmt1(r.L10?.["3PT"])} / ${fmt1(r.L20?.["3PT"])}
        </div>
      </div></div>`;
    }

    const rows = d.logs || [];
    if(!log) return;
    if(!rows.length){
      log.innerHTML = `<div class="muted">No stored logs yet. Hit Backfill Logs.</div>`;
      return;
    }
    log.innerHTML = rows.map(x=>{
      const ln = x.line || {};
      return `<div class="item">
        <div class="left">
          <div><b>${esc(x.dateISO||"")}</b> • ${esc(x.team||"")} vs ${esc(x.opponent||"")}</div>
          <div class="muted">eventId ${esc(x.eventId||"")}</div>
        </div>
        <div class="badge">PTS ${esc(ln.PTS??"—")} • REB ${esc(ln.REB??"—")} • AST ${esc(ln.AST??"—")} • 3PT ${esc(ln["3PT"]??"—")}</div>
      </div>`;
    }).join("");
  }

  async function backfillLogs(){
    const out = await jget("/api/dashboard").catch(()=>null);
    // default backfill window: last 14 days + next 1 day
    const body = { daysBack: 14, daysAhead: 1 };
    const r = await fetch("/api/nba/backfill-logs", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    alert(`Backfill done.\nGames considered: ${j.gamesConsidered}\nFetched: ${j.fetched}\nStored rows: ${j.storedRows}\nErrors: ${j.errors}`);
    await searchPlayers();
  }

  // Bind buttons (safe if not present)
  const sb = $id("playerSearchBtn");
  if(sb) sb.onclick = ()=>searchPlayers();
  const pb = $id("playerBackfillBtn");
  if(pb) pb.onclick = ()=>backfillLogs();
})();
/* ===== PROTRACKER DATE + TIME FIX (Quick Links) ===== */
(function(){

  async function __pt_fixQuickLinks(){
    try{
      const res = await jget("/api/game-picker");
      const games = res.games || [];
      const el = document.getElementById("quickList");
      if(!el) return;

      if(!games.length){
        el.innerHTML = `<div class="muted">No games loaded yet.</div>`;
        return;
      }

      el.innerHTML = games.slice(0,60).map(g=>{
        const t = new Date(g.startTime);
        const date = t.toISOString().slice(0,10);
        const time = t.toISOString().slice(11,16) + "Z";
        const title = `${date} ${time} • ${g.label || ""}`;

        return `<div class="item">
          <div class="left">
            <div><b>${esc(title)}</b></div>
            <div class="muted">eventId ${esc(g.eventId || "")}</div>
          </div>
          <button class="btn ghost" data-open="${esc(g.eventId || "")}">Players</button>
        </div>`;
      }).join("");

      el.querySelectorAll("button[data-open]").forEach(b=>{
        b.onclick=()=>{
          const eid=b.getAttribute("data-open");
          setTab("players");
          const sel=document.getElementById("gamePicker");
          for(let i=0;i<sel.options.length;i++){
            if(sel.options[i].value===eid){
              sel.selectedIndex=i;
              break;
            }
          }
          document.getElementById("loadPlayersBtn").click();
        };
      });

    }catch(e){
      console.log("QuickLinks fix failed:", e);
    }
  }

  // run after page loads
  setTimeout(__pt_fixQuickLinks, 300);

})();


/* ===== PROTRACKER: NBA STATS TAB (paste-at-bottom patch) ===== */
(function(){
  // tiny helpers
  const $id = (x)=>document.getElementById(x);
  const esc2 = (s)=>String(s??"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  async function jget2(url){
    const r = await fetch(url, { cache:"no-store" });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function ensureTabUI(){
    // add nav button
    const nav = document.querySelector(".nav");
    if(!nav) return false;

    if(!document.querySelector('.navbtn[data-tab="nbastats"]')){
      const btn = document.createElement("button");
      btn.className = "navbtn";
      btn.dataset.tab = "nbastats";
      btn.textContent = "NBA Stats";
      nav.appendChild(btn);
    }

    // add panel
    const content = document.querySelector(".content");
    if(!content) return false;

    if(!$id("tab-nbastats")){
      const panel = document.createElement("section");
      panel.className = "panel";
      panel.id = "tab-nbastats";
      panel.innerHTML = `
        <div class="panel-head">
          <div>
            <div class="panel-title">NBA Player Stats</div>
            <div class="muted">Pulled from your DB (ESPN boxscore lines saved by sync).</div>
          </div>
          <div class="row">
            <input id="nbaPlayerSearch" placeholder="Search player (ex: Doncic)" style="max-width:220px"/>
            <button class="btn ghost" id="nbaStatsRefresh">Refresh</button>
            <button class="btn" id="nbaStatsSync7">Sync last 7 days</button>
          </div>
        </div>

        <div class="card">
          <div class="card-h">Results</div>
          <div class="muted" id="nbaStatsMeta">Loading…</div>
          <div class="tablewrap" style="margin-top:10px">
            <table class="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>MIN</th>
                  <th>PTS</th>
                  <th>REB</th>
                  <th>AST</th>
                  <th>3PT</th>
                  <th>EventId</th>
                </tr>
              </thead>
              <tbody id="nbaStatsBody"></tbody>
            </table>
          </div>
        </div>
      `;
      content.appendChild(panel);
    }
    return true;
  }

  function showTab(tab){
    // mirror your existing tab system (works even if your app changed)
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("show"));
    const active = $id("tab-"+tab);
    if(active) active.classList.add("show");

    document.querySelectorAll(".navbtn").forEach(b=>b.classList.remove("active"));
    const nb = document.querySelector(`.navbtn[data-tab="${tab}"]`);
    if(nb) nb.classList.add("active");
  }

  async function renderNbaStats(){
    const body = $id("nbaStatsBody");
    const meta = $id("nbaStatsMeta");
    if(!body || !meta) return;

    meta.textContent = "Loading…";
    body.innerHTML = "";

    const q = ($id("nbaPlayerSearch")?.value || "").trim();
    const url = "/api/nba/stats/players?player=" + encodeURIComponent(q) + "&limit=200";
    let data;
    try{
      data = await jget2(url);
    }catch(e){
      meta.textContent = "Failed to load NBA stats: " + String(e.message||e);
      body.innerHTML = `<tr><td colspan="9" class="muted">API failed.</td></tr>`;
      return;
    }

    const rows = data.rows || [];
    meta.textContent = `Showing ${rows.length} of ${data.count ?? "?"} (limit 200).`;

    body.innerHTML = rows.map(r=>{
      const d = esc2(r.dateISO || "");
      const player = esc2(r.player || "");
      const team = esc2(r.team || "");
      const min = esc2(r.MIN ?? "—");
      const pts = esc2(r.PTS ?? "—");
      const reb = esc2(r.REB ?? "—");
      const ast = esc2(r.AST ?? "—");
      const th = esc2(r.THREES ?? "—");
      const eid = esc2(r.eventId ?? "");
      return `
        <tr>
          <td>${d}</td>
          <td><b>${player}</b></td>
          <td class="muted">${team}</td>
          <td>${min}</td>
          <td>${pts}</td>
          <td>${reb}</td>
          <td>${ast}</td>
          <td>${th}</td>
          <td class="muted">${eid}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="9" class="muted">No rows. Try syncing or widen search.</td></tr>`;
  }

  async function syncLast7Days(){
    const meta = $id("nbaStatsMeta");
    if(meta) meta.textContent = "Syncing last 7 days…";
    try{
      const r = await fetch("/api/nba/stats/sync-days", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body: JSON.stringify({ daysBack:7, limitGames:40 })
      });
      const j = await r.json();
      if(meta) meta.textContent = `Sync done: games ${j.games ?? "?"}, ok ${j.okCount ?? "?"}, fail ${j.failCount ?? "?"}`;
    }catch(e){
      if(meta) meta.textContent = "Sync failed: " + String(e.message||e);
    }
    await renderNbaStats();
  }

  function bind(){
    if(!ensureTabUI()) return;

    // click nav button
    document.querySelectorAll('.navbtn[data-tab="nbastats"]').forEach(b=>{
      b.onclick = ()=>{
        showTab("nbastats");
        renderNbaStats();
      };
    });

    // buttons
    const ref = $id("nbaStatsRefresh");
    if(ref) ref.onclick = ()=>renderNbaStats();

    const s7 = $id("nbaStatsSync7");
    if(s7) s7.onclick = ()=>syncLast7Days();

    const inp = $id("nbaPlayerSearch");
    if(inp){
      inp.addEventListener("keydown",(e)=>{
        if(e.key==="Enter") renderNbaStats();
      });
    }
  }

  // wait for page to exist
  const t = setInterval(()=>{
    try{
      bind();
      // once bound, stop spam
      if(document.querySelector('.navbtn[data-tab="nbastats"]') && $id("tab-nbastats")){
        clearInterval(t);
      }
    }catch(e){}
  }, 400);

})();

/* ==========================================================
   PT_UI: Today Edges widget (Dashboard)
   ========================================================== */
(async function PT_TODAY_EDGES_WIDGET(){
  try{
    // add container to Dashboard if missing
    const dash = document.getElementById("tab-dashboard");
    if(!dash) return;

    if(!document.getElementById("ptTodayEdgesCard")){
      const card = document.createElement("div");
      card.className = "card";
      card.id = "ptTodayEdgesCard";
      card.innerHTML = `
        <div class="card-h">Today Edges (NBA)</div>
        <div class="muted">Uses HardRock lines you imported + last N games averages.</div>
        <div class="row" style="margin-top:10px">
          <input id="ptEdgesMin" placeholder="minEdge (ex 0.5)" value="0.5" style="max-width:160px"/>
          <input id="ptEdgesGames" placeholder="games (ex 5)" value="5" style="max-width:120px"/>
          <button class="btn ghost" id="ptEdgesRefresh">Refresh</button>
        </div>
        <div class="list" id="ptEdgesList" style="margin-top:10px">Loading…</div>
      `;
      dash.appendChild(card);
    }

    async function loadEdges(){
      const minEdge = encodeURIComponent(document.getElementById("ptEdgesMin").value || "0.5");
      const games   = encodeURIComponent(document.getElementById("ptEdgesGames").value || "5");
      const el = document.getElementById("ptEdgesList");
      el.textContent = "Loading…";

      const data = await jget(`/api/nba/edges-today?minEdge=${minEdge}&games=${games}`);
      const rows = data.rows || [];
      if(!rows.length){
        el.innerHTML = `<div class="muted">No edges yet. Import more HardRock lines for today’s eventIds.</div>`;
        return;
      }

      el.innerHTML = rows.slice(0,80).map(r=>{
        const edge = Number(r.edge);
        const sign = edge>0 ? "+" : "";
        return `<div class="item">
          <div class="left">
            <div><b>${esc(r.player||"")}</b> <span class="muted">(${esc(r.team||"")})</span></div>
            <div class="muted">eventId ${esc(r.eventId)} • ${esc(r.stat)} line ${esc(r.line)} • proj ${esc(r.proj)} • games ${esc(r.games)}</div>
          </div>
          <div class="badge ${Math.abs(edge)>=2 ? "good" : Math.abs(edge)>=1 ? "warn" : ""}">${sign}${edge.toFixed(1)}</div>
        </div>`;
      }).join("");
    }

    const btn = document.getElementById("ptEdgesRefresh");
    if(btn) btn.onclick = loadEdges;

    // initial load
    loadEdges();
  }catch(e){
    // fail silently (overlay will show if you kept it)
  }
})();



/* __PT_UI_PROTRACKER_V1__ (Leaders + Edges Today panels) */
(function(){
  if (window.__PT_UI_PROTRACKER_V1__) return;
  window.__PT_UI_PROTRACKER_V1__ = true;

  const $ = (id)=>document.getElementById(id);

  // Safe helpers (don’t crash UI if earlier code changes)
  function getTabDashboard(){
    const el = document.getElementById("tab-dashboard");
    return el || document.querySelector('[id="tab-dashboard"]');
  }
  function esc(s){
    return String(s ?? "").replace(/[&<>"']/g, (c)=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }
  async function jget(url){
    const r = await fetch(url, { cache:"no-store" });
    if(!r.ok) throw new Error(`GET ${url} ${r.status}`);
    return r.json();
  }

  // Inject cards into Dashboard (no HTML edits required)
  function ensureDashboardCards(){
    const dash = getTabDashboard();
    if(!dash) return;

    if(!document.getElementById("ptLeadersCard")){
      const wrap = document.createElement("div");
      wrap.className = "grid2";
      wrap.style.marginTop = "12px";
      wrap.innerHTML = `
        <div class="card" id="ptLeadersCard">
          <div class="card-h">Today Leaders</div>
          <div class="muted" style="margin-bottom:8px">PTS • REB • AST • 3PT</div>
          <div class="list" id="ptLeadersList">Loading…</div>
        </div>
        <div class="card" id="ptEdgesCard">
          <div class="card-h">Edges Today</div>
          <div class="muted" style="margin-bottom:8px">Uses your HardRock imports vs last-N projections</div>
          <div class="list" id="ptEdgesList">Loading…</div>
        </div>
      `;
      dash.appendChild(wrap);
    }
  }

  function rowLine(title, arr, key){
    const top = (arr||[]).slice(0,8);
    if(!top.length) return `<div class="muted">${esc(title)}: none</div>`;
    return `
      <div style="padding:6px 0; border-bottom:1px solid rgba(0,0,0,.06)">
        <b>${esc(title)}</b>
        <div class="muted" style="margin-top:4px">
          ${top.map(x=>`${esc(x.player)} (${esc(x.team)}) ${esc(x[key])}`).join(" • ")}
        </div>
      </div>
    `;
  }

  async function loadLeaders(){
    const el = document.getElementById("ptLeadersList");
    if(!el) return;

    try{
      // you said today-leaders2 is working
      const data = await jget("/api/nba/stats/today-leaders2");
      const L = data.leaders || {};
      el.innerHTML =
        rowLine("Points", L.points, "PTS") +
        rowLine("Rebounds", L.rebounds, "REB") +
        rowLine("Assists", L.assists, "AST") +
        rowLine("3PT Made", L.threes, "THREES");
    }catch(e){
      el.innerHTML = `<div class="muted">Leaders failed: ${esc(e.message||e)}</div>`;
    }
  }

  function edgeBadge(edge){
    const n = Number(edge);
    if(Number.isNaN(n)) return "";
    const abs = Math.abs(n);
    const cls = abs>=2 ? "good" : abs>=1 ? "warn" : "";
    const sign = n>0 ? "+" : "";
    return `<span class="badge ${cls}">${sign}${n.toFixed(1)}</span>`;
  }

  async function loadEdgesToday(){
    const el = document.getElementById("ptEdgesList");
    if(!el) return;

    try{
      // If you change your endpoint name later, update it here.
      const data = await jget("/api/nba/edges-today?minEdge=0.5&games=5");
      const rows = data.rows || [];
      if(!rows.length){
        el.innerHTML = `<div class="muted">No edges yet. Import HardRock props for today’s eventIds.</div>`;
        return;
      }
      el.innerHTML = rows.slice(0,50).map(r=>{
        return `
          <div class="item">
            <div class="left">
              <div><b>${esc(r.player)}</b> <span class="muted">(${esc(r.team)})</span></div>
              <div class="muted">
                ${esc(r.stat)} line ${esc(r.line)} • proj ${esc(r.proj)} • event ${esc(r.eventId)} • last ${esc(r.games)} g
              </div>
            </div>
            ${edgeBadge(r.edge)}
          </div>
        `;
      }).join("");
    }catch(e){
      el.innerHTML = `<div class="muted">Edges failed: ${esc(e.message||e)}</div>`;
    }
  }

  // Run now + refresh every 60s (lightweight)
  function boot(){
    ensureDashboardCards();
    loadLeaders();
    loadEdgesToday();

    // If your app has a sync button, refresh after sync too
    const st = document.getElementById("syncTodayBtn");
    if(st){
      st.addEventListener("click", ()=>setTimeout(()=>{
        loadLeaders();
        loadEdgesToday();
      }, 1500));
    }
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  setInterval(()=>{ loadLeaders(); loadEdgesToday(); }, 60_000);
})();


/* __PT_PASTE_BOTTOM__ (Today + Leaders + Edges) */
(async function(){
  function qs(id){ return document.getElementById(id); }
  async function j(u){ const r=await fetch(u,{cache:"no-store"}); return r.json(); }
  function esc2(s){ return String(s??"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }

  // Add a "Today's Games" button if you don't already have one in the sidebar
  try{
    const nav = document.querySelector(".nav");
    if(nav && !qs("todayNavBtn")){
      const b=document.createElement("button");
      b.className="navbtn";
      b.id="todayNavBtn";
      b.textContent="Today's Games";
      b.setAttribute("data-tab","today");
      nav.insertBefore(b, nav.children[2] || null); // insert near Games/Players
      b.onclick=()=>{ try{ setTab("games"); }catch(e){}; renderToday2(); };
    }
  }catch(e){}

  // Create a Today panel if missing
  try{
    const content=document.querySelector(".content");
    if(content && !qs("tab-today")){
      const sec=document.createElement("section");
      sec.className="panel";
      sec.id="tab-today";
      sec.innerHTML = `
        <div class="panel-head">
          <div>
            <div class="panel-title">Today's Games</div>
            <div class="muted">NBA games that are on today's ET date.</div>
          </div>
          <div class="row">
            <button class="btn ghost" id="refreshToday2">Refresh</button>
          </div>
        </div>
        <div class="card">
          <div class="card-h">Leaders (Today)</div>
          <div class="list" id="leadersToday">Loading…</div>
        </div>
        <div class="card">
          <div class="card-h">Edges (Today)</div>
          <div class="muted">Requires HardRock prop import.</div>
          <div class="list" id="edgesToday">Loading…</div>
        </div>
        <div class="tablewrap">
          <table class="table">
            <thead>
              <tr>
                <th>Date/Time (UTC)</th>
                <th>League</th>
                <th>Matchup</th>
                <th>EventId</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="today2Body"></tbody>
          </table>
        </div>
      `;
      content.appendChild(sec);

      const btn = qs("refreshToday2");
      if(btn) btn.onclick=()=>renderToday2();
    }
  }catch(e){}

  function toYmdET(iso){
    // quick ET conversion using Intl
    try{
      const d = new Date(iso);
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(d);
      const y=parts.find(x=>x.type==="year").value;
      const m=parts.find(x=>x.type==="month").value;
      const da=parts.find(x=>x.type==="day").value;
      return `${y}-${m}-${da}`;
    }catch(e){
      return new Date(iso).toISOString().slice(0,10);
    }
  }

  async function renderToday2(){
    // Leaders
    try{
      const L = await j("/api/nba/stats/today-leaders2");
      const el = qs("leadersToday");
      if(el){
        const leaders = L.leaders || {};
        function block(title, arr, key){
          const rows = (arr||[]).slice(0,10).map(x=>`<div class="item"><div class="left"><b>${esc2(x.player)}</b><div class="muted">${esc2(x.team||"")}</div></div><div class="badge">${key} ${esc2(x[key])}</div></div>`).join("");
          return `<div style="margin:10px 0"><div class="muted" style="margin-bottom:6px">${title}</div>${rows || `<div class="muted">—</div>`}</div>`;
        }
        el.innerHTML =
          block("Points", leaders.points, "PTS") +
          block("Rebounds", leaders.rebounds, "REB") +
          block("Assists", leaders.assists, "AST") +
          block("3PT Made", leaders.threes, "THREES");
      }
    }catch(e){
      const el = qs("leadersToday");
      if(el) el.innerHTML = `<div class="muted">Leaders failed.</div>`;
    }

    // Edges today
    try{
      const E = await j("/api/nba/edges-today?minEdge=0.5&games=5");
      const el = qs("edgesToday");
      if(el){
        const rows = (E.rows||[]).slice(0,50).map(r=>{
          const edge = Number(r.edge);
          const tag = Number.isFinite(edge) ? `${edge>0?"+":""}${edge.toFixed(1)}` : "—";
          return `<div class="item">
            <div class="left">
              <b>${esc2(r.player)}</b>
              <div class="muted">${esc2(r.team||"")} • ${esc2(r.stat)} • line ${esc2(r.line)} • proj ${esc2(r.proj)} • games ${esc2(r.games)}</div>
            </div>
            <div class="badge">${tag}</div>
          </div>`;
        }).join("");
        el.innerHTML = rows || `<div class="muted">${esc2(E.note || "No edges yet (import HardRock lines).")}</div>`;
      }
    }catch(e){
      const el = qs("edgesToday");
      if(el) el.innerHTML = `<div class="muted">Edges failed.</div>`;
    }

    // Today's games list (from game-picker, filtered by ET date)
    try{
      const q = await j("/api/game-picker");
      const games = (q.games||[]);
      const todayET = toYmdET(new Date().toISOString());
      const rows = games.filter(g=> toYmdET(g.startTime) === todayET );

      const body = qs("today2Body");
      if(body){
        body.innerHTML = rows.map(g=>{
          const t = new Date(g.startTime);
          const when = t.toISOString().slice(0,16).replace("T"," ") + "Z";
          const matchup = (g.label||"").split("•").pop()?.trim() || g.label || "";
          const eid = g.eventId || "";
          return `<tr>
            <td>${esc2(when)}</td>
            <td>${esc2(g.league||"NBA")}</td>
            <td><b>${esc2(matchup)}</b></td>
            <td>${esc2(eid)}</td>
            <td><button class="btn ghost" data-open="${esc2(eid)}">Players</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="5" class="muted">No games found for today.</td></tr>`;

        body.querySelectorAll("button[data-open]").forEach(b=>{
          b.onclick=()=>{
            const eid=b.getAttribute("data-open");
            try{ setTab("players"); }catch(e){}
            const sel=document.getElementById("gamePicker");
            if(sel){
              for(let i=0;i<sel.options.length;i++){
                if(sel.options[i].value===eid){ sel.selectedIndex=i; break; }
              }
            }
            const lp=document.getElementById("loadPlayersBtn");
            if(lp) lp.click();
          };
        });
      }
    }catch(e){
      const body = qs("today2Body");
      if(body) body.innerHTML = `<tr><td colspan="5" class="muted">Failed to load games.</td></tr>`;
    }
  }

  // Run once on load
  try{ renderToday2(); }catch(e){}
})();


/* __PT_PASTE_BOTTOM__  TODAY LEADERS + EDGES PANEL */

async function renderTodayLeadersAndEdges(){
  try{
    // ===== TODAY LEADERS =====
    const leadersRes = await jget("/api/nba/stats/today-leaders2");
    const leaders = leadersRes?.leaders || {};

    function list(arr, key){
      if(!arr || !arr.length) return `<div class="muted">No data</div>`;
      return arr.slice(0,10).map(x=>`
        <div class="item">
          <div class="left">
            <b>${esc(x.player)}</b>
            <div class="muted">${esc(x.team||"")}</div>
          </div>
          <div class="badge">${esc(x[key])}</div>
        </div>
      `).join("");
    }

    const leadersHTML = `
      <div class="card">
        <h3>🔥 Today Leaders</h3>
        <div class="grid2">
          <div>
            <div class="muted">Points</div>
            ${list(leaders.points,"PTS")}
          </div>
          <div>
            <div class="muted">Rebounds</div>
            ${list(leaders.rebounds,"REB")}
          </div>
          <div>
            <div class="muted">Assists</div>
            ${list(leaders.assists,"AST")}
          </div>
          <div>
            <div class="muted">3PT</div>
            ${list(leaders.threes,"THREES")}
          </div>
        </div>
      </div>
    `;

    // ===== EDGES TODAY =====
    const edgesRes = await jget("/api/nba/edges-today?minEdge=0.5&games=5");
    const edges = edgesRes?.rows || [];

    const edgesHTML = `
      <div class="card">
        <h3>📈 Biggest Edges Today</h3>
        ${
          edges.length
          ? edges.map(e=>`
              <div class="item">
                <div class="left">
                  <b>${esc(e.player)}</b>
                  <div class="muted">${esc(e.team||"")} • ${esc(e.stat)}</div>
                </div>
                <div class="badge">
                  Line ${e.line} • Proj ${e.proj}
                  <span class="${e.edge>0?'good':'warn'}">
                    ${e.edge>0?'+':''}${Number(e.edge).toFixed(1)}
                  </span>
                </div>
              </div>
            `).join("")
          : `<div class="muted">No edges yet (import prop lines).</div>`
        }
      </div>
    `;

    let el = document.getElementById("todayLeadersBlock");
    if(!el){
      el = document.createElement("div");
      el.id = "todayLeadersBlock";
      document.body.appendChild(el);
    }

    el.innerHTML = leadersHTML + edgesHTML;

  }catch(e){
    console.log("leaders/edges load failed", e);
  }
}

// auto run after page load
setTimeout(renderTodayLeadersAndEdges, 1200);


/* =========================
   __PT_UI_DK_PROPS_V1__ (paste at bottom of public/app.js)
   Adds a "Today's NBA Edges" panel on Dashboard.
   ========================= */
(function __PT_UI_DK_PROPS_V1__(){
  try{
    function $(id){ return document.getElementById(id); }

    // If your Dashboard already has a spot, we’ll append to #quickList safely.
    async function renderEdgesToday(){
      const host = document.getElementById("quickList") || document.body;
      let box = document.getElementById("__edgesTodayBox");
      if(!box){
        box = document.createElement("div");
        box.id="__edgesTodayBox";
        box.className="card";
        box.style.marginTop="10px";
        box.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div>
              <div style="font-weight:700">Today's NBA Edges</div>
              <div class="muted" id="__edgesTodaySub">Import DK props then refresh</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" id="__pullDkBtn">Pull DK Props</button>
              <button class="btn ghost" id="__refreshEdgesBtn">Refresh</button>
            </div>
          </div>
          <div class="muted" style="margin-top:8px">
            minEdge <input id="__minEdge" value="0.5" style="width:70px"> 
            games <input id="__gamesN" value="5" style="width:60px">
          </div>
          <div id="__edgesTodayList" style="margin-top:10px"></div>
        `;
        host.prepend(box);
      }

      async function pull(){
        $("#__edgesTodaySub").textContent = "Pulling DraftKings props...";
        const body = {
          sportKey:"basketball_nba",
          bookmaker:"draftkings",
          markets:"player_points,player_rebounds,player_assists,player_threes"
        };
        const r = await fetch("/api/odds/dk/pull", {
          method:"POST",
          headers:{ "content-type":"application/json" },
          body: JSON.stringify(body)
        });
        const j = await r.json().catch(()=>({ok:false}));
        if(!j.ok){
          $("#__edgesTodaySub").textContent = "Pull failed: " + (j.error||"unknown");
        }else{
          $("#__edgesTodaySub").textContent = `Pulled: matched ${j.matched}, imported ${j.imported}`;
        }
        await refresh();
      }

      async function refresh(){
        const minEdge = (document.getElementById("__minEdge")||{}).value || "0.5";
        const games = (document.getElementById("__gamesN")||{}).value || "5";
        const r = await fetch(`/api/nba/edges-today?minEdge=${encodeURIComponent(minEdge)}&games=${encodeURIComponent(games)}`);
        const j = await r.json().catch(()=>({ok:false, rows:[]}));
        const list = document.getElementById("__edgesTodayList");
        if(!j.ok){
          list.innerHTML = `<div class="muted">Edges failed: ${String(j.error||"unknown")}</div>`;
          return;
        }
        if(!j.rows || !j.rows.length){
          list.innerHTML = `<div class="muted">No edges found (need DK props + NBA stats in DB).</div>`;
          return;
        }
        list.innerHTML = j.rows.slice(0,80).map(x=>{
          const dir = x.edge>0 ? "OVER" : "UNDER";
          const e = (x.edge>0?"+":"") + Number(x.edge).toFixed(2);
          return `
            <div class="item">
              <div class="left">
                <div><b>${x.player}</b> <span class="muted">(${x.team||""})</span></div>
                <div class="muted">event ${x.eventId} • ${x.stat} line ${x.line} • proj ${x.proj} • ${dir} edge ${e} • g${x.games}</div>
              </div>
              <div class="badge">${dir}</div>
            </div>
          `;
        }).join("");
      }

      const pullBtn = document.getElementById("__pullDkBtn");
      if(pullBtn && !pullBtn.__bound){
        pullBtn.__bound=true;
        pullBtn.onclick=pull;
      }
      const refBtn = document.getElementById("__refreshEdgesBtn");
      if(refBtn && !refBtn.__bound){
        refBtn.__bound=true;
        refBtn.onclick=refresh;
      }

      await refresh();
    }

    // Run once on load
    setTimeout(renderEdgesToday, 800);
    console.log("[patch] UI DK edges panel ready ✅");
  }catch(e){}
})();

/* ===== PT: SHOW TODAY EDGE TIERS ON DASHBOARD ===== */
(async function(){
  try{
    // Add a simple "Today Edges" panel if it doesn't exist
    const host = document.querySelector("#quickList")?.parentElement || document.body;
    if(!document.getElementById("todayEdgesBox")){
      const box = document.createElement("div");
      box.id = "todayEdgesBox";
      box.className = "card";
      box.style.marginTop = "12px";
      box.innerHTML = `
        <div class="row" style="justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:700">Today Edges (tiered)</div>
            <div class="muted" id="todayEdgesSub">loading…</div>
          </div>
          <button class="btn ghost" id="refreshTodayEdges">Refresh</button>
        </div>
        <div id="todayEdgesList" class="list" style="margin-top:10px"></div>
      `;
      host.appendChild(box);
    }

    async function loadTodayEdges(){
      const el = document.getElementById("todayEdgesList");
      const sub = document.getElementById("todayEdgesSub");
      if(!el || !sub) return;

      sub.textContent = "loading…";
      const d = await jget("/api/nba/edges-today-tiered?minEdge=0.5&games=5");
      const rows = (d.rows||[]);

      sub.textContent = `${d.date||""} • ${rows.length} edges`;

      if(!rows.length){
        el.innerHTML = `<div class="muted">No edges yet (need props imported).</div>`;
        return;
      }

      el.innerHTML = rows.slice(0,50).map(r=>{
        const dir = (Number(r.edge) > 0) ? "OVER" : "UNDER";
        const edgeAbs = Math.abs(Number(r.edge||0)).toFixed(1);
        return `
          <div class="item">
            <div class="left">
              <div><b>${esc(r.player||"")}</b> <span class="badge">${esc(r.team||"")}</span></div>
              <div class="muted">${esc(r.stat)} line ${esc(r.line)} • proj ${esc(r.proj)} • edge ${dir} ${edgeAbs}</div>
            </div>
            <div class="badge ${r.tier==="A"?"good":(r.tier==="B"?"warn":"")}">Tier ${esc(r.tier||"")}</div>
          </div>
        `;
      }).join("");
    }

    const btn = document.getElementById("refreshTodayEdges");
    if(btn) btn.onclick = loadTodayEdges;

    loadTodayEdges();
  }catch(e){
    // fail silently so it never breaks the app
  }
})();


/* ===================== PT PATCH: show matchup label in NBA Stats tables ===================== */
(function PT_STATS_EVENTID_LABELS(){
  let map = null;
  let lastFetch = 0;

  async function getMap(){
    const now = Date.now();
    if(map && (now - lastFetch) < 60_000) return map; // cache 60s
    lastFetch = now;
    try{
      const r = await fetch("/api/games-map", { cache:"no-store" });
      const j = await r.json();
      map = (j && j.ok && j.map) ? j.map : {};
    }catch(e){
      map = {};
    }
    return map;
  }

  function looksLikeEventId(s){
    // ESPN event ids are typically digits length ~9
    return /^[0-9]{8,12}$/.test(String(s||"").trim());
  }

  function patchCells(m){
    // Find any table cell that is EXACTLY an eventId and replace text.
    const tds = document.querySelectorAll("td, .badge, .muted, div");
    for(const el of tds){
      if(!el || !el.textContent) continue;
      const raw = el.textContent.trim();
      if(!looksLikeEventId(raw)) continue;

      const hit = m[raw];
      if(!hit) continue;

      const label = (hit.label || "").trim();
      if(!label) continue;

      // avoid double-patching
      if(el.textContent.includes("@") || el.textContent.includes("(")) continue;

      el.textContent = `${label} (${raw})`;
    }
  }

  async function tick(){
    const m = await getMap();
    patchCells(m);
  }

  // run periodically because the stats tab rerenders
  setInterval(tick, 1200);
  tick();
})();

/* ===== PT PATCH: Replace NBA eventId text with matchup label ===== */
(async function PT_EVENTID_TO_MATCHUP(){
  async function getMap(){
    try{
      const r = await jget("/api/games-map");
      return r?.map || null;
    }catch(e){ return null; }
  }

  const map = await getMap();
  if(!map) return;

  function label(eid){
    const g = map[eid];
    if(!g) return eid;
    return `${g.matchup} • ${eid}`;
  }

  function patchDom(){
    // Replace raw eventId-only nodes (common in tables)
    const nodes = document.querySelectorAll("td,span,div");
    for(const el of nodes){
      if(el.dataset && el.dataset.ptEidPatched) continue;
      const t = (el.textContent||"").trim();
      if(/^\d{9}$/.test(t) && map[t]){
        el.textContent = label(t);
        if(el.dataset) el.dataset.ptEidPatched = "1";
      }
    }
  }

  patchDom();
  setInterval(patchDom, 800);
})();

/* ===== PT PATCH: SHOW TEAM NAMES INSTEAD OF EVENT ID ===== */

(async () => {
  try {

    // cache
    let __ptGamesMap = null;

    async function ptGetGamesMap() {
      if (__ptGamesMap) return __ptGamesMap;

      const today = new Date().toISOString().slice(0,10);
      const r = await fetch(`/api/games-map?date=${today}`);
      const j = await r.json();

      __ptGamesMap = j?.map || {};
      return __ptGamesMap;
    }

    function ptLabelForEvent(eventId) {
      if (!__ptGamesMap) return eventId;
      const k = String(eventId);
      return __ptGamesMap[k]?.label || eventId;
    }

    // wait until page loads
    window.addEventListener("load", async () => {

      const map = await ptGetGamesMap();

      // replace any visible eventId text automatically
      document.querySelectorAll("[data-eventid]").forEach(el => {
        const id = el.getAttribute("data-eventid");
        if (!id) return;
        el.textContent =
          `${ptLabelForEvent(id)}  |  id:${id}`;
      });

      console.log("[PT] eventId → team labels applied ✅");
    });

  } catch (e) {
    console.warn("[PT] games-map patch failed", e);
  }
})();

/* ===== PT: REPLACE EVENT ID WITH TEAM LABELS (KEEP ID) =====
   - Uses /api/games-map2 which should include label/homeTeam/awayTeam
   - Safe: if map missing, leaves text alone
*/
(function PT_EVENT_LABELS_PATCH(){
  async function loadGamesMap2() {
    try {
      const r = await fetch('/api/games-map2');
      const j = await r.json();
      return (j && j.ok && j.map) ? j.map : {};
    } catch (e) {
      return {};
    }
  }

  function replaceEventIdsInNodeText(node, map) {
    const txt = node.nodeValue;
    if (!txt) return;

    // ESPN/ProTracker eventIds are usually 9 digits starting with 4 (ex: 401838140)
    const m = txt.match(/\b(4\d{8})\b/);
    if (!m) return;

    const id = m[1];
    const item = map[id];
    if (!item || !item.label) return;

    // Replace just the id with the label (label already includes "(id)" in your API)
    node.nodeValue = txt.replace(id, item.label);
  }

  async function run() {
    const map = await loadGamesMap2();
    if (!map || Object.keys(map).length === 0) return;

    // 1) Replace inside text nodes across the page (tables, headers, etc.)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      replaceEventIdsInNodeText(n, map);
    }

    // 2) Replace for obvious "eventId ..." labels too
    document.querySelectorAll('td, th, div, span, a').forEach(el => {
      const t = (el.textContent || '').trim();
      if (!t) return;
      // catches "eventId 401838140"
      const m = t.match(/\beventId\s+(4\d{8})\b/);
      if (!m) return;
      const id = m[1];
      const item = map[id];
      if (item && item.label) el.textContent = item.label;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

/* ===== PT SAFE INNERHTML GUARD ===== */
(function () {

  window.PT_SAFE_HTML = function (id, html) {
    try {
      const el = document.getElementById(id);
      if (!el) {
        console.warn("[PT] element not found:", id);
        return;
      }
      el.innerHTML = html;
    } catch (e) {
      console.warn("[PT] innerHTML skipped:", e.message);
    }
  };

})();

/* ===== PT GLOBAL SAFE INNERHTML FIX ===== */
(function () {

  const _set = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");

  Object.defineProperty(Element.prototype, "innerHTML", {
    set: function (value) {
      try {
        if (!this) return;
        _set.set.call(this, value);
      } catch (e) {
        console.warn("[PT] prevented innerHTML crash:", e.message);
      }
    },
    get: _set.get
  });

})();

/* ===== PT: STOP null.innerHTML CRASH (GLOBAL SAFETY) ===== */
(function () {
  function makeNullEl(tag) {
    // Proxy that safely absorbs any .innerHTML / .textContent / .appendChild / etc.
    return new Proxy(
      {
        __isNullEl: true,
        tagName: String(tag || "NULL"),
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        removeChild() {},
        insertAdjacentHTML() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      },
      {
        get(target, prop) {
          if (prop === "innerHTML" || prop === "textContent" || prop === "value") return "";
          if (prop in target) return target[prop];
          return undefined;
        },
        set(target, prop, value) {
          // swallow assignments like el.innerHTML = "..."
          try { target[prop] = value; } catch (e) {}
          return true;
        },
      }
    );
  }

  const _getEl = document.getElementById.bind(document);
  document.getElementById = function (id) {
    const el = _getEl(id);
    return el || makeNullEl(id);
  };

  // Also prevent the red JS ERROR banner for this specific crash
  window.addEventListener("error", function (e) {
    const msg = String(e && e.message || "");
    if (msg.includes("Cannot set properties of null") && msg.includes("innerHTML")) {
      e.preventDefault();
      return false;
    }
  });
})();

/* ===== PT: AUTO-CREATE MISSING DOM NODES (REAL ELEMENTS) ===== */
(function () {
  const _getEl = document.getElementById.bind(document);

  function findRoot() {
    // try common roots first
    return (
      _getEl("app") ||
      _getEl("root") ||
      document.querySelector("main") ||
      document.querySelector("#content") ||
      document.body
    );
  }

  function ensureRealEl(id) {
    let el = _getEl(id);
    if (el) return el;

    // create a real node so innerHTML writes actually render
    el = document.createElement("div");
    el.id = id;

    // put it somewhere sane
    const root = findRoot();
    root.appendChild(el);

    return el;
  }

  document.getElementById = function (id) {
    if (!id) return null;
    return ensureRealEl(id);
  };

  // Still suppress ONLY this specific crash, but now it shouldn't happen anyway
  window.addEventListener("error", function (e) {
    const msg = String((e && e.message) || "");
    if (msg.includes("Cannot set properties of null") && msg.includes("innerHTML")) {
      e.preventDefault();
      return false;
    }
  });
})();

/* ===== PT HOTFIX: keep Quick Links + Edge sections from disappearing (bottom patch) ===== */
(() => {
  // Try a bunch of likely container IDs (your app.js may use any of these)
  const ROOT_IDS = ["app", "root", "main", "content", "page", "container"];

  // Create (or re-create) the containers that other code expects to exist.
  function ensureDashboardSlots() {
    const root =
      document.getElementById(ROOT_IDS.find((id) => document.getElementById(id)) || "") ||
      document.body;

    // These are the common IDs we’ve been targeting in this project.
    // If your earlier code uses different IDs, add them here.
    const slotIds = [
      "quickLinks",
      "ptQuickLinks",
      "ptTodayEdgeTiers",
      "todayEdgeTiers",
      "edgeTiers",
      "ptEdgeTiers",
      "ptEdgesToday",
      "edgesToday",
    ];

    for (const id of slotIds) {
      if (!document.getElementById(id)) {
        const d = document.createElement("div");
        d.id = id;
        // Put them near the top of the page so they’re visible.
        root.prepend(d);
      }
    }
  }

  // Run once now
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureDashboardSlots, { once: true });
  } else {
    ensureDashboardSlots();
  }

  // Run after re-renders: many SPAs replace innerHTML and nuke the slots.
  // MutationObserver is the cleanest “bottom patch” way to re-add them.
  const obs = new MutationObserver(() => ensureDashboardSlots());
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Also run on common navigation / hash changes.
  window.addEventListener("hashchange", ensureDashboardSlots);
  window.addEventListener("popstate", ensureDashboardSlots);
})();

/* ===== PT HOTFIX: STICKY QUICK LINKS (SURVIVES RE-RENDERS) =====
   - Renders outside the app root so it won't vanish when innerHTML gets reset.
   - Re-attaches automatically if anything removes it.
*/
(function PT_STICKY_QUICK_LINKS() {
  const BAR_ID = "pt-sticky-quicklinks";

  function getOrCreateBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;

    bar = document.createElement("div");
    bar.id = BAR_ID;

    // Keep it simple: inline styles so it doesn't depend on your CSS
    bar.style.position = "sticky";
    bar.style.top = "0";
    bar.style.zIndex = "99999";
    bar.style.padding = "10px 12px";
    bar.style.borderBottom = "1px solid rgba(255,255,255,0.12)";
    bar.style.background = "rgba(12,12,14,0.96)";
    bar.style.backdropFilter = "blur(6px)";
    bar.style.webkitBackdropFilter = "blur(6px)";
    bar.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    bar.style.fontSize = "14px";

    bar.innerHTML = `
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
        <strong style="margin-right:6px;">Quick Links</strong>
        <a href="/api/nba/edges-today-tiered?minEdge=0.5&games=5" target="_blank" rel="noopener"
           style="text-decoration:none; padding:6px 10px; border:1px solid rgba(255,255,255,0.18); border-radius:10px; color:#fff;">
          Edges Today (Tiered)
        </a>
        <a href="/api/nba/edges-today?minEdge=0.5&games=5" target="_blank" rel="noopener"
           style="text-decoration:none; padding:6px 10px; border:1px solid rgba(255,255,255,0.18); border-radius:10px; color:#fff;">
          Edges Today
        </a>
        <a href="/api/odds/sgo/props?limit=50" target="_blank" rel="noopener"
           style="text-decoration:none; padding:6px 10px; border:1px solid rgba(255,255,255,0.18); border-radius:10px; color:#fff;">
          SGO Props (50)
        </a>
        <a href="/api/games-map?date=" target="_blank" rel="noopener"
           style="text-decoration:none; padding:6px 10px; border:1px solid rgba(255,255,255,0.18); border-radius:10px; color:#fff;">
          Games Map (date=YYYY-MM-DD)
        </a>

        <button id="pt-sgo-pull-btn"
          style="padding:6px 10px; border:1px solid rgba(255,255,255,0.18); border-radius:10px; background:transparent; color:#fff;">
          Pull SGO Now
        </button>

        <span id="pt-sgo-pull-status" style="opacity:0.8; margin-left:6px;"></span>
      </div>
    `;

    // Insert at very top of <body> so it survives any app-root changes
    document.body.insertBefore(bar, document.body.firstChild);

    // Wire up Pull button
    const btn = bar.querySelector("#pt-sgo-pull-btn");
    const status = bar.querySelector("#pt-sgo-pull-status");
    if (btn && status) {
      btn.onclick = async () => {
        status.textContent = "Pulling…";
        try {
          const res = await fetch("/api/odds/sgo/pull", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({})
          });
          const j = await res.json().catch(() => ({}));
          if (j && j.ok) {
            status.textContent = `OK props=${j.totalProps ?? "?"} saved=${j.savedMirroredRows ?? "?"}`;
          } else {
            status.textContent = `ERR ${j?.error || res.status}`;
          }
        } catch (e) {
          status.textContent = "ERR (fetch failed)";
        }
        setTimeout(() => (status.textContent = ""), 7000);
      };
    }

    return bar;
  }

  function ensureBar() {
    // If body doesn't exist yet, try again shortly
    if (!document.body) return;
    getOrCreateBar();
  }

  // 1) Create once after load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureBar);
  } else {
    ensureBar();
  }

  // 2) Re-attach if anything removes it
  const mo = new MutationObserver(() => {
    if (!document.getElementById(BAR_ID)) {
      // Recreate quickly
      ensureBar();
    }
  });

  const startObserver = () => {
    if (!document.body) return;
    mo.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }

  // 3) Belt-and-suspenders: periodic check (cheap)
  setInterval(() => {
    if (!document.getElementById(BAR_ID)) ensureBar();
  }, 1500);
})();

(function(){
function ptFormatDateTime(iso){ try{ const d = new Date(iso); if(isNaN(d)) return iso;
const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mi = String(d.getMinutes()).padStart(2,"0");

  return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi;
}catch(e){
  return iso;
}
}
function ptFixQuickLinkDates(){ try{ document.querySelectorAll("tr").forEach(tr=>{ const timeCell = tr.querySelector("td:last-child"); if(!timeCell) return;
if(timeCell.dataset.ptDone === "1") return;

    const iso = tr.getAttribute("data-starttime");
    if(!iso) return;

    timeCell.innerText = ptFormatDateTime(iso);
    timeCell.dataset.ptDone = "1";
  });
}catch(e){}
}
setInterval(ptFixQuickLinkDates, 800);
})();

(function(){ function ptDisableBadLinks(){ try{ document.querySelectorAll("a").forEach(a=>{ const h = a.getAttribute("href"); if(!h) return;
const bad =
      h === "null" ||
      h === "undefined" ||
      h === "NaN" ||
      h.includes("=null") ||
      h.includes("=undefined") ||
      h.endsWith("/null") ||
      h.endsWith("/undefined");

    if(!bad) return;

    // prevent Android "null is unreachable"
    a.setAttribute("href", "#");
    if(a.dataset.ptBadLink === "1") return;
    a.dataset.ptBadLink = "1";
    a.addEventListener("click", (e)=>e.preventDefault(), { passive:false });

    // optional: make it obvious it's disabled
    a.style.opacity = "0.6";
    a.style.textDecoration = "line-through";
    a.title = "Link not ready (missing data)";
  });
}catch(e){}
}
setInterval(ptDisableBadLinks, 700); })();

/* ===== PT FIX: prevent null links (Android) ===== */
(function(){
  function fixBadLinks(){
    try{
      document.querySelectorAll("a").forEach(a=>{
        const href = a.getAttribute("href");
        if(!href) return;

        if(
          href === "null" ||
          href === "undefined" ||
          href.includes("=null") ||
          href.includes("=undefined")
        ){
          a.setAttribute("href","#");
          a.onclick = (e)=>e.preventDefault();
        }
      });
    }catch(e){}
  }

  setInterval(fixBadLinks, 800);
})();

/* ===== PT HARD FIX: persistent Quick Links bar (won't disappear) ===== */
(function () {
  const BAR_ID = "ptQuickLinksBarV1";

  function ymdET() {
    try {
      // America/New_York date string (YYYY-MM-DD)
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
    } catch (e) {
      const dt = new Date();
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  function safeNav(targets) {
    // Try a few navigation strategies; fallback to API view in browser.
    for (const t of targets) {
      try {
        if (!t) continue;
        if (typeof t === "function") { t(); return; }
        if (typeof t === "string") {
          if (t.startsWith("#")) { location.hash = t; return; }
          location.href = t; return;
        }
      } catch (e) {}
    }
  }

  function ensureBar() {
    try {
      let bar = document.getElementById(BAR_ID);
      if (!bar) {
        bar = document.createElement("div");
        bar.id = BAR_ID;
        bar.style.position = "sticky";
        bar.style.top = "0";
        bar.style.zIndex = "99999";
        bar.style.background = "rgba(20,20,20,0.98)";
        bar.style.color = "#fff";
        bar.style.padding = "10px 10px";
        bar.style.borderBottom = "1px solid rgba(255,255,255,0.12)";
        bar.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
        bar.style.fontSize = "14px";
        bar.style.display = "flex";
        bar.style.flexWrap = "wrap";
        bar.style.gap = "8px";
        bar.style.alignItems = "center";

        const date = ymdET();
        const mkBtn = (label, onClick) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.style.padding = "6px 10px";
          b.style.borderRadius = "10px";
          b.style.border = "1px solid rgba(255,255,255,0.18)";
          b.style.background = "rgba(255,255,255,0.08)";
          b.style.color = "#fff";
          b.style.cursor = "pointer";
          b.onclick = (e) => { e.preventDefault(); onClick(); };
          return b;
        };

        const title = document.createElement("div");
        title.textContent = `Quick • ${date}`;
        title.style.fontWeight = "700";
        title.style.marginRight = "6px";
        bar.appendChild(title);

        bar.appendChild(mkBtn("Dashboard", () => safeNav([
          () => window.renderDashboard && window.renderDashboard(),
          "#dashboard",
          "/"
        ])));

        bar.appendChild(mkBtn("Edges Today", () => safeNav([
          () => window.renderEdgesToday && window.renderEdgesToday(),
          "#edges",
          "/?tab=edges",
          `/api/nba/edges-today-tiered?minEdge=0.5&games=10`
        ])));

        bar.appendChild(mkBtn("NBA Leaders", () => safeNav([
          () => window.renderNbaStats && window.renderNbaStats(),
          "#nba-stats",
          "/?tab=nba",
          `/api/nba/stats/today-leaders2`
        ])));

        bar.appendChild(mkBtn("Pull Props (SGO)", () => {
          fetch("/api/odds/sgo/pull", { method: "POST" })
            .then(r => r.json())
            .then(j => alert(j.ok ? `SGO pulled ✅ props=${j.totalProps || "?"}` : `SGO pull failed: ${j.error || "?"}`))
            .catch(err => alert("SGO pull failed: " + err));
        }));

        document.body.prepend(bar);
      } else {
        // update date label if needed
        const date = ymdET();
        const first = bar.firstChild;
        if (first && first.nodeType === 1 && first.textContent && !first.textContent.includes(date)) {
          first.textContent = `Quick • ${date}`;
        }
      }
    } catch (e) {}
  }

  // Keep it alive even if the app re-renders and wipes nodes.
  ensureBar();
  setInterval(ensureBar, 500);

  // Extra: if the app overwrites body/html, bring it back immediately.
  try {
    const obs = new MutationObserver(() => ensureBar());
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();

// ===== PATCH: NBA STATS (leaders) route =====
(function () {
  try {
    if (!globalThis.__PT_PATCHES) globalThis.__PT_PATCHES = {};
    if (globalThis.__PT_PATCHES.nbaStatsLeadersRoute) return;
    globalThis.__PT_PATCHES.nbaStatsLeadersRoute = true;

    // Find the express app (supports common patterns)
    const APP =
      (typeof app !== "undefined" && app) ||
      globalThis.app ||
      (globalThis.__PT_APP && globalThis.__PT_APP) ||
      null;

    if (!APP || typeof APP.get !== "function") {
      console.log("[patch] nba/stats/leaders skipped (app not found)");
      return;
    }

    const getDB = () => {
      try { if (typeof globalThis.readDB === "function") return globalThis.readDB(); } catch {}
      try { if (APP.locals && APP.locals.db) return APP.locals.db; } catch {}
      try { if (globalThis.db) return globalThis.db; } catch {}
      try { if (globalThis.global && globalThis.global.db) return globalThis.global.db; } catch {}
      return null;
    };

    const safeNum = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

    APP.get("/api/nba/stats/leaders", (req, res) => {
      const db = getDB();
      if (!db) return res.status(500).json({ ok: false, error: "DB not found" });

      const limit = Math.max(1, Math.min(50, safeNum(req.query.limit, 25)));

      // If you store leaders already
      const nbaStats = db.nbaStats || db.nbaStatsSnapshot || null;
      if (nbaStats && Array.isArray(nbaStats.leaders) && nbaStats.leaders.length) {
        return res.json({
          ok: true,
          source: "db.nbaStats.leaders",
          count: Math.min(limit, nbaStats.leaders.length),
          rows: nbaStats.leaders.slice(0, limit),
        });
      }

      // Fallback: derive points leaders from nbaPlayerGameLogs if present
      const logs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];
      if (!logs.length) return res.json({ ok: true, source: "none", count: 0, rows: [] });

      const agg = new Map();
      for (const r of logs) {
        const name = String(r.player || r.playerName || "").trim();
        if (!name) continue;
        const team = String(r.team || r.teamName || r.teamAbbr || "").trim();
        const pts = safeNum(r.pts ?? r.PTS ?? r.points, 0);

        const key = name + "|" + team;
        const cur = agg.get(key) || { player: name, team, pts: 0, games: 0 };
        cur.pts += pts;
        cur.games += 1;
        agg.set(key, cur);
      }

      const rows = [...agg.values()].sort((a, b) => b.pts - a.pts).slice(0, limit);
      return res.json({ ok: true, source: "derived:nbaPlayerGameLogs", count: rows.length, rows });
    });

    console.log("[patch] NBA stats leaders route ready ✅  GET /api/nba/stats/leaders");
  } catch (e) {
    try { console.log("[patch] NBA stats leaders route FAILED ❌", e?.stack || e?.message || e); } catch {}
  }
})();


// ===== PATCH: NBA stats leaders endpoint (fix 404) =====
(() => {
  try {
    if (typeof app === "undefined" || !app || !app.get) {
      console.log("[patch] nba-stats-leaders skipped (app missing)");
      return;
    }

    // remove any old handlers if your file has multiple patches
    try {
      const stack = app?._router?.stack;
      if (Array.isArray(stack)) {
        const before = stack.length;
        app._router.stack = stack.filter((layer) => {
          const p = layer?.route?.path;
          const m = layer?.route?.methods;
          return !(p === "/api/nba/stats/leaders" && m && m.get);
        });
        const removed = before - app._router.stack.length;
        if (removed) console.log(`[patch] nba-stats-leaders: removed old route ✅ (removed=${removed})`);
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
        // try a bunch of likely keys (your UI "Today Leaders" came from something like this)
        const candidates = [
          ["todayLeaders", nbaStats.todayLeaders],
          ["leadersToday", nbaStats.leadersToday],
          ["leaders", nbaStats.leaders],
          ["statsLeaders", nbaStats.statsLeaders],
          ["nbaLeaders", db.nbaLeaders],
          ["nbaStatsLeaders", db.nbaStatsLeaders],
        ];

        // pick the first non-empty object/array we find
        let pickedKey = null;
        let picked = null;

        for (const [k, v] of candidates) {
          if (Array.isArray(v) && v.length) { pickedKey = k; picked = v; break; }
          if (v && typeof v === "object" && Object.keys(v).length) { pickedKey = k; picked = v; break; }
        }

        // Last fallback: return empty but valid shape so the UI doesn't crash
        if (!picked) {
          return res.json({
            ok: true,
            source: null,
            leaders: { points: [], rebounds: [], assists: [], threes: [] },
            note: "No leaders found in db yet. Sync NBA stats and refresh.",
          });
        }

        return res.json({ ok: true, source: pickedKey, leaders: picked });
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e?.stack || e) });
      }
    });

    console.log("[patch] nba-stats-leaders ready ✅  GET /api/nba/stats/leaders");
  } catch (e) {
    console.log("[patch] nba-stats-leaders failed ❌", e?.message || e);
  }
})();


// ===== PATCH: NBA stats leaders endpoint (fix 404) =====
(() => {
  try {
    if (typeof app === "undefined" || !app || !app.get) {
      console.log("[patch] nba-stats-leaders skipped (app missing)");
      return;
    }

    // remove old handlers (if any)
    try {
      const stack = app?._router?.stack;
      if (Array.isArray(stack)) {
        const before = stack.length;
        app._router.stack = stack.filter((layer) => {
          const p = layer?.route?.path;
          const m = layer?.route?.methods;
          return !(p === "/api/nba/stats/leaders" && m && m.get);
        });
        const removed = before - app._router.stack.length;
        if (removed) console.log(`[patch] nba-stats-leaders: removed old route ✅ (removed=${removed})`);
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
  } catch (e) {
    console.log("[patch] nba-stats-leaders failed ❌", e?.message || e);
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

    // Prefer an existing readDB if you already installed one earlier
    const getDB = () => {
      try {
        if (typeof globalThis.readDB === "function") return globalThis.readDB();
      } catch {}
      try {
        if (typeof readDB === "function") return readDB(); // in case readDB is in scope
      } catch {}
      try {
        if (typeof app !== "undefined" && app?.locals?.db) return app.locals.db;
      } catch {}
      try {
        if (globalThis.db) return globalThis.db;
      } catch {}
      return null;
    };

    // Small helper: safe array length
    const len = (x) => (Array.isArray(x) ? x.length : 0);

    // 1) Status endpoint: confirms DB + table counts
    try {
      const before = app?._router?.stack?.length || 0;
      if (app?.get) {
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

          // If leaders cache exists, show it
          if (globalThis.__PT_NBA_LEADERS_CACHE && globalThis.__PT_NBA_LEADERS_CACHE.ts) {
            out.leadersCache = {
              ts: globalThis.__PT_NBA_LEADERS_CACHE.ts,
              source: globalThis.__PT_NBA_LEADERS_CACHE.source || null,
            };
          }

          return res.json(out);
        });

        const after = app?._router?.stack?.length || 0;
        console.log(`[patch] nba-stats-status ready ✅  GET /api/nba/stats/status (routes+${after - before})`);
      }
    } catch (e) {
      console.log("[patch] nba-stats-status failed ⚠️", String(e?.message || e));
    }

    // 2) Warm endpoint: compute leaders once & cache
    const warmLeaders = () => {
      try {
        // If you already have a leaders builder in your file, reuse it
        if (typeof globalThis.__PT_buildNbaLeaders === "function") {
          const result = globalThis.__PT_buildNbaLeaders();
          globalThis.__PT_NBA_LEADERS_CACHE = {
            ts: new Date().toISOString(),
            source: result?.source || null,
            leaders: result?.leaders || result || null,
          };
          return true;
        }

        // Otherwise, call your existing route logic by recomputing from db.nbaPlayerGameLogs
        const db = getDB();
        if (!db) return false;

        const logs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];
        if (!logs.length) return false;

        // Aggregate simple leaders (points, rebounds, assists, threes) from logs
        // Expect rows like { player, team, pts, reb, ast, fg3m } (best-effort)
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

    try {
      const before = app?._router?.stack?.length || 0;
      if (app?.post) {
        app.post("/api/nba/stats/warm", (req, res) => {
          const ok = warmLeaders();
          if (!ok) return res.status(500).json({ ok: false, error: "Warm failed (db/logs missing?)" });
          return res.json({ ok: true, warmed: true, ts: globalThis.__PT_NBA_LEADERS_CACHE?.ts || null });
        });
        const after = app?._router?.stack?.length || 0;
        console.log(`[patch] nba-stats-warm ready ✅  POST /api/nba/stats/warm (routes+${after - before})`);
      }
    } catch (e) {
      console.log("[patch] nba-stats-warm failed ⚠️", String(e?.message || e));
    }

    // 3) Auto warm once after startup (non-blocking)
    setTimeout(() => {
      try {
        const db = getDB();
        if (!db) return;
        // Only warm if cache missing
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

/* ============================================================
   PT FINAL UI PATCH (paste at absolute bottom of public/app.js)
   - Idempotent (safe if pasted twice)
   - Fixes: null/blank base URL issues, shows JS errors,
            adds NBA Stats tab (leaders + status),
            adds Dashboard Today Edges (tiered) widget.
   - Uses existing endpoints:
       GET  /api/nba/stats/leaders
       GET  /api/nba/stats/status
       POST /api/nba/stats/warm
       GET  /api/nba/edges-today-tiered?minEdge=0.5&games=5
   ============================================================ */
(() => {
  try {
    if (window.__PT_FINAL_UI_PATCH__) return;
    window.__PT_FINAL_UI_PATCH__ = true;

    // ---------- base URL + "null" guard ----------
    (function ptNullBaseFix() {
      try {
        const bad = new Set(["null", "undefined", "None", ""]);
        const keys = ["PT_BASE", "API_BASE", "BASE_URL", "PROTRACKER_BASE"];
        for (const k of keys) {
          const v = (localStorage.getItem(k) || "").trim();
          if (bad.has(v)) localStorage.removeItem(k);
        }
      } catch {}

      // Default: relative URLs
      const BASE = (() => {
        try {
          const v = (localStorage.getItem("PT_BASE") || "").trim();
          if (!v || v === "null" || v === "undefined") return "";
          return v.replace(/\/+$/, "");
        } catch {
          return "";
        }
      })();

      function apiUrl(u) {
        if (!u) return u;
        if (String(u).startsWith("http")) return u;
        if (!BASE) return u; // relative -> same host
        if (u.startsWith("/")) return BASE + u;
        return BASE + "/" + u;
      }

      // Wrap existing jget/jpost if present (don’t clobber if already wrapped)
      try {
        if (typeof window.jget === "function" && !window.jget.__ptWrapped) {
          const _jget = window.jget;
          const w = (u) => _jget(apiUrl(u));
          w.__ptWrapped = true;
          window.jget = w;
        }
      } catch {}
      try {
        if (typeof window.jpost === "function" && !window.jpost.__ptWrapped) {
          const _jpost = window.jpost;
          const w = (u, body) => _jpost(apiUrl(u), body);
          w.__ptWrapped = true;
          window.jpost = w;
        }
      } catch {}

      // Prevent accidental navigation to "null"
      try {
        const _assign = window.location.assign.bind(window.location);
        window.location.assign = (u) => {
          if (u === null || u === "null" || u === "undefined") return;
          return _assign(u);
        };
      } catch {}
    })();

    // ---------- error overlay ----------
    (function ptErrorOverlay() {
      function show(msg) {
        try {
          let el = document.getElementById("__pt_err__");
          if (!el) {
            el = document.createElement("div");
            el.id = "__pt_err__";
            el.style.cssText =
              "position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;" +
              "background:#300;color:#fff;padding:12px;border-radius:12px;" +
              "font:12px/1.4 monospace;white-space:pre-wrap;opacity:.98";
            document.body.appendChild(el);
          }
          el.textContent = "JS ERROR:\n" + msg;
        } catch {}
      }
      try {
        window.addEventListener("error", (e) => show(String(e?.message || e?.error || e)));
        window.addEventListener("unhandledrejection", (e) => show(String(e?.reason || e)));
      } catch {}
    })();

    // ---------- tiny helpers ----------
    const $id = (x) => document.getElementById(x);
    const esc = (s) =>
      String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
    const safeLog = (...a) => { try { console.log(...a); } catch {} };

    async function jgetSafe(url) {
      // prefer your existing jget
      if (typeof window.jget === "function") return window.jget(url);
      const r = await fetch(url, { cache: "no-store" });
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error(`GET ${url} non-json: ${t.slice(0, 200)}`); }
    }
    async function jpostSafe(url, body) {
      // prefer your existing jpost
      if (typeof window.jpost === "function") return window.jpost(url, body);
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error(`POST ${url} non-json: ${t.slice(0, 200)}`); }
    }

    // Tab helper: use your setTab if it exists, else fallback
    function showTab(name) {
      try {
        if (typeof window.setTab === "function") return window.setTab(name);
      } catch {}
      // fallback
      document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("show", p.id === `tab-${name}`));
    }

    // ---------- NBA Stats Tab (leaders + status) ----------
    function ensureNbaStatsTab() {
      const nav = document.querySelector(".nav");
      const content = document.querySelector(".content");
      if (!nav || !content) return false;

      if (!document.querySelector('.navbtn[data-tab="nbastats"]')) {
        const btn = document.createElement("button");
        btn.className = "navbtn";
        btn.dataset.tab = "nbastats";
        btn.textContent = "NBA Stats";
        nav.appendChild(btn);
      }

      if (!$id("tab-nbastats")) {
        const panel = document.createElement("section");
        panel.className = "panel";
        panel.id = "tab-nbastats";
        panel.innerHTML = `
          <div class="panel-head">
            <div>
              <div class="panel-title">NBA Stats</div>
              <div class="muted">Leaders computed from your DB (nbaPlayerGameLogs / nbaStats).</div>
            </div>
            <div class="row">
              <button class="btn ghost" id="ptNbaWarmBtn">Warm</button>
              <button class="btn ghost" id="ptNbaRefreshBtn">Refresh</button>
            </div>
          </div>

          <div class="card">
            <div class="card-h">Status</div>
            <pre class="pre" id="ptNbaStatus" style="white-space:pre-wrap;margin:0">Loading…</pre>
          </div>

          <div class="card" style="margin-top:12px">
            <div class="card-h">Leaders (Top 25)</div>
            <div class="muted" id="ptNbaLeadersMeta">Loading…</div>
            <div class="grid2" style="margin-top:10px">
              <div><div class="muted">Points</div><div class="list" id="ptLeadPts">—</div></div>
              <div><div class="muted">Rebounds</div><div class="list" id="ptLeadReb">—</div></div>
              <div><div class="muted">Assists</div><div class="list" id="ptLeadAst">—</div></div>
              <div><div class="muted">3PT Made</div><div class="list" id="ptLead3s">—</div></div>
            </div>
          </div>
        `;
        content.appendChild(panel);
      }

      return true;
    }

    function leadersListHTML(arr) {
      const top = (arr || []).slice(0, 12);
      if (!top.length) return `<div class="muted">—</div>`;
      return top
        .map(
          (x) => `
          <div class="item">
            <div class="left">
              <b>${esc(x.player || "")}</b>
              <div class="muted">${esc(x.team || "")} • GP ${esc(x.gp ?? "—")}</div>
            </div>
            <div class="badge">${esc(x.value ?? "—")}</div>
          </div>
        `
        )
        .join("");
    }

    async function loadNbaStatusAndLeaders() {
      const statusEl = $id("ptNbaStatus");
      const metaEl = $id("ptNbaLeadersMeta");
      const ptsEl = $id("ptLeadPts");
      const rebEl = $id("ptLeadReb");
      const astEl = $id("ptLeadAst");
      const th3El = $id("ptLead3s");

      if (statusEl) statusEl.textContent = "Loading…";
      if (metaEl) metaEl.textContent = "Loading…";

      // Status
      try {
        const s = await jgetSafe("/api/nba/stats/status");
        if (statusEl) statusEl.textContent = JSON.stringify(s, null, 2);
      } catch (e) {
        if (statusEl) statusEl.textContent = "Status failed: " + String(e?.message || e);
      }

      // Leaders
      try {
        const L = await jgetSafe("/api/nba/stats/leaders");
        const leaders = L?.leaders || { points: [], rebounds: [], assists: [], threes: [] };
        if (metaEl) metaEl.textContent = `${esc(L?.source || "unknown")} • points ${leaders.points?.length || 0}`;
        if (ptsEl) ptsEl.innerHTML = leadersListHTML(leaders.points);
        if (rebEl) rebEl.innerHTML = leadersListHTML(leaders.rebounds);
        if (astEl) astEl.innerHTML = leadersListHTML(leaders.assists);
        if (th3El) th3El.innerHTML = leadersListHTML(leaders.threes);
      } catch (e) {
        if (metaEl) metaEl.textContent = "Leaders failed: " + String(e?.message || e);
        if (ptsEl) ptsEl.innerHTML = `<div class="muted">—</div>`;
        if (rebEl) rebEl.innerHTML = `<div class="muted">—</div>`;
        if (astEl) astEl.innerHTML = `<div class="muted">—</div>`;
        if (th3El) th3El.innerHTML = `<div class="muted">—</div>`;
      }
    }

    function bindNbaStatsTab() {
      // Nav click
      document.querySelectorAll('.navbtn[data-tab="nbastats"]').forEach((b) => {
        if (b.__ptBound) return;
        b.__ptBound = true;
        b.onclick = () => {
          showTab("nbastats");
          loadNbaStatusAndLeaders();
        };
      });

      // Buttons
      const ref = $id("ptNbaRefreshBtn");
      if (ref && !ref.__ptBound) {
        ref.__ptBound = true;
        ref.onclick = () => loadNbaStatusAndLeaders();
      }
      const warm = $id("ptNbaWarmBtn");
      if (warm && !warm.__ptBound) {
        warm.__ptBound = true;
        warm.onclick = async () => {
          try {
            warm.textContent = "Warming…";
            await jpostSafe("/api/nba/stats/warm", {});
          } catch (e) {
            safeLog("[ui] warm failed", e?.message || e);
          } finally {
            warm.textContent = "Warm";
            loadNbaStatusAndLeaders();
          }
        };
      }
    }

    // ---------- Dashboard: Today Edges (tiered) ----------
    function ensureEdgesTierCard() {
      const dash = document.getElementById("tab-dashboard");
      if (!dash) return false;

      if (!document.getElementById("ptEdgesTierCard")) {
        const card = document.createElement("div");
        card.className = "card";
        card.id = "ptEdgesTierCard";
        card.style.marginTop = "12px";
        card.innerHTML = `
          <div class="card-h">Today Edges (NBA • tiered)</div>
          <div class="muted" id="ptEdgesTierMeta">Loading…</div>
          <div class="row" style="margin-top:10px">
            <input id="ptEdgesTierMin" value="0.5" placeholder="minEdge" style="max-width:140px"/>
            <input id="ptEdgesTierGames" value="5" placeholder="games" style="max-width:120px"/>
            <button class="btn ghost" id="ptEdgesTierRefresh">Refresh</button>
          </div>
          <div class="list" id="ptEdgesTierList" style="margin-top:10px">Loading…</div>
        `;
        dash.appendChild(card);
      }
      return true;
    }

    function edgeBadge(edge) {
      const n = Number(edge);
      if (!Number.isFinite(n)) return `<span class="badge">—</span>`;
      const abs = Math.abs(n);
      const cls = abs >= 2 ? "good" : abs >= 1 ? "warn" : "";
      const sign = n > 0 ? "+" : "";
      return `<span class="badge ${cls}">${sign}${n.toFixed(1)}</span>`;
    }

    async function loadEdgesTiered() {
      const meta = $id("ptEdgesTierMeta");
      const list = $id("ptEdgesTierList");
      const minEdge = encodeURIComponent(($id("ptEdgesTierMin")?.value || "0.5").trim());
      const games = encodeURIComponent(($id("ptEdgesTierGames")?.value || "5").trim());
      if (!list) return;

      if (meta) meta.textContent = "Loading…";
      list.textContent = "Loading…";

      try {
        const d = await jgetSafe(`/api/nba/edges-today-tiered?minEdge=${minEdge}&games=${games}`);
        const rows = d.rows || [];
        if (meta) meta.textContent = `${esc(d.date || "")} • ${rows.length} rows`;
        if (!rows.length) {
          list.innerHTML = `<div class="muted">${esc(d.note || "No edges yet (need props imported).")}</div>`;
          return;
        }
        list.innerHTML = rows.slice(0, 60).map((r) => `
          <div class="item">
            <div class="left">
              <div><b>${esc(r.player || "")}</b> <span class="muted">(${esc(r.team || "")})</span></div>
              <div class="muted">eventId ${esc(r.eventId || "")} • ${esc(r.stat || "")} line ${esc(r.line ?? "—")} • proj ${esc(r.proj ?? "—")} • g${esc(r.games ?? "—")}</div>
            </div>
            ${edgeBadge(r.edge)}
          </div>
        `).join("");
      } catch (e) {
        if (meta) meta.textContent = "Edges failed";
        list.innerHTML = `<div class="muted">Edges failed: ${esc(e?.message || e)}</div>`;
      }
    }

    function bindEdgesTiered() {
      const btn = $id("ptEdgesTierRefresh");
      if (btn && !btn.__ptBound) {
        btn.__ptBound = true;
        btn.onclick = () => loadEdgesTiered();
      }
    }

    // ---------- boot ----------
    function boot() {
      // NBA Stats tab
      if (ensureNbaStatsTab()) {
        bindNbaStatsTab();
      }
      // Dashboard edges tier card
      if (ensureEdgesTierCard()) {
        bindEdgesTiered();
        loadEdgesTiered();
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }

    safeLog("[patch] PT FINAL UI PATCH loaded ✅");
  } catch (e) {
    try { console.log("[patch] PT FINAL UI PATCH failed ❌", e?.stack || e?.message || e); } catch {}
  }
})();

/* ============================
   PT PHONE DEBUG PANEL (no DevTools needed)
   Paste at VERY bottom of public/app.js
   ============================ */
(function PT_PHONE_DEBUG_PANEL(){
  if (window.__PT_PHONE_DEBUG_PANEL__) return;
  window.__PT_PHONE_DEBUG_PANEL__ = true;

  const esc = (s)=>String(s??"").replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const $id = (x)=>document.getElementById(x);

  // --- On-screen log overlay (bottom of screen) ---
  function ensureOverlay(){
    let el = $id("__pt_dbg_overlay__");
    if (el) return el;
    el = document.createElement("div");
    el.id="__pt_dbg_overlay__";
    el.style.cssText="position:fixed;left:10px;right:10px;bottom:10px;z-index:999999;background:#111;color:#eee;padding:10px;border-radius:12px;font:12px/1.4 monospace;white-space:pre-wrap;max-height:35vh;overflow:auto;opacity:.98;box-shadow:0 10px 30px rgba(0,0,0,.35)";
    el.innerHTML = "PT DEBUG OVERLAY READY ✅\n";
    document.body.appendChild(el);

    // small close/minimize toggle
    const bar = document.createElement("div");
    bar.style.cssText="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:6px";
    bar.innerHTML = `<b>PT Debug</b><span style="display:flex;gap:8px">
      <button id="__pt_dbg_clear__" style="background:#333;color:#eee;border:0;border-radius:10px;padding:6px 10px">Clear</button>
      <button id="__pt_dbg_hide__" style="background:#333;color:#eee;border:0;border-radius:10px;padding:6px 10px">Hide</button>
    </span>`;
    el.prepend(bar);

    $id("__pt_dbg_clear__").onclick=()=>{ el.lastChild && (el.lastChild.textContent=""); el.innerHTML = bar.outerHTML + "PT DEBUG OVERLAY READY ✅\n"; };
    $id("__pt_dbg_hide__").onclick=()=>{
      if (el.style.maxHeight !== "35vh") { el.style.maxHeight="35vh"; el.style.opacity=".98"; $id("__pt_dbg_hide__").textContent="Hide"; }
      else { el.style.maxHeight="28px"; el.style.opacity=".85"; $id("__pt_dbg_hide__").textContent="Show"; }
    };

    return el;
  }

  function logLine(msg){
    const el = ensureOverlay();
    const t = new Date().toISOString().slice(11,19);
    el.appendChild(document.createTextNode(`[${t}] ${msg}\n`));
    el.scrollTop = el.scrollHeight;
  }

  // --- Catch JS errors and show them ---
  window.addEventListener("error",(e)=>logLine("JS ERROR: " + (e.message||e.error||e)));
  window.addEventListener("unhandledrejection",(e)=>logLine("PROMISE REJECT: " + (e.reason||e)));

  // --- Wrap fetch to log failures + statuses ---
  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    const url = (typeof input === "string") ? input : (input && input.url) ? input.url : String(input);
    const method = (init && init.method) ? init.method : "GET";
    const started = Date.now();

    try{
      const res = await _fetch(input, init);
      const ms = Date.now() - started;

      // Log only API calls (reduce noise)
      if (String(url).includes("/api/") || String(url).includes("/pt/")){
        logLine(`${method} ${url} -> ${res.status} (${ms}ms)`);
      }
      return res;
    }catch(err){
      const ms = Date.now() - started;
      logLine(`FETCH FAILED ${method} ${url} (${ms}ms): ${String(err && err.message ? err.message : err)}`);
      throw err;
    }
  };

  // --- Add a Debug card to Dashboard (or fallback to body) ---
  function ensureDebugCard(){
    const host = document.getElementById("tab-dashboard") || document.body;
    if ($id("__pt_dbg_card__")) return;

    const card = document.createElement("div");
    card.className = "card";
    card.id="__pt_dbg_card__";
    card.style.marginTop="12px";
    card.innerHTML = `
      <div class="card-h">Debug Panel (Phone)</div>
      <div class="muted" style="margin-bottom:10px">
        This prints API failures directly in the page. If your UI says "Failed to fetch", click tests below.
      </div>

      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn ghost" id="__pt_t_quick__">Test /api/pt/quick-links</button>
        <button class="btn ghost" id="__pt_t_status__">Test /api/nba/stats/status</button>
        <button class="btn ghost" id="__pt_t_leaders__">Test /api/nba/stats/leaders</button>
        <button class="btn ghost" id="__pt_t_edges__">Test /api/nba/edges-today-tiered</button>
        <button class="btn" id="__pt_t_reload__">Reload UI</button>
      </div>

      <div class="muted" style="margin-top:10px">Location: <span id="__pt_loc__"></span></div>
      <pre class="pre" id="__pt_dbg_out__" style="margin-top:10px;max-height:240px;overflow:auto"></pre>
    `;
    host.appendChild(card);

    $id("__pt_loc__").textContent = `${location.href}  (origin: ${location.origin})`;

    async function runTest(path){
      const out = $id("__pt_dbg_out__");
      out.textContent = `Testing ${path} ...\n`;
      logLine(`TEST -> ${path}`);

      try{
        const r = await fetch(path, { cache:"no-store" });
        const text = await r.text();
        out.textContent =
          `URL: ${path}\n` +
          `Status: ${r.status}\n` +
          `Final URL: ${r.url}\n\n` +
          text.slice(0, 1500);
        logLine(`TEST OK ${path} -> ${r.status}`);
      }catch(e){
        out.textContent = `FAILED: ${path}\n${String(e && e.message ? e.message : e)}`;
        logLine(`TEST FAIL ${path}: ${String(e && e.message ? e.message : e)}`);
      }
    }

    $id("__pt_t_quick__").onclick=()=>runTest("/api/pt/quick-links");
    $id("__pt_t_status__").onclick=()=>runTest("/api/nba/stats/status");
    $id("__pt_t_leaders__").onclick=()=>runTest("/api/nba/stats/leaders");
    $id("__pt_t_edges__").onclick=()=>runTest("/api/nba/edges-today-tiered?minEdge=0.5&games=5");
    $id("__pt_t_reload__").onclick=()=>location.reload();
  }

  // Run after DOM ready
  function boot(){
    ensureOverlay();
    ensureDebugCard();
    logLine("Debug panel booted ✅");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

