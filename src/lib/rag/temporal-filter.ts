/**
 * Temporal filter (runs in code, before any scoring): keep only clauses whose version was
 * in effect on the governing date for that clause's policy family. Families default to the
 * claim date when no order date applies. Removed clauses are returned with a reason so the
 * inspector can show what a naive retriever would have cited.
 */
import { inEffect } from "@/lib/util/dates";
import type { PolicyId } from "@/lib/policy/rules";
import type { Clause } from "@/lib/policy/clauses";

export type GoverningDates = { claimDate: string; orderDate?: string | null };

const ORDER_DATE_FAMILIES: PolicyId[] = ["RETURNS_STANDARD", "SHIPPING_DELAYS", "DAMAGE_TRANSIT"];

export function governingDateForClause(c: Pick<Clause, "policyId">, dates: GoverningDates): string {
  return ORDER_DATE_FAMILIES.includes(c.policyId) && dates.orderDate ? dates.orderDate : dates.claimDate;
}

export function temporalFilter<C extends Clause>(clauses: C[], dates: GoverningDates) {
  const kept: C[] = [];
  const removed: { clause: C; reason: string }[] = [];
  for (const c of clauses) {
    const date = governingDateForClause(c, dates);
    if (inEffect(date, c.effectiveFrom, c.effectiveTo)) kept.push(c);
    else removed.push({ clause: c, reason: `not in effect on ${date}` });
  }
  return { kept, removed };
}
