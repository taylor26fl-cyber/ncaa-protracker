export function fmtOdds(n?: number | null) {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}
export function fmtLine(n?: number | null) {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}`;
}
export function fmtMoney(n?: number | null) {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}
export function dtLocal(iso: string) {
  return new Date(iso).toLocaleString();
}
