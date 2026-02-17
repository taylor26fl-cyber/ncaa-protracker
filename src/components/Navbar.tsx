import Link from "next/link";

export default function Navbar() {
  return (
    <div className="nav">
      <div className="navInner">
        <Link href="/" style={{ fontWeight: 700 }}>NCAA ProTracker</Link>
        <div className="navLinks">
          <Link href="/games">Games</Link>
          <Link href="/bets">Bets</Link>
        </div>
      </div>
    </div>
  );
}
