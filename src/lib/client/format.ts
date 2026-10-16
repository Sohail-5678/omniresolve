/** Display helpers for the console (money is integer cents; never floats). */

export function cents(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return n < 1 ? `${n.toFixed(2)} ms` : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function humanize(code: string): string {
  return code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function hoursLeft(iso: string | null | undefined): string {
  if (!iso) return "";
  const h = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
  return `${h}h left`;
}
