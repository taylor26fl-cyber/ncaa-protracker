"use client";
import { useEffect, useState } from "react";

type GameOpt = { id: string; label: string };

export default function BetForm({ onCreated }: { onCreated: () => void }) {
  const [games, setGames] = useState<GameOpt[]>([]);
  const [gameId, setGameId] = useState("");
  const [betType, setBetType] = useState<"SPREAD"|"TOTAL"|"MONEYLINE">("SPREAD");
  const [side, setSide] = useState<"HOME"|"AWAY"|"OVER"|"UNDER">("HOME");
  const [line, setLine] = useState("-3.5");
  const [price, setPrice] = useState("-110");
  const [stake, setStake] = useState("1");
  const [note, setNote] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/games", { cache: "no-store" });
      const data = await res.json();
      const opts = data.map((g: any) => ({
        id: g.id,
        label: `${g.awayTeam.shortName} @ ${g.homeTeam.shortName} — ${new Date(g.startTime).toLocaleString()}`
      }));
      setGames(opts);
      setGameId(opts[0]?.id ?? "");
    })();
  }, []);

  const sides = betType === "TOTAL" ? (["OVER","UNDER"] as const) : (["HOME","AWAY"] as const);
  const showLine = betType !== "MONEYLINE";

  async function submit() {
    const res = await fetch("/api/bets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId,
        betType,
        side,
        line: showLine ? Number(line) : null,
        price: price.trim() ? Number(price) : null,
        stake: Number(stake),
        note: note.trim() ? note.trim() : undefined
      })
    });
    if (!res.ok) { alert(await res.text()); return; }
    setNote("");
    onCreated();
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 700 }}>Create bet</div>

      <div className="grid2" style={{ marginTop: 10 }}>
        <div>
          <div className="label">Game</div>
          <select className="select" value={gameId} onChange={e => setGameId(e.target.value)}>
            {games.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </div>

        <div>
          <div className="label">Type</div>
          <select className="select" value={betType} onChange={e => {
            const t = e.target.value as any;
            setBetType(t);
            setSide(t === "TOTAL" ? "OVER" : "HOME");
          }}>
            <option value="SPREAD">SPREAD</option>
            <option value="TOTAL">TOTAL</option>
            <option value="MONEYLINE">MONEYLINE</option>
          </select>
        </div>

        <div>
          <div className="label">Side</div>
          <select className="select" value={side} onChange={e => setSide(e.target.value as any)}>
            {sides.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <div className="label">Line</div>
          <input className="input" disabled={!showLine} value={showLine ? line : ""} onChange={e => setLine(e.target.value)} />
        </div>

        <div>
          <div className="label">Odds</div>
          <input className="input" value={price} onChange={e => setPrice(e.target.value)} />
        </div>

        <div>
          <div className="label">Stake</div>
          <input className="input" value={stake} onChange={e => setStake(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="label">Note</div>
        <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional..." />
      </div>

      <button className="btn btnPrimary" style={{ marginTop: 12 }} onClick={submit}>Add bet</button>
    </div>
  );
}
