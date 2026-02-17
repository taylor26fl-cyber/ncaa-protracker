export const runtime = "nodejs";
import { readDB, writeDB, cuidish } from "@/lib/db";

function authed(req: Request) {
  const token = req.headers.get("x-sync-token");
  return !!process.env.SYNC_TOKEN && token === process.env.SYNC_TOKEN;
}

function jitter() {
  const r = Math.random();
  return r < 0.33 ? -0.5 : r < 0.66 ? 0 : 0.5;
}

export async function POST(req: Request) {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const season = Number(body.season ?? 2026);

  const db = await readDB();
  const now = new Date().toISOString();

  const seasonGames = db.games.filter(g => g.season === season);

  for (const g of seasonGames) {
    const last = db.lines
      .filter(l => l.gameId === g.id && l.sportsbook === "HARDROCK")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    const j = jitter();

    db.lines.push({
      id: cuidish("l"),
      gameId: g.id,
      sportsbook: "HARDROCK",
      createdAt: now,
      spreadHome: (last?.spreadHome ?? -3.5) + j,
      total: (last?.total ?? 149.5) + j,
      mlHome: last?.mlHome ?? -160,
      mlAway: last?.mlAway ?? 135
    });
  }

  await writeDB(db);
  return Response.json({ ok: true, season, snapshotsCreated: seasonGames.length });
}
