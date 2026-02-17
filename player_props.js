const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");

function readDB(){ return JSON.parse(fs.readFileSync(DB_PATH,"utf8")); }
function writeDB(db){ fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2),"utf8"); }
function id(prefix){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`; }

// ensure props array exists
function ensure(db){
  if(!db.playerProps) db.playerProps = [];
}

function gradeProp(prop, players){
  if(!players) return prop;
  const p = players.find(x => x.player === prop.player);
  if(!p) return prop;

  const val = Number(p.line[prop.stat]);
  if(!Number.isFinite(val)) return prop;

  prop.actual = val;

  if(prop.type === "OVER") prop.result = val > prop.line ? "WIN" : "LOSS";
  if(prop.type === "UNDER") prop.result = val < prop.line ? "WIN" : "LOSS";

  return prop;
}

module.exports = { readDB, writeDB, ensure, id, gradeProp };
