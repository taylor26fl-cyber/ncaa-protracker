require("dotenv").config();

const BASE = "https://v1.basketball.api-sports.io";
const KEY = process.env.APISPORTS_KEY;

if (!KEY) {
  console.error("Missing APISPORTS_KEY in .env");
  process.exit(1);
}

async function apiGet(pathname, params) {
  const u = new URL(BASE + pathname);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  });
  const resp = await fetch(u, { headers: { "x-apisports-key": KEY } });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`API-SPORTS error ${resp.status}: ${txt}`);
  return JSON.parse(txt);
}

function walk(obj, path = "") {
  const out = [];
  if (obj && typeof obj === "object") {
    // candidate: any object that has id + name
    const hasId = Object.prototype.hasOwnProperty.call(obj, "id");
    const hasName = Object.prototype.hasOwnProperty.call(obj, "name");
    if (hasId && hasName) {
      const name = String(obj.name || "");
      const id = obj.id;
      if (/ncaa/i.test(name)) {
        out.push({ path, id, name });
      }
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) out.push(...walk(obj[i], `${path}[${i}]`));
    } else {
      for (const k of Object.keys(obj)) out.push(...walk(obj[k], path ? `${path}.${k}` : k));
    }
  }
  return out;
}

(async () => {
  const json = await apiGet("/leagues", {});
  console.log("Top-level keys:", Object.keys(json));

  const hits = walk(json).filter(x => x.id != null && x.name);
  if (!hits.length) {
    console.log("No NCAA hits found anywhere in the /leagues response.");
    console.log("Here is response[0] so we can see the real schema:");
    const r0 = (json.response && json.response[0]) ? json.response[0] : null;
    console.log(r0);
    process.exit(0);
  }

  // remove duplicates by (id,name)
  const seen = new Set();
  const uniq = [];
  for (const h of hits) {
    const key = `${h.id}||${h.name}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(h); }
  }

  console.log("Found NCAA-like entries (id  name  path):");
  for (const h of uniq) {
    console.log(`${h.id}\t${h.name}\t${h.path}`);
  }
})().catch(e => {
  console.error(String(e.message || e));
  process.exit(1);
});
