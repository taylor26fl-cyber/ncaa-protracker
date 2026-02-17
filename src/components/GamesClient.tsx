"use client";

import { useEffect, useMemo, useState } from "react";
import { dtLocal, fmtLine, fmtOdds } from "@/lib/format";
import { americanOddsFromProb, bucketEdge, edgeMlValue, edgeSpread, edgeTotal } from "@/lib/math";

type Team = { id: string; name: string; shortName: string };
type Line = { createdAt: string; spreadHome: number | null; total: number | null; mlHome: number | null; mlAway: number | null; };
type GameRow = {
  id: string; season: number; status: "SCHEDULED"|"LIVE"|"FINAL"; startTime: string;
  homeTeam: Team; awayTeam: Team;
  projSpreadHome: number | null; projTotal: number | null; projWinProbHome: number | null;
  latestLine: Line | null; prevLine: Line | null;
};

function moveStr(curr?: number | null, prev?: number | null) {
  if (curr == null || prev == null) return "—";
  const diff = curr - prev;
  if (diff === 0) return "0.0";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}`;
}

export default function GamesClient() {
  const [games, setGames] = useState<GameRow[]>([]);
  const [q, setQ] = useState("");
  const [bucket, setBucket] = useState<"ALL"|"STRONG"|"MEDIUM"|"SMALL">("ALL");

  async function load() {
    const res = await fetch("/api/games", { cache: "no-store" });
    setGames(await res.json());
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return games.filter(g => {
      const matchQ =
        !qq ||
        g.homeTeam.shortName.toLowerCase().includes(qq) ||
        g.awayTeam.shortName.toLowerCase().includes(qq) ||
        g.homeTeam.name.toLowerCase().includes(qq) ||
        g.awayTeam.name.toLowerCase().includes(qq);

      const eS = edgeSpread(g.projSpreadHome, g.latestLine?.spreadHome ?? null);
      const abs = eS == null ? 0 : Math.abs(eS);
      const b = bucketEdge(abs);

      const matchBucket =
        bucket === "ALL" ? true :
        bucket === "STRONG" ? b.startsWith("STRONG") :
        bucket === "MEDIUM" ? b.startsWith("MEDIUM") :
        b.startsWith("SMALL");

      return matchQ && matchBucket;
    });
  }, [games, q, bucket]);

  async function saveProj(gameId: string, patch: { projSpreadHome: number | null; projTotal: number | null; projWinProbHome: number | null }) {
    const res = await fetch(`/api/games/${gameId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) alert(await res.text());
    await load();
  }

  async function doSync() {
    const token = prompt("Enter SYNC_TOKEN from .env") ?? "";
    const res = await fetch("/api/sync/hardrock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sync-token": token },
      body: JSON.stringify({ season: 2026 })
    });
    if (!res.ok) alert(await res.text());
    await load();
  }

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="label">Search</div>
            <input className="input" placeholder="DUKE, UNC, Kansas..." value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["ALL","STRONG","MEDIUM","SMALL"] as const).map(b => (
              <button key={b} className="btn" style={bucket===b ? { background:"#111827", color:"#fff", borderColor:"#111827" } : undefined} onClick={() => setBucket(b)}>
                {b}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={load}>Refresh</button>
            <button className="btn btnPrimary" onClick={doSync}>Sync Hard Rock</button>
          </div>
        </div>
        <div className="small" style={{ marginTop: 8 }}>
          Buckets based on spread edge: <b>(your spread) − (Hard Rock spread)</b>.
        </div>
      </div>

      {filtered.map(g => {
        const spread = g.latestLine?.spreadHome ?? null;
        const total = g.latestLine?.total ?? null;
        const mlHome = g.latestLine?.mlHome ?? null;

        const eS = edgeSpread(g.projSpreadHome, spread);
        const eT = edgeTotal(g.projTotal, total);
        const eML = edgeMlValue(g.projWinProbHome, mlHome);

        const abs = eS == null ? 0 : Math.abs(eS);
        const bucketLabel = bucketEdge(abs);

        const fairHome = g.projWinProbHome == null ? null : americanOddsFromProb(g.projWinProbHome);

        return (
          <div key={g.id} className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div>
                <div className="small">
                  {dtLocal(g.startTime)} • {g.status} • <span className="chip">{bucketLabel}</span>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
                  {g.awayTeam.shortName} @ {g.homeTeam.shortName}
                </div>
              </div>
              <div className="small" style={{ textAlign: "right" }}>
                <div>Line time</div>
                <div style={{ fontWeight: 600 }}>
                  {g.latestLine ? new Date(g.latestLine.createdAt).toLocaleString() : "—"}
                </div>
              </div>
            </div>

            <div className="grid4" style={{ marginTop: 12 }}>
              <div className="card">
                <div className="label">Hard Rock Spread (Home)</div>
                <div style={{ fontWeight: 700 }}>{fmtLine(spread)}</div>
                <div className="small">Move: {moveStr(spread, g.prevLine?.spreadHome ?? null)}</div>
              </div>
              <div className="card">
                <div className="label">Hard Rock Total</div>
                <div style={{ fontWeight: 700 }}>{fmtLine(total)}</div>
                <div className="small">Move: {moveStr(total, g.prevLine?.total ?? null)}</div>
              </div>
              <div className="card">
                <div className="label">Hard Rock ML (H/A)</div>
                <div style={{ fontWeight: 700 }}>{fmtOdds(g.latestLine?.mlHome ?? null)} / {fmtOdds(g.latestLine?.mlAway ?? null)}</div>
              </div>
              <div className="card">
                <div className="label">Edges (Spread / Total / ML)</div>
                <div style={{ fontWeight: 700 }}>
                  {eS == null ? "—" : `${eS.toFixed(1)} pts`} / {eT == null ? "—" : `${eT.toFixed(1)} pts`} / {eML == null ? "—" : `${(eML*100).toFixed(1)}%`}
                </div>
                <div className="small">ML edge = (your win%) − (market implied%).</div>
              </div>
            </div>

            <div className="grid2" style={{ marginTop: 12 }}>
              <div className="card">
                <div style={{ fontWeight: 700 }}>Your Projections</div>

                <div className="grid2" style={{ marginTop: 10 }}>
                  <div>
                    <div className="label">Proj spread (home)</div>
                    <input className="input" defaultValue={g.projSpreadHome ?? ""} onBlur={(e) => {
                      const v = e.target.value.trim();
                      saveProj(g.id, { projSpreadHome: v ? Number(v) : null, projTotal: g.projTotal, projWinProbHome: g.projWinProbHome });
                    }} placeholder="-4.0" />
                  </div>
                  <div>
                    <div className="label">Proj total</div>
                    <input className="input" defaultValue={g.projTotal ?? ""} onBlur={(e) => {
                      const v = e.target.value.trim();
                      saveProj(g.id, { projSpreadHome: g.projSpreadHome, projTotal: v ? Number(v) : null, projWinProbHome: g.projWinProbHome });
                    }} placeholder="148.5" />
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div className="label">Proj home win probability (0–1)</div>
                  <input className="input" defaultValue={g.projWinProbHome ?? ""} onBlur={(e) => {
                    const v = e.target.value.trim();
                    saveProj(g.id, { projSpreadHome: g.projSpreadHome, projTotal: g.projTotal, projWinProbHome: v ? Number(v) : null });
                  }} placeholder="0.62" />
                  <div className="small" style={{ marginTop: 8 }}>
                    Fair ML (home): <b>{fairHome == null ? "—" : (fairHome > 0 ? `+${fairHome}` : `${fairHome}`)}</b>
                  </div>
                </div>

                <div className="small" style={{ marginTop: 8 }}>
                  Tip: enter win% as decimals (ex 0.58 = 58%).
                </div>
              </div>

              <div className="card">
                <div style={{ fontWeight: 700 }}>Quick interpretation</div>
                <div className="small" style={{ marginTop: 8 }}>
                  • Spread edge negative = HOME lean (you favor home more than market).<br/>
                  • Total edge negative = UNDER lean (you project lower total).<br/>
                  • ML edge positive = value on HOME ML (your win% > implied).
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {filtered.length === 0 ? <div className="small">No games match.</div> : null}
    </div>
  );
}
