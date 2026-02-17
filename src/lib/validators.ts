import { z } from "zod";

export const PatchGameSchema = z.object({
  projSpreadHome: z.number().nullable().optional(),
  projTotal: z.number().nullable().optional(),
  projWinProbHome: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(["SCHEDULED", "LIVE", "FINAL"]).optional(),
  finalHome: z.number().int().nullable().optional(),
  finalAway: z.number().int().nullable().optional()
});

export const CreateBetSchema = z.object({
  gameId: z.string().min(1),
  betType: z.enum(["SPREAD", "TOTAL", "MONEYLINE"]),
  side: z.enum(["HOME", "AWAY", "OVER", "UNDER"]),
  line: z.number().nullable().optional(),
  price: z.number().int().nullable().optional(),
  stake: z.number().positive(),
  note: z.string().max(500).optional()
});

export const PatchBetSchema = z.object({
  result: z.enum(["PENDING", "WIN", "LOSS", "PUSH"]).optional(),
  payout: z.number().nullable().optional(),
  note: z.string().max(500).optional()
});
