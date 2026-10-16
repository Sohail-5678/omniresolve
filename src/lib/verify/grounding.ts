/**
 * Grounded-reply verifier (spec 7.10). Extracts every money amount, ID, tracking number,
 * clause ID, date and day count from a reply and checks each against VerifiedFacts, and
 * blocks promises about actions whose status isn't DONE ("refunded" when the refund
 * rolled back). The claim this supports: no unverified amount or ID reaches the customer
 * because the verifier blocks it — not that the model never hallucinates.
 */
import type { VerifiedFacts, FactAction } from "@/lib/agent/state";
import { extractMoneyCents, formatCents } from "@/lib/util/money";

const ID_PATTERN = /\b(?:ORD|TCK|RF|SC|LBL|RPL|HLD|NTE|NTF|OBX|SAG|CH|SHP|CUS)-[0-9A-Z][0-9A-Z-]*\b|\b(?:CA|CB)\d{10}\b/g;
const CLAUSE_PATTERN = /(?:§\s?|\bsection\s+)(\d+\.\d+)/gi;
const DAYS_PATTERN = /\b(\d{1,4})[-\s](?:business\s+|calendar\s+)?days?\b/gi;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_PATTERN = new RegExp(
  `\\b(${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b|\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`,
  "gi",
);

const PROMISES: { type: FactAction["type"]; pattern: RegExp; label: string }[] = [
  {
    type: "refund",
    label: "says a refund happened",
    pattern: /\b(refunded|have refunded|has been refunded|refund\b(?:[^.!?\n]|\.(?=\d)){0,40}?\b(?:has been|was|is now|is) (?:issued|processed|completed|complete|sent|approved|done|on its way)|refund of \$[\d.,]+ (?:issued|processed|sent|completed)|refund (?:went|has gone) through|(?:issued|processed|sent) (?:you )?(?:a|your|the) refund)\b/i,
  },
  {
    type: "replacement",
    label: "says a replacement was sent",
    pattern: /\b(replacement\b(?:[^.!?\n]|\.(?=\d)){0,40}?\b(?:has been|is|was) (?:shipped|sent|confirmed|placed|created|on (?:its|the) way)|replacement (?:confirmed|shipped|sent)|(?:shipped|sent|confirmed|placed) (?:you )?(?:a|your|the) replacement)\b/i,
  },
  {
    type: "return_label",
    label: "says a return label was created",
    pattern: /\b((?:return |prepaid )?label (?:has been|is|was) (?:sent|created|emailed|attached|generated)|(?:prepaid |return )+label (?:created|generated|sent|emailed)|(?:sent|emailed|created|attached|generated) (?:you )?(?:a|your|the) (?:prepaid )?(?:return )?label)\b/i,
  },
  {
    type: "store_credit",
    label: "says store credit was issued",
    pattern: /\b((?:store )?credit\b(?:[^.!?\n]|\.(?=\d)){0,30}?\b(?:has been|is|was) (?:added|issued|applied)|store credit of \$[\d.,]+ (?:added|issued|applied)|(?:added|issued|applied) (?:a |your |the )?(?:\$[\d.,]+ )?(?:in )?store credit)\b/i,
  },
];

/** Offers of a remedy that does not exist in the facts at all ("we can offer you store credit"). */
const OFFERS: { type: FactAction["type"]; pattern: RegExp; label: string }[] = [
  { type: "store_credit", label: "offers store credit", pattern: /\b(offer|provide|give|issue|add|apply)\w*\b[^.!?\n]{0,40}\bstore credit\b|\bstore credit\b[^.!?\n]{0,30}\b(available|offered|for you)\b/i },
  { type: "replacement", label: "offers a replacement", pattern: /\b(offer|send|ship|provide|arrange)\w*\b[^.!?\n]{0,30}\breplacement\b/i },
  { type: "return_label", label: "offers a return label", pattern: /\b(send|email|provide|create|generate)\w*\b[^.!?\n]{0,30}\b(prepaid |return )?label\b/i },
  { type: "refund", label: "offers a refund", pattern: /\b(offer|issue|process|provide)\w*\b[^.!?\n]{0,30}\brefund\b/i },
];

