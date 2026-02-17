const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");

function readDB(){ return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); }
function writeDB(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2),"utf8"); }

function ymdUTC(d){
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth()+1).padStart(2,"0");
  const da = String(dt.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchJson(url){
  const r = await fetch(url, { headers: { "user-agent":"protracker/1.0" } });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`HTTP ${r.status} ${url} :: ${t.slice(0,160)}`);
  }
  return r.json();
}

/**
 * ESPN summary endpoints (stable enough, but ESPN can change formats)
 */
function summaryUrl(league, eventId){
  if(league === "NBA"){
    return `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`;
  }
  // NCAAB men's
  return `https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${encodeURIComponent(eventId)}`;
}

/**
 * ESPN athlete gamelog endpoints.
 * If one fails, we try a fallback shape.
 */
async function fetchGameLog(league, athleteId){
  if(!athleteId) return null;

  // NBA
  if(league === "NBA"){
    const urls = [
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athleteId}/gamelog`,
      `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/athletes/${athleteId}/gamelog`
    ];
    for(const u of urls){
      try { return await fetchJson(u); } catch(e) {}
    }
    return null;
  }

  // NCAAB
  const urls = [
    `https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/athletes/${athleteId}/gamelog`,
    `https://site.web.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/athletes/${athleteId}/gamelog`
  ];
  for(const u of urls){
    try { return await fetchJson(u); } catch(e) {}
  }
  return null;
}

function extractRosterFromSummary(summaryJson){
  // We try a few common ESPN summary structures.
  // Goal: get athlete id + displayName + team name
  const out = [];

  // Typical: boxscore.players[].statistics[].athletes[]
  const box = summaryJson?.boxscore?.players || [];
  for(const teamBlock of box){
    const teamName = teamBlock?.team?.displayName || teamBlock?.team?.name || "";
    const statsGroups = teamBlock?.statistics || [];
    for(const g of statsGroups){
      const athletes = g?.athletes || [];
      for(const a of athletes){
        const id = a?.athlete?.id || a?.athlete?.uid || null;
        const name = a?.athlete?.displayName || a?.athlete?.fullName || a?.athlete?.shortName || "";
        if(!name) continue;
        out.push({ athleteId: String(id||""), name, team: teamName });
      }
    }
  }

  // De-dupe by athleteId or name+team if id missing
  const seen = new Set();
  const dedup = [];
  for(const p of out){
    const k = p.athleteId ? `id:${p.athleteId}` : `nt:${p.name}|${p.team}`;
    if(seen.has(k)) continue;
    seen.add(k);
    dedup.push(p);
  }
  return dedup;
}

/**
 * Very simple projection from game log:
 * - Use last 10 games if possible
 * - Weighted avg: last5 weight 2, last10 weight 1
 * - Stats: PTS, REB, AST, 3PM (3PT made), BLK, STL
 */
