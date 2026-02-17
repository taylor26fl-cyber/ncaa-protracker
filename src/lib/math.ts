export function profitFromAmericanOdds(odds: number, stake: number) {
  if (odds === 0) return 0;
  if (odds > 0) return (odds / 100) * stake;
  return (100 / Math.abs(odds)) * stake;
}
export function impliedProbFromAmericanOdds(odds: number) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}
export function americanOddsFromProb(p: number) {
  const pp = Math.min(0.999, Math.max(0.001, p));
  if (pp >= 0.5) return Math.round(-(pp / (1 - pp)) * 100);
  return Math.round(((1 - pp) / pp) * 100);
}
export function edgeSpread(proj?: number | null, market?: number | null) {
  if (proj == null || market == null) return null;
  return proj - market;
}
export function edgeTotal(proj?: number | null, market?: number | null) {
  if (proj == null || market == null) return null;
  return proj - market;
}
export function edgeMlValue(projProbHome?: number | null, marketMlHome?: number | null) {
  if (projProbHome == null || marketMlHome == null) return null;
  const marketP = impliedProbFromAmericanOdds(marketMlHome);
  return projProbHome - marketP;
}
export function roi(totalProfit: number, totalStaked: number) {
  if (totalStaked <= 0) return 0;
  return totalProfit / totalStaked;
}
export function bucketEdge(absEdge: number) {
  if (absEdge >= 6) return "STRONG (6+)";
  if (absEdge >= 3) return "MEDIUM (3–5.5)";
  return "SMALL (<3)";
}
