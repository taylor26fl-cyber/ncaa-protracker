const KEY = process.env.APISPORTS_KEY;
if (!KEY) {
  console.error("Missing APISPORTS_KEY. Set it in .env first.");
  process.exit(1);
}
require("dotenv").config();

const BASE = "https://v1.basketball.api-sports.io";

async function apiGet(pathname, params) {
  const u = new URL(BASE + pathname);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  });
  const resp = await fetch(u, { headers: { "x-apisports-key": process.env.APISPORTS_KEY } });
  if (!resp.ok) throw new Error(`API-SPORTS error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

(async () => {
  const json = await apiGet("/leagues", {});
  const arr = json.response || [];
  const matches = arr
    .map(x => ({
      id: x?.league?.id,
      name: x?.league?.name || "",
      type: x?.league?.type || "",
      country: x?.country?.name || x?.country?.code || ""
    }))
    .filter(x => x.id && /ncaa/i.test(x.name))
    .sort((a, b) => (a.country > b.country ? 1 : -1));

  if (!matches.length) {
    console.log("No leagues matched 'NCAA'. Showing a few sample leagues so we know the schema:");
    console.log(arr.slice(0, 5).map(x => ({
      league: x?.league, country: x?.country
    })));
    return;
  }

  console.log("NCAA leagues found (pick the Men's NCAA one):");
  for (const m of matches) {
    console.log(`${m.id}\t${m.country}\t${m.type}\t${m.name}`);
  }
})().catch(e => {
  console.error(String(e.message || e));
  process.exit(1);
});
