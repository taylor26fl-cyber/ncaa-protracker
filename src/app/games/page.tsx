import GamesClient from "@/components/GamesClient";
export const dynamic = "force-dynamic";
export default function GamesPage() {
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div>
        <h1 className="h1">Games</h1>
        <p className="p">Hard Rock lines + movement, your spread/total/ML projections, and edge/value.</p>
      </div>
      <GamesClient />
    </div>
  );
}