export type AllowList = {
  amounts: Set<number>;
  ids: Set<string>;
  clauseIds: Set<string>;
  dates: Set<string>;
  dayCounts: Set<number>;
};

export function allowListFromFacts(f: VerifiedFacts): AllowList {
  const amounts = new Set<number>();
  const ids = new Set<string>();
  const dates = new Set<string>();
  const dayCounts = new Set<number>();
  for (const o of f.orders) {
    ids.add(o.orderId);
    if (o.orderDate) dates.add(o.orderDate);
    if (o.deliveredDate) dates.add(o.deliveredDate);
  }
  for (const a of f.actions) {
    if (a.amountCents) amounts.add(a.amountCents);
    if (a.id) ids.add(a.id);
    if (a.trackingNo) ids.add(a.trackingNo);
    if (a.orderId) ids.add(a.orderId);
  }
  if (f.ticket) ids.add(f.ticket.ticketId);
  for (const p of f.policyNumbers) {
    for (const m of extractMoneyCents(p)) amounts.add(m.cents);
    for (const m of p.matchAll(DAYS_PATTERN)) dayCounts.add(Number(m[1]));
  }
  return { amounts, ids, clauseIds: new Set(f.clauses.map((c) => c.id)), dates, dayCounts };
}

/**
 * "Nothing was charged, refunded or changed" is not a claim that a refund happened, but in
 * "Since it was not working, we have refunded you" the negation belongs to another clause.
 * The scope is the comma segment right before the claim; when the claim is a bare list item
 * (nothing but "and"/"or" since the comma), the negation is looked for one segment further back.
 */
function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 60), index).toLowerCase();
  const sentence = before.split(/[.!?;\n]/).pop() ?? "";
  const segments = sentence.split(",");
  let scope = segments.pop() ?? "";
  while (/^\s*(?:and|or)?\s*$/.test(scope) && segments.length) scope = `${segments.pop()},${scope}`;
  return /\b(no|not|nothing|never|nor|without|neither|isn't|wasn't|weren't|hasn't|haven't|won't|cannot|can't|couldn't)\b/.test(scope);
}

function monthDay(iso: string): string {
  return iso.slice(5, 10);
}

