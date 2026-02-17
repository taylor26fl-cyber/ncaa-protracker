import BetForm from "@/components/BetForm";
import { readDB } from "@/lib/db";
import { fmtLine, fmtMoney, fmtOdds } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function BetsPage() {
  const db = await readDB();
  const teamById = new Map(db.teams.map(t => [t.id, t]));
  const gameById = new Map(db.games.map(g => [g.id, g]));

  const rows = db.bets
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(b => {
      const g = gameById.get(b.gameId)!;
      const home = teamById.get(g.homeTeamId)!;
      const away = teamById.get(g.awayTeamId)!;
      return { b, g, home, away };
    });

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div>
        <h1 className="h1">Bets</h1>
        <p className="p">Track picks, settle results, and auto-calc profit from odds.</p>
      </div>

      <BetForm onCreated={() => { /* @ts-ignore */ globalThis.location?.reload?.(); }} />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Game</th><th>Type</th><th>Line</th><th>Odds</th><th>Stake</th><th>Result</th><th>P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, g, home, away }) => (
              <tr key={b.id}>
                <td>
                  <div style={{ fontWeight: 700 }}>{away.shortName} @ {home.shortName}</div>
                  <div className="small">{new Date(g.startTime).toLocaleString()}</div>
                </td>
                <td>{b.betType} • {b.side}</td>
                <td>{fmtLine(b.line)}</td>
                <td>{fmtOdds(b.price)}</td>
                <td>{b.stake}</td>
                <td>
                  <select
                    className="select"
                    defaultValue={b.result}
                    onChange={async (e) => {
                      await fetch(`/api/bets/${b.id}`, {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ result: e.target.value })
                      });
                      // @ts-ignore
                      globalThis.location?.reload?.();
                    }}
                  >
                    {["PENDING","WIN","LOSS","PUSH"].map(x => <option key={x} value={x}>{x}</option>)}
                  </select>
                </td>
                <td style={{ fontWeight: 700 }}>{fmtMoney(b.payout)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7} className="small">No bets yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
