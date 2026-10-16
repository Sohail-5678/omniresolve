/**
 * Parses the policy clause markdown files (data/policies/clauses/v*.md) into structured
 * clauses. Used by scripts (build-index, validate-policies) and tests; the running app
 * reads the prebuilt data/index/corpus.json instead of touching the filesystem.
 */
import type { PolicyId } from "./rules";

export type Clause = {
  key: string; // "§1.4@2026.1" — unique across versions
  clauseId: string; // "§1.4"
  title: string;
  policyId: PolicyId;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  category: string; // family title, e.g. "Returns"
  binds: string[];
  text: string;
};

const FAMILY_TITLES: Record<string, string> = {
  RETURNS_STANDARD: "Returns",
  BILLING_DISPUTES: "Billing disputes",
  SHIPPING_DELAYS: "Late and lost deliveries",
  DAMAGE_TRANSIT: "Damage in transit",
  GOODWILL_RETENTION: "Goodwill and retention",
  APPROVAL_AUTHORITY: "Approval authority and security",
};

export function parseClauseFile(markdown: string): Clause[] {
  const fm = /^---\n([\s\S]*?)\n---/m.exec(markdown);
  if (!fm) throw new Error("Clause file is missing front matter");
  const meta: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const version = meta.version;
  const effectiveFrom = meta.effectiveFrom;
  const effectiveTo = meta.effectiveTo === "null" ? null : meta.effectiveTo;
  if (!version || !effectiveFrom) throw new Error("Front matter needs version and effectiveFrom");

  const body = markdown.slice(fm[0].length);
  const sections = body.split(/^## /m).slice(1);
  return sections.map((section) => {
    const lines = section.split("\n");
    const heading = lines[0].trim();
    const hm = /^(§\d+\.\d+)\s+(.+)$/.exec(heading);
    if (!hm) throw new Error(`Bad clause heading: "${heading}" in ${version}`);
    const policyLine = lines.find((l) => l.startsWith("policy:"));
    const bindsLine = lines.find((l) => l.startsWith("binds:"));
    if (!policyLine || !bindsLine) throw new Error(`Clause ${hm[1]} in ${version} needs policy and binds lines`);
    const policyId = policyLine.slice("policy:".length).trim() as PolicyId;
    const bindsRaw = bindsLine.slice("binds:".length).trim();
    const binds = bindsRaw === "-" || bindsRaw === "" ? [] : bindsRaw.split(",").map((s) => s.trim());
    const bindsIdx = lines.indexOf(bindsLine);
    const text = lines
      .slice(bindsIdx + 1)
      .join("\n")
      .trim()
      .replace(/\s+/g, " ");
    return {
      key: `${hm[1]}@${version}`,
      clauseId: hm[1],
      title: hm[2].trim(),
      policyId,
      version,
      effectiveFrom,
      effectiveTo,
      category: FAMILY_TITLES[policyId] ?? policyId,
      binds,
      text,
    };
  });
}

export function citationLabel(c: Pick<Clause, "clauseId" | "title" | "version">): string {
  return `${c.clauseId} ${c.title} — v${c.version}`;
}
