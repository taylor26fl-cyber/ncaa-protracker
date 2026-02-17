import Link from "next/link";
import { readDB } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { roi } from "@/lib/math";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="small">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {sub ? <div className="small" style={{ marginTop: 6 }}>{sub}</div> : null}
    </div>
  );
}

export default async function Home() {
  const db = await readDB();
  const totalStaked = db.bets.reduce((s, b) => s + (b.stake ?? 0), 0);
  const totalProfit = db.bets.reduce((s, b) => s + (b.payout ?? 0), 0);
  const settled = db.bets.filter(b => b.result !== "PENDING");
  const wins = settled.filter(b => b.result === "WIN").length;
  const losses = settled.filter(b => b.result === "LOSS").length;
  const r = roi(totalProfit, totalStaked);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div>
        <h1 className="h1">Dashboard</h1>
        <p className="p">Track Hard Rock lines, your spread/ML projections, edges, and results.</p>
      </div>

      <div className="grid4">
        <Stat label="Total Profit" value={fmtMoney(totalProfit)} sub="Sum of bet payouts (profit)" />
        <Stat label="Total Staked" value={fmtMoney(totalStaked)} sub="All bets (incl pending)" />
        <Stat label="ROI" value={`${(r * 100).toFixed(1)}%`} sub="Profit / Staked" />
        <Stat label="Record" value={`${wins}-${losses}`} sub="Settled bets only" />
      </div>

      <div className="card">
        <div style={{ fontWeight: 700 }}>Start here</div>
        <div className="small" style={{ marginTop: 8 }}>
          Go to <Link href="/games" style={{ textDecoration: "underline" }}>Games</Link> to edit projections and see edges.
          Then log picks in <Link href="/bets" style={{ textDecoration: "underline" }}>Bets</Link>.
        </div>
      </div>
    </div>
  );
}
