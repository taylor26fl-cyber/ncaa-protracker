export const runtime = "nodejs";
import { readDB, writeDB } from "@/lib/db";
import { PatchBetSchema } from "@/lib/validators";
import { profitFromAmericanOdds } from "@/lib/math";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const json = await req.json().catch(() => null);
  if (!json) return new Response("Invalid JSON", { status: 400 });

  const parsed = PatchBetSchema.safeParse(json);
  if (!parsed.success) return new Response(parsed.error.message, { status: 400 });

  const db = await readDB();
  const idx = db.bets.findIndex(b => b.id === params.id);
  if (idx === -1) return new Response("Not found", { status: 404 });

  const existing = db.bets[idx];

  let payout = parsed.data.payout ?? existing.payout ?? null;
  if (parsed.data.result && parsed.data.payout === undefined) {
    const stake = existing.stake ?? 1;
    const odds = existing.price ?? -110;
    if (parsed.data.result === "WIN") payout = profitFromAmericanOdds(odds, stake);
    else if (parsed.data.result === "LOSS") payout = -stake;
    else if (parsed.data.result === "PUSH") payout = 0;
    else payout = null;
  }

  db.bets[idx] = { ...existing, ...parsed.data, payout };
  await writeDB(db);

  return Response.json(db.bets[idx]);
}
