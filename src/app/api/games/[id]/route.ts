export const runtime = "nodejs";
import { readDB, writeDB } from "@/lib/db";
import { PatchGameSchema } from "@/lib/validators";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const json = await req.json().catch(() => null);
  if (!json) return new Response("Invalid JSON", { status: 400 });

  const parsed = PatchGameSchema.safeParse(json);
  if (!parsed.success) return new Response(parsed.error.message, { status: 400 });

  const db = await readDB();
  const idx = db.games.findIndex(g => g.id === params.id);
  if (idx === -1) return new Response("Not found", { status: 404 });

  db.games[idx] = { ...db.games[idx], ...parsed.data };
  await writeDB(db);

  return Response.json(db.games[idx]);
}
