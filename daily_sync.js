const { syncEspnDate } = require("./sync_espn_date");
const { syncEspnNbaDate } = require("./sync_espn_nba_date");

function yyyymmddLocal(d=new Date()){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  return `${y}${m}${day}`;
}

async function runDailySync({ season=2026, daysAhead=1 } = {}){
  // Sync today + next N days (default: today + tomorrow)
  const out = { ok:true, season, ranAt: new Date().toISOString(), days: [] };

  for(let i=0;i<=daysAhead;i++){
    const d = new Date();
    d.setDate(d.getDate()+i);
    const date = yyyymmddLocal(d);

    const ncaab = await syncEspnDate({ season, date }).catch(e => ({ ok:false, league:"NCAAB", date, error:String(e?.message||e) }));
    const nba   = await syncEspnNbaDate({ season, date }).catch(e => ({ ok:false, league:"NBA",   date, error:String(e?.message||e) }));

    out.days.push({ date, ncaab, nba });
  }
  return out;
}

module.exports = { runDailySync, yyyymmddLocal };
