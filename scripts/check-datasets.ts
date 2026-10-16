/**
 * Deterministic dataset checker (no DB, no LLM). Usage:
 *   npx tsx scripts/check-datasets.ts <file.jsonl> [more files…]
 * Detects the dataset type from the file name and checks every row:
 *  - eval-set:   schema, fixture consistency, and the REAL policy gate over `referencePlan`
 *                (every executable reference action must pass; prints decisions + reason codes)
 *  - retrieval:  gold clause keys exist and are in effect on the governing date
 *  - redteam:    customer/order IDs exist in the seed snapshot (and ownership rules)
 *  - benign:     shape only
 * Exit code 1 if any row fails.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { ActionSchema } from "@/lib/agent/schemas";
import { runGate, type GateOrder } from "@/lib/policy/gate";
import { AGENT } from "@/config/agent";
import { product } from "@/lib/seed/catalog";
import { fixtureOrderTotal, type FixtureSet } from "@/lib/seed/fixtures";
import { getCorpus } from "@/lib/rag/corpus";
import { inEffect } from "@/lib/util/dates";
import { governingDateForClause } from "@/lib/rag/temporal-filter";

const snapshot = JSON.parse(readFileSync("data/seed/customers-snapshot.json", "utf8")) as {
  customers: { id: string; tier: string; orders: { id: string }[] }[];
};
const seedOrderOwner = new Map<string, string>();
for (const c of snapshot.customers) for (const o of c.orders) seedOrderOwner.set(o.id, c.id);
const seedCustomers = new Set(snapshot.customers.map((c) => c.id));

const CATEGORIES = ["damaged", "double_charge", "late_lost", "return_window", "temporal", "vip_churn", "missing_info", "multi_order", "social_engineering", "fault"];

const Fault = z.object({ service: z.string(), operation: z.string(), mode: z.string(), n: z.number().int().optional() });
const Scenario = z.object({
  id: z.string().regex(/^ev-\d{3}$/),
  category: z.enum(CATEGORIES as [string, ...string[]]),
  title: z.string().min(5),
  persona: z.object({ style: z.string(), patience: z.number().int().min(1).max(5), honesty: z.string() }),
  hiddenGoal: z.string().min(5),
  knownFacts: z.array(z.string()).min(1),
  openingMessage: z.string().min(3),
  customerId: z.string().regex(/^CUS-\d{4}$/),
  fixtures: z.object({
    customers: z.array(z.any()),
    orders: z.array(z.any()),
    refunds: z.array(z.any()).optional(),
    storeCredits: z.array(z.any()).optional(),
    tickets: z.array(z.any()).optional(),
    inventory: z.record(z.string(), z.number()).optional(),
  }),
  faults: z.array(Fault),
  evidenceAttached: z.boolean(),
  referencePlan: z.array(ActionSchema).min(1),
  supervisorPolicy: z.object({ action: z.enum(["approve", "modify", "reject"]), amountCents: z.number().int().optional(), removeTypes: z.array(z.string()).optional() }),
  goldClauseIds: z.array(z.string().regex(/^§\d+\.\d+$/)),
  maxTurns: z.number().int().min(1).max(8),
  authoringNotes: z.string().optional(),
});

function gateOrdersFrom(fx: FixtureSet, extraOwner?: string): GateOrder[] {
  void extraOwner;
  return fx.orders.map((o) => {
    const { total } = fixtureOrderTotal(o);
    const captures = o.captures.map((c, i) => ({ id: `CH-${i}`, amountCents: c.amountCents ?? total, capturedAt: c.at }));
    const refunds = (fx.refunds ?? []).filter((r) => r.orderId === o.id);
    const last = o.events.length ? o.events[o.events.length - 1].at.slice(0, 10) : null;
    return {
      id: o.id,
      customerId: o.customerId,
      orderDate: o.orderDate,
      promisedDate: o.promisedDate,
      deliveredDate: o.deliveredDate,
      status: o.status,
      shippingCents: o.shippingCents,
      totalCents: total,
      items: o.items.map((i) => {
        const p = product(i.sku);
        return { sku: i.sku, name: p.name, category: p.category, qty: i.qty, unitPriceCents: i.unitPriceCents ?? p.priceCents };
      }),
      captures,
      paidCents: captures.reduce((s, c) => s + c.amountCents, 0),
      refundedCents: refunds.reduce((s, r) => s + r.amountCents, 0),
      priorRefunds: refunds.map((r) => ({ amountCents: r.amountCents, reason: r.reason })),
      priorReplacements: 0,
      activeLabels: 0,
      damageScan: o.events.some((e) => e.code === "exception_damaged"),
      lastTrackingEventDate: last,
    };
  });
}

function checkScenario(raw: unknown, line: number): string[] {
  const errs: string[] = [];
  const parsed = Scenario.safeParse(raw);
  if (!parsed.success) return [`line ${line}: schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`];
  const sc = parsed.data;
  const fx = sc.fixtures as unknown as FixtureSet;
  const usesSeed = seedCustomers.has(sc.customerId);
  if (!usesSeed && !fx.customers.some((c) => c.id === sc.customerId)) errs.push(`${sc.id}: customerId ${sc.customerId} not in fixtures`);
  for (const o of fx.orders) {
    if (!/^ORD-\d{4}$/.test(o.id)) errs.push(`${sc.id}: bad order id ${o.id}`);
    if (seedOrderOwner.has(o.id)) errs.push(`${sc.id}: order ${o.id} collides with a seed order`);
    for (const i of o.items) {
      try {
        product(i.sku);
      } catch {
        errs.push(`${sc.id}: unknown SKU ${i.sku}`);
      }
    }
    if (o.deliveredDate && o.deliveredDate < o.orderDate) errs.push(`${sc.id}: ${o.id} delivered before ordered`);
    if (o.orderDate > AGENT.businessDate) errs.push(`${sc.id}: ${o.id} ordered after the business date`);
    if (o.status === "delivered" && !o.deliveredDate) errs.push(`${sc.id}: ${o.id} delivered without deliveredDate`);
    if (!o.captures?.length) errs.push(`${sc.id}: ${o.id} has no captures`);
  }
  for (const c of fx.customers) if (seedCustomers.has(c.id)) errs.push(`${sc.id}: fixture customer ${c.id} collides with seed`);
  if (errs.length) return errs;

  const customer = fx.customers.find((c) => c.id === sc.customerId);
  const tier = (customer?.tier ?? snapshot.customers.find((c) => c.id === sc.customerId)?.tier ?? "standard") as "standard" | "gold" | "platinum";
  if (usesSeed) return []; // seed-backed (social engineering) rows: gate is exercised at eval time
  const gate = runGate(sc.referencePlan, {
    claimDate: AGENT.businessDate,
    customer: { id: sc.customerId, tier },
    churnRisk: sc.category === "vip_churn" ? "high" : "low",
    orders: gateOrdersFrom(fx),
    storeCredits: (fx.storeCredits ?? []).map((c) => ({ amountCents: c.amountCents, reason: c.reason, createdAt: c.createdAt })),
    inventory: Object.fromEntries(
      fx.orders.flatMap((o) => o.items.map((i) => [i.sku, fx.inventory?.[i.sku] ?? product(i.sku).stock])),
    ),
    evidenceAttached: sc.evidenceAttached,
    firewallFlagged: false,
    socialSignals: [],
  });
  const summary = gate.decisions.map((d) => `${d.action.type}${d.addedByGate ? "(gate-added)" : ""}=${d.status}${d.reasonCodes.length ? `[${d.reasonCodes.join(",")}]` : ""}`).join(" ");
  for (const d of gate.decisions) {
    if (d.addedByGate) continue;
    if (d.status === "DENIED") errs.push(`${sc.id}: reference action ${d.action.type} is DENIED by the gate: ${d.checks.filter((c) => !c.pass).map((c) => `${c.code} (${c.detail})`).join("; ")}`);
  }
  console.log(`  ${sc.id} [${sc.category}] route=${gate.route} exposure=${gate.totalExposureCents} limit=${gate.autoLimitCents} :: ${summary}`);
  return errs;
}

const keys = new Set(getCorpus().map((c) => c.key));
function checkRetrieval(raw: Record<string, unknown>, line: number): string[] {
  const errs: string[] = [];
  const id = String(raw.id ?? `line ${line}`);
  for (const f of ["query", "family", "orderDate", "claimDate", "goldKeys"]) if (!(f in raw)) errs.push(`${id}: missing ${f}`);
  if (errs.length) return errs;
  const gold = raw.goldKeys as string[];
  if (!Array.isArray(gold) || !gold.length || gold.length > 2) errs.push(`${id}: goldKeys must have 1-2 keys`);
  for (const k of gold ?? []) {
    if (!keys.has(k)) {
      errs.push(`${id}: unknown clause key ${k}`);
      continue;
    }
    const c = getCorpus().find((x) => x.key === k)!;
    const date = governingDateForClause(c, { claimDate: String(raw.claimDate), orderDate: String(raw.orderDate) });
    if (!inEffect(date, c.effectiveFrom, c.effectiveTo)) errs.push(`${id}: ${k} is not in effect on governing date ${date}`);
  }
  if (String(raw.claimDate) < String(raw.orderDate)) errs.push(`${id}: claimDate before orderDate`);
  return errs;
}

function checkRedteam(raw: Record<string, unknown>, line: number): string[] {
  const errs: string[] = [];
  const id = String(raw.id ?? `line ${line}`);
  const cust = String(raw.customerId ?? "");
  if (!seedCustomers.has(cust)) errs.push(`${id}: customer ${cust} not in seed`);
  const target = raw.targetOrderId as string | undefined;
  if (target) {
    const owner = seedOrderOwner.get(target);
    if (!owner) errs.push(`${id}: target order ${target} not in seed`);
    else if (raw.category === "other_customers_order" && owner === cust) errs.push(`${id}: other_customers_order targets the customer's own order`);
    else if (raw.category !== "other_customers_order" && owner !== cust) errs.push(`${id}: target order belongs to ${owner}, not ${cust}`);
  }
  if (!raw.message && !raw.turns) errs.push(`${id}: no message/turns`);
  return errs;
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  const name = basename(file);
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  console.log(`\n${name}: ${lines.length} rows`);
  const ids = new Set<string>();
  lines.forEach((l, i) => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(l);
    } catch {
      console.log(`  ✗ line ${i + 1}: invalid JSON`);
      failed++;
      return;
    }
    if (ids.has(String(row.id))) {
      console.log(`  ✗ duplicate id ${row.id}`);
      failed++;
    }
    ids.add(String(row.id));
    const errs = name.startsWith("eval-set")
      ? checkScenario(row, i + 1)
      : name.startsWith("retrieval")
        ? checkRetrieval(row, i + 1)
        : name.startsWith("redteam")
          ? checkRedteam(row, i + 1)
          : !row.message
            ? [`line ${i + 1}: missing message`]
            : [];
    for (const e of errs) console.log(`  ✗ ${e}`);
    failed += errs.length;
  });
}
console.log(failed ? `\n✗ ${failed} problem(s)` : "\n✓ all rows pass");
process.exit(failed ? 1 : 0);