export function verifyReply(text: string, facts: VerifiedFacts): { ok: boolean; problems: string[] } {
  const allow = allowListFromFacts(facts);
  const problems: string[] = [];

  for (const m of extractMoneyCents(text)) {
    if (!allow.amounts.has(m.cents)) problems.push(`amount "${m.raw}" is not in the facts`);
  }
  for (const m of text.matchAll(ID_PATTERN)) {
    if (!allow.ids.has(m[0])) problems.push(`ID "${m[0]}" is not in the facts`);
  }
  for (const m of text.matchAll(CLAUSE_PATTERN)) {
    const id = `§${m[1]}`;
    if (!allow.clauseIds.has(id)) problems.push(`policy clause "${id}" is not in the facts`);
  }
  for (const m of text.matchAll(DAYS_PATTERN)) {
    const n = Number(m[1]);
    if (!allow.dayCounts.has(n)) problems.push(`"${m[0]}" is not a number from the facts`);
  }
  const allowedMonthDays = new Set([...allow.dates].map(monthDay));
  for (const m of text.matchAll(DATE_PATTERN)) {
    let md: string | null = null;
    const year = m[4] ?? m[3];
    if (m[4]) md = `${m[5]}-${m[6]}`;
    else if (m[1]) {
      const name = m[1].toLowerCase().slice(0, 3);
      const idx = MONTHS.findIndex((x) => x.startsWith(name));
      if (idx >= 0) md = `${String(idx + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
    }
    // A bare "September 25" is checked by month and day; a stated year must match too.
    const ok = md && (year ? allow.dates.has(`${year}-${md}`) : allowedMonthDays.has(md));
    if (md && !ok) problems.push(`date "${m[0]}" is not in the facts`);
  }
  for (const p of PROMISES) {
    const global = new RegExp(p.pattern.source, "gi");
    const claims = [...text.matchAll(global)].filter((m) => !negated(text, m.index ?? 0));
    if (!claims.length) continue;
    const done = facts.actions.some((a) => a.type === p.type && a.status === "DONE");
    if (!done) problems.push(`reply ${p.label}, but no ${p.type.replace("_", " ")} has status DONE`);
  }
  for (const o of OFFERS) {
    const global = new RegExp(o.pattern.source, "gi");
    const offers = [...text.matchAll(global)].filter((m) => !negated(text, m.index ?? 0));
    if (!offers.length) continue;
    const present = facts.actions.some((a) => a.type === o.type && (a.status === "DONE" || a.status === "PENDING"));
    if (!present) problems.push(`reply ${o.label}, but the facts contain no such approved action`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** Safe fallback reply built only from facts (used after a failed regeneration). */
export function templateReply(f: VerifiedFacts): string {
  const lines: string[] = [`Hi ${f.customerFirstName},`];
  const order = f.orders[0]?.orderId;
  const intro: Record<string, string> = {
    RESOLVED: `here is what we've done${order ? ` for order ${order}` : ""}:`,
    PENDING_FULFILLMENT: `here is where things stand${order ? ` on order ${order}` : ""}:`,
    ROLLED_BACK: `we tried to complete your resolution${order ? ` for order ${order}` : ""}, but one of our systems failed partway through, so we reversed every step. Nothing was charged, refunded or changed.`,
    COMPENSATION_FAILED: `we hit a system problem while processing your request${order ? ` for order ${order}` : ""}. A specialist has been alerted to finish it by hand.`,
    DENIED: `thanks for your patience while we checked your request${order ? ` about order ${order}` : ""}.`,
    REJECTED: `a supervisor reviewed your request${order ? ` about order ${order}` : ""} and it needs a specialist's attention before anything changes.`,
    ESCALATED: `I've passed your request to a specialist who can take it from here.`,
    DELAYED: `we're having trouble reaching our order systems right now, so I can't look this up safely.`,
    NEEDS_INFO: `I need one more detail to help.`,
    UNAVAILABLE: `I can't process this request automatically right now.`,
    BLOCKED: `I can't help with that request here.`,
  };
  lines.push(intro[f.outcome] ?? "here is an update on your request:");
  for (const a of f.actions) {
    const s = describeFactAction(a);
    if (s) lines.push(`- ${s}`);
  }
  if (f.clauses.length) lines.push(`Policy applied: ${f.clauses.map((c) => `${c.id} (v${c.version}) ${c.title}`).join("; ")}.`);
  if (f.ticket) lines.push(`Your ticket is ${f.ticket.ticketId}.`);
  if (f.nextStep) lines.push(f.nextStep);
  return lines.join("\n");
}

function describeFactAction(a: FactAction): string | null {
  const amt = a.amountCents ? formatCents(a.amountCents) : "";
  const why = a.why ? ` (${a.why})` : "";
  switch (a.type) {
    case "refund":
      if (a.status === "DONE") return `Refund of ${amt} issued${a.id ? ` (${a.id})` : ""}${a.orderId ? ` on ${a.orderId}` : ""}.`;
      if (a.status === "DENIED") return `We couldn't approve a refund of ${amt}${why}.`;
      if (a.status === "PENDING") return `A refund of ${amt} is in progress.`;
      return `No refund was made.`;
    case "replacement":
      if (a.status === "DONE") return `Replacement confirmed${a.id ? ` (${a.id})` : ""}${a.item ? ` for your ${a.item}` : ""}.`;
      if (a.status === "PENDING") return `Your replacement${a.item ? ` (${a.item})` : ""} is being finalised by our operations team.`;
      if (a.status === "DENIED") return `We couldn't send a replacement${why}.`;
      return `No replacement was created.`;
    case "return_label":
      if (a.status === "DONE") return `Prepaid return label created${a.trackingNo ? `, tracking ${a.trackingNo}` : ""}.`;
      if (a.status === "DENIED") return `A return label isn't available${why}.`;
      return null;
    case "store_credit":
      if (a.status === "DONE") return `Store credit of ${amt} added to your account${a.id ? ` (${a.id})` : ""}.`;
      if (a.status === "DENIED") return `We couldn't add store credit${why}.`;
      return null;
    case "escalate":
      return a.status === "DONE" ? `Your case has been escalated to a specialist.` : null;
    default:
      return null;
  }
}

