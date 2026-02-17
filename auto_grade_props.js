const { fetchEspnNbaSummary, extractPlayerLines } = require("./espn_nba_players");

// ESPN NCAAB summary uses a different endpoint than NBA
async function fetchEspnNcaabSummary(eventId){
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${encodeURIComponent(eventId)}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error(`ESPN NCAAB summary error ${resp.status}`);
  return resp.json();
}

function extractNcaabPlayerLines(summary){
  // ESPN NCAAB summary has the same boxscore.players shape most of the time
  const out = [];
  const players = summary?.boxscore?.players || [];
  for(const teamBlock of players){
    const teamName = teamBlock?.team?.displayName || teamBlock?.team?.name || "Team";
    const statsBlocks = teamBlock?.statistics || [];
    for(const cat of statsBlocks){
      const labels = cat?.labels || [];
      const athletes = cat?.athletes || [];
      for(const a of athletes){
        const name = a?.athlete?.displayName || a?.athlete?.fullName || "Player";
        const pos = a?.athlete?.position?.abbreviation || "";
        const starter = !!a?.starter;
        const stats = a?.stats || [];
        const line = {};
        for(let i=0;i<labels.length;i++){
          line[labels[i]] = stats[i] ?? null;
        }
        out.push({ team: teamName, player: name, pos, starter, statType: cat?.name || "", line });
      }
    }
  }
  return out;
}

function isFinal(summary){
  // Works for most ESPN summary payloads
  const comp = summary?.header?.competitions?.[0];
  const st = comp?.status?.type;
  return !!(st?.completed || st?.name === "STATUS_FINAL" || st?.state === "post");
}

function toNum(v){
  if(v==null) return null;
  if(typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if(!s) return null;
  // handle "12-18" etc -> not numeric, return null
  if(s.includes("-")) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function gradeOne(prop, players, final){
  // Find matching player by exact name
  const rec = players.find(p => p.player === prop.player);
  if(!rec) return null;

  const actual = toNum(rec.line?.[prop.stat]);
  if(actual == null) return null;

  const line = Number(prop.line);
  prop.actual = actual;

  if(prop.type === "OVER") prop.result = actual > line ? "WIN" : "LOSS";
  else if(prop.type === "UNDER") prop.result = actual < line ? "WIN" : "LOSS";
  else prop.result = "PENDING";

  return prop;
}

async function gradePendingProps({ db, writeDB, leagueOfEventId }){
  if(!db.playerProps || !db.playerProps.length) return { ok:true, graded:0, checkedEvents:0 };

  // group pending props by eventId
  const pending = db.playerProps.filter(p => p.result === "PENDING" && p.gameEventId);
  const byEvent = new Map();
  for(const p of pending){
    const eid = String(p.gameEventId);
    if(!byEvent.has(eid)) byEvent.set(eid, []);
    byEvent.get(eid).push(p);
  }

  let graded = 0;
  let checkedEvents = 0;

  for(const [eventId, props] of byEvent.entries()){
    const league = leagueOfEventId(eventId); // "NBA" | "NCAAB" | "UNKNOWN"

    let summary;
    try{
      if(league === "NBA"){
        summary = await fetchEspnNbaSummary(eventId);
      } else {
        summary = await fetchEspnNcaabSummary(eventId);
      }
    } catch(e){
      continue;
    }

    checkedEvents++;
    const final = isFinal(summary);

    const players = (league === "NBA")
      ? extractPlayerLines(summary)
      : extractNcaabPlayerLines(summary);

    for(const p of props){
      const before = p.result;
      const out = gradeOne(p, players, final);
      if(out && before === "PENDING" && out.result !== "PENDING") graded++;
    }
  }

  writeDB(db);
  return { ok:true, graded, checkedEvents };
}

module.exports = { gradePendingProps };
