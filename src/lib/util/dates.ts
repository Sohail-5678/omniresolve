/**
 * Date helpers on ISO calendar dates ("2026-10-16"), computed in UTC so day counts
 * never shift with the server's timezone or daylight saving.
 */

const DAY_MS = 86_400_000;

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Whole days from a to b (b - a). Positive when b is later. */
export function daysBetween(aIso: string, bIso: string): number {
  return Math.round((parseIsoDate(bIso).getTime() - parseIsoDate(aIso).getTime()) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(parseIsoDate(iso).getTime() + days * DAY_MS));
}

/** effectiveFrom <= date <= effectiveTo (inclusive); effectiveTo null = open-ended. */
export function inEffect(dateIso: string, from: string, to: string | null): boolean {
  if (dateIso < from) return false;
  if (to !== null && dateIso > to) return false;
  return true;
}

export function formatLongDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatShortDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
