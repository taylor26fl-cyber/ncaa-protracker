export const runtime = "nodejs";
import { readDB } from "@/lib/db";

export async function GET() {
  const db = await readDB();

  const teamById = new Map(db.teams.map(t => [t.id, t]));
  const linesByGame = new Map<string, any[]>();

  for (const l of db.lines) {
    if (l.sportsbook !== "HARDROCK") continue;
    const arr = linesByGame.get(l.gameId) ?? [];
    arr.push(l);
    linesByGame.set(l.gameId, arr);
  }
  for (const [gid, arr] of linesByGame.entries()) {
    arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    linesByGame.set(gid, arr);
  }

  const rows = db.games
    .slice()
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .map(g => {
      const home = teamById.get(g.homeTeamId)!;
      const away = teamById.get(g.awayTeamId)!;
      const arr = linesByGame.get(g.id) ?? [];
      return {
        id: g.id,
        season: g.season,
        status: g.status,
        startTime: g.startTime,
        homeTeam: home,
        awayTeam: away,
        projSpreadHome: g.projSpreadHome ?? null,
        projTotal: g.projTotal ?? null,
        projWinProbHome: g.projWinProbHome ?? null,
        latestLine: arr[0] ?? null,
        prevLine: arr[1] ?? null
      };
    });

  return Response.json(rows);
}
