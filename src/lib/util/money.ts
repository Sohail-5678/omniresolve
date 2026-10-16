/**
 * Money is integer cents everywhere (ground rule 5). These helpers format cents for
 * people and parse money mentions in text back to cents for the grounding verifier.
 */

export function assertCents(value: number): number {
  if (!Number.isInteger(value)) throw new Error(`Money must be integer cents, got ${value}`);
  return value;
}

/** 32000 -> "$320.00" */
export function formatCents(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rem}`;
}

/**
 * Finds money mentions in free text and returns them as cents.
 * Handles "$320", "$320.00", "$1,250.50", "320.00 USD", "320 dollars", "32000 cents".
 */
export function extractMoneyCents(text: string): { raw: string; cents: number }[] {
  const out: { raw: string; cents: number }[] = [];
  const dollarRe = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
  const suffixRe = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|usd|dollars?)\b/g;
  const centsRe = /\b(\d{1,3}(?:,\d{3})+|\d+)\s?cents?\b/g;
  const toCents = (whole: string, frac: string | undefined) =>
    Number(whole.replace(/,/g, "")) * 100 + (frac ? Number(frac.padEnd(2, "0")) : 0);
  for (const m of text.matchAll(dollarRe)) out.push({ raw: m[0], cents: toCents(m[1], m[2]) });
  for (const m of text.matchAll(suffixRe)) out.push({ raw: m[0], cents: toCents(m[1], m[2]) });
  for (const m of text.matchAll(centsRe)) out.push({ raw: m[0], cents: Number(m[1].replace(/,/g, "")) });
  return out;
}
