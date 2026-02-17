export const runtime = "nodejs";
import { readDB, writeDB, cuidish } from "@/lib/db";
import { CreateBetSchema } from "@/lib/validators";

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  if (!json) return new Response("Invalid JSON", { status: 400 });

  const parsed = CreateBetSchema.safeParse(json);
  if (!parsed.success) return new Response(parsed.error.message, { status: 400 });

  const db = await readDB();

  const bet = {
    id: cuidish("b"),
    createdAt: new Date().toISOString(),
    gameId: parsed.data.gameId,
    betType: parsed.data.betType,
    side: parsed.data.side,
    line: parsed.data.line ?? null,
    price: parsed.data.price ?? null,
    stake: parsed.data.stake,
    result: "PENDING",
    payout: null,
    note: parsed.data.note ?? null
  };

  db.bets.push(bet);
  await writeDB(db);

  return Response.json(bet, { status: 201 });
}