function buildProjectionFromGamelog(glog){
  if(!glog) return null;

  // ESPN shapes vary. We hunt for events list.
  const events =
    glog?.events ||
    glog?.response?.[0]?.events ||
    glog?.gamelogs?.[0]?.events ||
    [];

  const rows = [];
  for(const ev of events){
    // Try to get stats
    const stats = ev?.stats || ev?.statistics || ev?.statLines || null;
    if(!stats) continue;

    // stats can be array of strings or object
    // We'll attempt to interpret common keys
    const o = {};
    if(Array.isArray(stats)){
      // Sometimes it's strings like "PTS: 22"
      for(const s of stats){
        const m = String(s).match(/^([A-Z0-9+/-]+)\s*[:=]\s*([0-9.]+)/);
        if(m) o[m[1]] = Number(m[2]);
      }
    } else {
      for(const [k,v] of Object.entries(stats)){
        const n = Number(v);
        if(!Number.isNaN(n)) o[k.toUpperCase()] = n;
      }
    }

    const pts = o.PTS ?? o.POINTS ?? null;
    const reb = o.REB ?? o.REBOUNDS ?? null;
    const ast = o.AST ?? o.ASSISTS ?? null;
    const stl = o.STL ?? o.STEALS ?? null;
    const blk = o.BLK ?? o.BLOCKS ?? null;

    // 3PM is messy; ESPN sometimes uses "3PT" or "3PM" or "3FGM"
    const threes = o["3PM"] ?? o["3PTM"] ?? o["3FGM"] ?? o["3PT"] ?? null;

    if([pts,reb,ast,stl,blk,threes].every(v=>v==null)) continue;
    rows.push({ pts, reb, ast, stl, blk, threes });
  }

  if(rows.length === 0) return null;

  const last10 = rows.slice(0,10);
  const last5 = rows.slice(0,5);

  function avg(arr, key){
    const vals = arr.map(r=>r[key]).filter(v=>typeof v==="number");
    if(vals.length===0) return null;
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  }

  function weighted(key){
    const a10 = avg(last10,key);
    const a5 = avg(last5,key);
    if(a10==null && a5==null) return null;
    if(a10==null) return a5;
    if(a5==null) return a10;
    return (a10 + 2*a5)/3;
  }

  return {
    sample: rows.length,
    pts: weighted("pts"),
    reb: weighted("reb"),
    ast: weighted("ast"),
    stl: weighted("stl"),
    blk: weighted("blk"),
    threes: weighted("threes"),
  };
}

async function loadTodayPlayersAndHistory({ dateISO, leagues=["NBA","NCAAB"], maxGames=50 }){
  const db = readDB();
  db.playerIndex ||= {};     // athleteId -> { name, team, league, updatedAt }
  db.rosters ||= {};         // eventId -> { league, startTime, label, players:[...] , updatedAt }
  db.playerHistory ||= {};   // athleteId -> { projection, updatedAt }

  const today = dateISO || ymdUTC(new Date());
  const games = (db.games||[])
    .filter(g=>{
      const lg = g.league || "NCAAB";
      if(!leagues.includes(lg)) return false;
      if(!g.extId) return false; // eventId required
      return ymdUTC(g.startTime) === today;
    })
    .sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
    .slice(0, maxGames);

  let rosterCount=0, playerCount=0, historyCount=0;

  for(const g of games){
    const league = g.league || "NCAAB";
    const eventId = String(g.extId);
    const url = summaryUrl(league, eventId);

    let summary;
    try{
      summary = await fetchJson(url);
    }catch(e){
      continue;
    }

    const players = extractRosterFromSummary(summary);
    if(players.length){
      // store roster
      db.rosters[eventId] = {
        league,
        startTime: g.startTime,
        label: `${g.awayTeamId} @ ${g.homeTeamId}`,
        updatedAt: new Date().toISOString(),
        players
      };
      rosterCount += 1;
      playerCount += players.length;

      // update playerIndex
      for(const p of players){
        if(!p.athleteId) continue;
        db.playerIndex[p.athleteId] = {
          athleteId: p.athleteId,
          name: p.name,
          team: p.team,
          league,
          updatedAt: new Date().toISOString()
        };
      }

      // now fetch history/projection (throttled)
      for(const p of players){
        if(!p.athleteId) continue;
        // skip if recently updated within 6 hours
        const prev = db.playerHistory[p.athleteId];
        if(prev?.updatedAt){
          const age = Date.now() - new Date(prev.updatedAt).getTime();
          if(age < 6*60*60*1000) continue;
        }

        let glog = null;
        try{ glog = await fetchGameLog(league, p.athleteId); }catch(e){}
        const proj = buildProjectionFromGamelog(glog);
        if(proj){
          db.playerHistory[p.athleteId] = {
            athleteId: p.athleteId,
            league,
            projection: proj,
            updatedAt: new Date().toISOString()
          };
          historyCount += 1;
        }
        await sleep(250); // avoid hammering ESPN
      }
    }

    await sleep(250);
  }

  writeDB(db);
  return { ok:true, date: today, games: games.length, rostersUpdated: rosterCount, playersLoaded: playerCount, historiesUpdated: historyCount };
}

module.exports = { loadTodayPlayersAndHistory, ymdUTC };
