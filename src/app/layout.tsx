import "./globals.css";
import Navbar from "@/components/Navbar";

export const metadata = {
  title: "NCAA ProTracker",
  description: "Track NCAA games, Hard Rock lines, projections, and bets."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
