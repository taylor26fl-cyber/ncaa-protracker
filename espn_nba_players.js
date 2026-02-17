async function fetchEspnNbaSummary(eventId){
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`;
  const resp = await fetch(url);
  if(!resp.ok) throw new Error(`ESPN summary error ${resp.status}`);
  return resp.json();
}

function extractPlayerLines(summary){
  // ESPN summary schema: boxscore.players[] teams -> statistics -> athletes
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

module.exports = { fetchEspnNbaSummary, extractPlayerLines };
