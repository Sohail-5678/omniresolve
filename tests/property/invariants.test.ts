/**
 * Property-based invariants (fast-check, seeded) for OmniResolve's safety core.
 *
 *  (a) policy gate: an AUTO_APPROVED refund never exceeds paid - refunded and never touches another
 *      customer's order; risk flags (firewall, social engineering, amount over the limit) force a human.
 *  (b) approval tokens: no state-changing call through guardedExecute succeeds without a valid,
 *      unused, matching token, and each token is consumed at most once.
 *  (c) saga: per order, refunds never exceed what was paid and one saga issues at most one refund,
 *      under random faults on random saga steps.
 *  (d) a rejected approval never changes business state.
 *  (e) replaying a resume (same thread + interruptId) never runs the saga twice.
 *
 * Every property is seeded (fc.configureGlobal({ seed: 42 }) and { seed: 42 } per assert). Pure
 * properties run >= 1000 cases. DB-backed properties use a fresh sandbox per case and run fewer cases
 * (numRuns is stated next to each one) so the whole file stays under a minute; each DB property is
 * paired with a high-count pure property over the same code where a pure surface exists.
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as s from "@/db/schema";
import { createPool, type Tx } from "@/db/client";
import { AGENT } from "@/config/agent";
import { runGate, type GateInput, type GateOrder, type GateResult } from "@/lib/policy/gate";
import { POLICY_IDS, policyFor, type Tier } from "@/lib/policy/rules";
import { CREDIT_REASONS, REFUND_REASONS, SOCIAL_SIGNALS, type Action } from "@/lib/agent/schemas";
import { mintToken, revokeIssuedTokens, signPayload, signatureValid, type TokenAction, type TokenPayload } from "@/lib/security/approval-token";
import { guardedExecute, type GuardScope } from "@/lib/security/tool-guard";
import { GuardError, ServiceError, type GuardCode } from "@/lib/util/errors";
import { canonicalize, hmacHex } from "@/lib/util/canonical";
import { addDays } from "@/lib/util/dates";
import { planHashOf, runSaga, type SagaSummary } from "@/lib/saga/orchestrator";
import { buildSteps, type ApprovedAction, type SagaPlan } from "@/lib/saga/steps";
import { isRetryable, outcomeUnknown, withRetry } from "@/lib/saga/retry";
import type { FaultMode, ServiceName } from "@/lib/services/fault-injector";
import * as billing from "@/lib/services/billing";
import { afterHitl } from "@/lib/agent/nodes/hitl";
import type { GraphState, HitlDecision } from "@/lib/agent/state";
import { runTurn, resumeTurn, type TurnResult } from "@/lib/agent/runner";
import { db, fault, freshSandbox, newThread, instant, ScriptedLlm, templateResponder, cite } from "../helpers";

// The `timeout` / `commit_then_timeout` faults really sleep AGENT.faults.timeoutMs (350 ms) inside the mock
// services. That is a fixed simulated latency, not a saga backoff, so the instant saga hooks cannot skip it.
// Shrinking it to 1 ms keeps the failure semantics identical (504 TIMEOUT, committed or not) and lets the
// DB-backed saga properties run ~10x more cases inside the time budget. Nothing else in AGENT changes.
vi.mock("@/config/agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/config/agent")>();
  return { ...mod, AGENT: { ...mod.AGENT, faults: { ...mod.AGENT.faults, timeoutMs: 1 } } };
});

fc.configureGlobal({ seed: 42 });
const SEED = 42;

const thr = () => `thr_${randomUUID().slice(0, 8)}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// =============================================================================================
// (a) policy gate
// =============================================================================================

const CATALOG = [
  { sku: "KIT-POUR-02", category: "kitchen" },
  { sku: "GLS-AUR-01", category: "home_glass" },
  { sku: "GLS-CUT-09", category: "custom_cut_glass" },
  { sku: "GFT-050", category: "gift_card" },
  { sku: "CLR-SALE-1", category: "clearance" },
  { sku: "TXT-MER-01", category: "textiles" },
  { sku: "ELC-THM-01", category: "electronics" },
] as const;

const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);
const itemValue = (o: GateOrder) => sum(o.items.map((i) => i.unitPriceCents * i.qty));
const refundable = (o: GateOrder) => o.paidCents - o.refundedCents;

const orderSeedArb = fc.record({
  // Mostly recent orders (inside return/damage windows) so valid remedies — and their boundaries — are common.
  ageDays: fc.oneof({ arbitrary: fc.integer({ min: 0, max: 20 }), weight: 3 }, { arbitrary: fc.integer({ min: 0, max: 200 }), weight: 1 }),
  promisedAfter: fc.integer({ min: 1, max: 10 }),
  deliveredAfter: fc.option(fc.integer({ min: 1, max: 25 }), { nil: null }),
  undeliveredStatus: fc.constantFrom("shipped", "processing", "lost"),
  shippingCents: fc.constantFrom(0, 500, 700, 900),
  items: fc.uniqueArray(
    fc.record({ idx: fc.integer({ min: 0, max: CATALOG.length - 1 }), qty: fc.integer({ min: 1, max: 3 }), unitPriceCents: fc.integer({ min: 100, max: 40_000 }) }),
    { minLength: 1, maxLength: 3, selector: (i) => i.idx },
  ),
  extraCaptures: fc.array(
    fc.record({ duplicate: fc.boolean(), amountCents: fc.integer({ min: 100, max: 50_000 }), hoursLater: fc.integer({ min: 0, max: 72 }) }),
    { maxLength: 2 },
  ),
  refundKind: fc.constantFrom("none", "none", "partial", "split", "full"),
  refundPermille: fc.integer({ min: 1, max: 999 }),
  refundReasons: fc.tuple(fc.constantFrom(...REFUND_REASONS), fc.constantFrom(...REFUND_REASONS)),
  priorReplacements: fc.constantFrom(0, 0, 1),
  activeLabels: fc.constantFrom(0, 0, 1),
  damageScan: fc.boolean(),
  trackingAgo: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
});
type OrderSeed = ReturnType<typeof orderSeedArb.generate>["value"];

/** A self-consistent order: paid = sum(captures), refunded = sum(priorRefunds) <= paid, dates in order. */
function buildOrder(seed: OrderSeed, id: string, customerId: string, claimDate: string): GateOrder {
  const orderDate = maxIso(addDays(claimDate, -seed.ageDays), "2024-01-01");
  const deliveredDate = seed.deliveredAfter === null ? null : minIso(addDays(orderDate, seed.deliveredAfter), claimDate);
  const items = seed.items.map((i) => ({ sku: CATALOG[i.idx].sku, name: CATALOG[i.idx].sku, category: CATALOG[i.idx].category, qty: i.qty, unitPriceCents: i.unitPriceCents }));
  const totalCents = sum(items.map((i) => i.unitPriceCents * i.qty)) + seed.shippingCents;
  const t0 = Date.parse(`${orderDate}T10:00:00.000Z`);
  const captures = [
    { id: `${id}-C0`, amountCents: totalCents, capturedAt: new Date(t0).toISOString() },
    ...seed.extraCaptures.map((c, i) => ({ id: `${id}-C${i + 1}`, amountCents: c.duplicate ? totalCents : c.amountCents, capturedAt: new Date(t0 + c.hoursLater * 3_600_000).toISOString() })),
  ];
  const paidCents = sum(captures.map((c) => c.amountCents));
  const part = Math.max(1, Math.floor((paidCents * seed.refundPermille) / 1000));
  const [r0, r1] = seed.refundReasons;
  const priorRefunds =
    seed.refundKind === "partial"
      ? [{ amountCents: part, reason: r0 }]
      : seed.refundKind === "split"
        ? [{ amountCents: Math.ceil(part / 2), reason: r0 }, { amountCents: Math.floor(part / 2), reason: r1 }].filter((r) => r.amountCents > 0)
        : seed.refundKind === "full"
          ? [{ amountCents: paidCents, reason: r0 }]
          : [];
  return {
    id,
    customerId,
    orderDate,
    promisedDate: addDays(orderDate, seed.promisedAfter),
    deliveredDate,
    status: deliveredDate ? "delivered" : seed.undeliveredStatus,
    shippingCents: seed.shippingCents,
    totalCents,
    items,
    captures,
    paidCents,
    refundedCents: sum(priorRefunds.map((r) => r.amountCents)),
    priorRefunds,
    priorReplacements: seed.priorReplacements,
    activeLabels: seed.activeLabels,
    damageScan: seed.damageScan,
    lastTrackingEventDate: seed.trackingAgo === null ? null : maxIso(addDays(claimDate, -seed.trackingAgo), orderDate),
  };
}

/** Random but valid gate inputs: own orders plus (adversarially) other customers' orders in the list. */
const gateInputArb: fc.Arbitrary<GateInput> = fc
  .record({
    day: fc.integer({ min: 0, max: 1050 }), // claim dates 2024-02-15 .. 2026-12-31 (all policy versions)
    customerNo: fc.integer({ min: 1000, max: 1999 }),
    tier: fc.constantFrom<Tier>("standard", "gold", "platinum"),
    churnRisk: fc.constantFrom<GateInput["churnRisk"]>("low", "medium", "high"),
    orderNos: fc.uniqueArray(fc.integer({ min: 1000, max: 9999 }), { minLength: 5, maxLength: 5 }),
    nOwn: fc.integer({ min: 1, max: 3 }),
    nForeign: fc.integer({ min: 0, max: 2 }),
    orderSeeds: fc.array(orderSeedArb, { minLength: 5, maxLength: 5 }),
    credits: fc.array(fc.record({ amountCents: fc.integer({ min: 100, max: 3000 }), reason: fc.constantFrom(...CREDIT_REASONS), ago: fc.integer({ min: 0, max: 200 }) }), { maxLength: 2 }),
    stock: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: CATALOG.length, maxLength: CATALOG.length }),
    evidenceAttached: fc.boolean(),
    firewallFlagged: fc.oneof({ arbitrary: fc.constant(false), weight: 2 }, { arbitrary: fc.constant(true), weight: 1 }),
    socialSignals: fc.oneof({ arbitrary: fc.constant([] as (typeof SOCIAL_SIGNALS)[number][]), weight: 2 }, { arbitrary: fc.subarray([...SOCIAL_SIGNALS], { minLength: 1 }), weight: 1 }),
    supervisorApproved: fc.option(fc.boolean(), { nil: undefined, freq: 2 }),
    autoLimitOverrideCents: fc.option(fc.integer({ min: 1, max: 50_000 }), { nil: undefined, freq: 2 }),
  })
  .map((r): GateInput => {
    const claimDate = addDays("2024-02-15", r.day);
    const customerId = `CUS-${r.customerNo}`;
    const foreignId = `CUS-${r.customerNo + 1000}`;
    const orders = [
      ...r.orderSeeds.slice(0, r.nOwn).map((seed, i) => buildOrder(seed, `ORD-${r.orderNos[i]}`, customerId, claimDate)),
      ...r.orderSeeds.slice(3, 3 + r.nForeign).map((seed, i) => buildOrder(seed, `ORD-${r.orderNos[3 + i]}`, foreignId, claimDate)),
    ];
    return {
      claimDate,
      customer: { id: customerId, tier: r.tier },
      churnRisk: r.churnRisk,
      orders,
      storeCredits: r.credits.map((c) => ({ amountCents: c.amountCents, reason: c.reason, createdAt: `${addDays(claimDate, -c.ago)}T12:00:00.000Z` })),
      inventory: Object.fromEntries(CATALOG.map((c, i) => [c.sku, r.stock[i]])),
      evidenceAttached: r.evidenceAttached,
      firewallFlagged: r.firewallFlagged,
      socialSignals: r.socialSignals,
      supervisorApproved: r.supervisorApproved,
      autoLimitOverrideCents: r.autoLimitOverrideCents,
    };
  });

/**
 * Plans an LLM (or a prompt injection that fully controls the planner) could emit: amounts from
 * 1 cent to $100k with boundary values around each order's refundable balance, other customers'
 * and non-existent orders, duplicate refunds, reasons outside the schema, exception flags.
 */
function planArb(input: GateInput): fc.Arbitrary<Action[]> {
  const ids = [...input.orders.map((o) => o.id), "ORD-0000"];
  const boundary = new Set<number>([10_000_000]);
  for (const o of input.orders) {
    const avail = refundable(o);
    for (const v of [avail, avail + 1, avail - 1, o.paidCents, o.paidCents + 1, o.shippingCents, o.shippingCents + 1, itemValue(o), itemValue(o) + 1, o.totalCents, Math.min(avail, itemValue(o)), Math.min(avail, itemValue(o)) + 1]) {
      if (v > 0 && v <= 10_000_000) boundary.add(v);
    }
  }
  const amount = fc.oneof(
    { arbitrary: fc.constantFrom(...boundary), weight: 4 },
    { arbitrary: fc.integer({ min: 1, max: 5_000 }), weight: 3 },
    { arbitrary: fc.integer({ min: 1, max: 25_000 }), weight: 1 },
    { arbitrary: fc.integer({ min: 1, max: 10_000_000 }), weight: 1 },
  );
  const skus = [...new Set(input.orders.flatMap((o) => o.items.map((i) => i.sku))), "NOPE-404"];
  const exception = fc.option(fc.boolean(), { nil: undefined });
  const refund = fc.record({
    type: fc.constant("refund" as const),
    orderId: fc.constantFrom(...ids),
    amountCents: amount,
    reason: fc.oneof(
      { arbitrary: fc.constantFrom<string>("damaged", "return", "duplicate_charge", "lost_package"), weight: 4 },
      { arbitrary: fc.constantFrom<string>(...REFUND_REASONS, "chargeback", "because_i_said_so"), weight: 1 },
    ),
    exception,
  });
  const credit = fc.record({
    type: fc.constant("store_credit" as const),
    amountCents: amount,
    reason: fc.constantFrom<string>(...CREDIT_REASONS, "vip_bonus"),
    orderId: fc.option(fc.constantFrom(...ids), { nil: undefined }),
    exception,
  });
  const replacement = fc.record({
    type: fc.constant("replacement" as const),
    orderId: fc.constantFrom(...ids),
    sku: fc.constantFrom(...skus),
    qty: fc.integer({ min: 1, max: 20 }),
    reason: fc.option(fc.constantFrom("damaged" as const, "lost_package" as const), { nil: undefined }),
  });
  const label = fc.record({
    type: fc.constant("return_label" as const),
    orderId: fc.constantFrom(...ids),
    reason: fc.option(fc.constantFrom("return" as const, "damaged" as const), { nil: undefined }),
  });
  const action = fc.oneof(
    { arbitrary: refund, weight: 5 },
    { arbitrary: credit, weight: 3 },
    { arbitrary: replacement, weight: 2 },
    { arbitrary: label, weight: 1 },
    { arbitrary: fc.constant({ type: "escalate" as const, reason: "Needs a specialist" }), weight: 1 },
    { arbitrary: fc.constant({ type: "deny" as const, reason: "Not covered" }), weight: 1 },
    { arbitrary: fc.constant({ type: "ask_customer" as const, question: "Which item?" }), weight: 1 },
  ) as fc.Arbitrary<Action>;
  return fc
    .tuple(fc.array(action, { minLength: 1, maxLength: 6 }), fc.constantFrom("as_is", "as_is", "dup_first", "doubled"))
    .map(([p, how]) => (how === "as_is" ? p : how === "dup_first" ? [...p, p[0]] : [...p, ...p]));
}

type GateCase = { input: GateInput; plan: Action[] };
const randomCaseArb: fc.Arbitrary<GateCase> = gateInputArb.chain((input) => planArb(input).map((plan) => ({ input, plan })));

/**
 * Boundary-focused cases: a recent, cheap, delivered order with a partial prior refund (different reason),
 * and a refund planned at exactly refundable - 1 / refundable / refundable + 1, so that AMOUNT_WITHIN_PAID is
 * the binding check (purely random plans rarely land on it).
 */
const focusedCaseArb: fc.Arbitrary<GateCase> = fc
  .record({
    base: gateInputArb,
    ageDays: fc.integer({ min: 2, max: 12 }),
    deliveredAfter: fc.integer({ min: 1, max: 2 }),
    price: fc.integer({ min: 300, max: 4_500 }),
    shippingCents: fc.constantFrom(0, 500, 700),
    priorPermille: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null, freq: 4 }),
    priorReason: fc.constantFrom("goodwill", "other", "late_delivery"),
    reason: fc.constantFrom("damaged" as const, "return" as const),
    delta: fc.constantFrom(-1, 0, 0, 1),
  })
  .chain((r) => {
    const orderDate = addDays(r.base.claimDate, -r.ageDays);
    const deliveredDate = addDays(orderDate, r.deliveredAfter);
    const totalCents = r.price + r.shippingCents;
    const prior = r.priorPermille === null ? 0 : Math.max(1, Math.floor((totalCents * r.priorPermille) / 1000));
    const order: GateOrder = {
      id: "ORD-0555",
      customerId: r.base.customer.id,
      orderDate,
      promisedDate: deliveredDate,
      deliveredDate,
      status: "delivered",
      shippingCents: r.shippingCents,
      totalCents,
      items: [{ sku: "KIT-POUR-02", name: "Ceramic pour-over set", category: "kitchen", qty: 1, unitPriceCents: r.price }],
      captures: [{ id: "CH-0555", amountCents: totalCents, capturedAt: `${orderDate}T10:00:00.000Z` }],
      paidCents: totalCents,
      refundedCents: prior,
      priorRefunds: prior ? [{ amountCents: prior, reason: r.priorReason }] : [],
      priorReplacements: 0,
      activeLabels: 0,
      damageScan: true,
      lastTrackingEventDate: deliveredDate,
    };
    const input: GateInput = { ...r.base, orders: [order, ...r.base.orders] };
    const refund: Action = { type: "refund", orderId: order.id, amountCents: Math.max(1, totalCents - prior + r.delta), reason: r.reason };
    return fc.oneof(fc.constant<Action[]>([refund]), planArb(input).map((p) => [refund, ...p.slice(0, 2)])).map((plan) => ({ input, plan }));
  });

const gateCaseArb: fc.Arbitrary<GateCase> = fc.oneof({ arbitrary: randomCaseArb, weight: 3 }, { arbitrary: focusedCaseArb, weight: 1 });

const brief = (d: GateResult["decisions"][number]) => `${d.index}:${d.action.type}:${d.status}`;

function assertGateInvariants({ input, plan }: GateCase, res: GateResult) {
  const auto = res.decisions.filter((d) => d.status === "AUTO_APPROVED");
  const live = res.decisions.filter((d) => d.status === "AUTO_APPROVED" || d.status === "NEEDS_HUMAN");
  const liveExposure = sum(live.map((d) => d.exposureCents));

  for (const d of auto) {
    // Nothing is auto-approved past a failed hard check; a soft failure only with a supervisor-approved exception.
    expect(d.checks.filter((c) => c.hard && !c.pass).map((c) => c.code), brief(d)).toEqual([]);
    if (d.checks.some((c) => !c.pass)) {
      expect(input.supervisorApproved, brief(d)).toBe(true);
      expect((d.action as { exception?: boolean }).exception, brief(d)).toBe(true);
      expect(input.churnRisk === "high" || input.customer.tier === "platinum", brief(d)).toBe(true);
    }
    const a = d.action;
    if ("orderId" in a && a.orderId) {
      const o = input.orders.find((x) => x.id === a.orderId);
      expect(o, `${brief(d)} references unknown ${a.orderId}`).toBeDefined();
      expect(o!.customerId, `${brief(d)} touches another customer's order`).toBe(input.customer.id);
    }
    if (a.type === "refund") {
      const o = input.orders.find((x) => x.id === a.orderId && x.customerId === input.customer.id)!;
      expect(a.amountCents, `${brief(d)} exceeds paid - refunded`).toBeLessThanOrEqual(refundable(o));
      expect(o.priorRefunds.map((r) => r.reason), `${brief(d)} duplicates a prior refund`).not.toContain(a.reason);
    }
  }
  expect(auto.filter((d) => d.action.type === "refund").length).toBeLessThanOrEqual(policyFor("APPROVAL_AUTHORITY", input.claimDate).params.maxRefundsPerResolution);

  if (!input.supervisorApproved) {
    // (supervisorApproved is the HITL re-check after a human already reviewed the flags.)
    if (input.firewallFlagged) {
      expect(auto.filter((d) => d.exposureCents > 0).map(brief)).toEqual([]);
      if (liveExposure > 0) {
        expect(auto.map(brief)).toEqual([]);
        expect(res.route).toBe("human");
        expect(res.humanReasons).toContain("FIREWALL_FLAGGED");
      }
    }
    if (input.socialSignals.length > 0 && liveExposure > 0) expect(auto.map(brief)).toEqual([]);
    if (liveExposure > res.autoLimitCents) expect(auto.map(brief)).toEqual([]);
  }

  // The gate judges every proposed action, in order, and never reports exposure for dead decisions.
  expect(res.decisions.filter((d) => !d.addedByGate).map((d) => d.index)).toEqual(plan.map((_, i) => i));
  for (const d of res.decisions) if (d.status === "DENIED" || d.status === "INFO") expect(d.exposureCents).toBe(0);
  expect(res.totalExposureCents).toBe(liveExposure);
}

/** A delivered, undamaged-on-paper kitchen order: item $20 + $5 shipping, paid once. */
function exampleOrder(over: Partial<GateOrder> = {}): GateOrder {
  return {
    id: "ORD-4242",
    customerId: "CUS-1500",
    orderDate: "2026-10-08",
    promisedDate: "2026-10-12",
    deliveredDate: "2026-10-12",
    status: "delivered",
    shippingCents: 500,
    totalCents: 2500,
    items: [{ sku: "KIT-POUR-02", name: "Ceramic pour-over set", category: "kitchen", qty: 1, unitPriceCents: 2000 }],
    captures: [{ id: "CH-1", amountCents: 2500, capturedAt: "2026-10-08T10:00:00.000Z" }],
    paidCents: 2500,
    refundedCents: 0,
    priorRefunds: [],
    priorReplacements: 0,
    activeLabels: 0,
    damageScan: true,
    lastTrackingEventDate: "2026-10-12",
    ...over,
  };
}
function exampleInput(order: GateOrder): GateInput {
  return { claimDate: "2026-10-16", customer: { id: "CUS-1500", tier: "standard" }, churnRisk: "low", orders: [order], storeCredits: [], inventory: { "KIT-POUR-02": 3 }, evidenceAttached: false, firewallFlagged: false, socialSignals: [] };
}

describe("(a) policy gate invariants", () => {
  it("auto-approved money stays within paid - refunded, on the customer's own orders; risk flags force a human", () => {
    // numRuns: 3000 (pure).
    fc.assert(
      fc.property(gateCaseArb, (c) => {
        assertGateInvariants(c, runGate(c.plan, c.input));
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it("the supervisor re-check (supervisorApproved) never lifts the paid - refunded ceiling or the ownership check", () => {
    // numRuns: 1500 (pure). Same plans, forced through the HITL re-gate path with exceptions requested.
    fc.assert(
      fc.property(gateCaseArb, ({ input, plan }) => {
        const withExceptions = plan.map((a) => (a.type === "refund" || a.type === "store_credit" ? { ...a, exception: true } : a));
        const res = runGate(withExceptions, { ...input, supervisorApproved: true });
        assertGateInvariants({ input: { ...input, supervisorApproved: true }, plan: withExceptions }, res);
        expect(res.humanReasons).toEqual([]);
        expect(res.decisions.some((d) => d.status === "NEEDS_HUMAN")).toBe(false);
      }),
      { seed: SEED, numRuns: 1500 },
    );
  });

  // BUG (src/lib/policy/gate.ts, evaluate(), case "store_credit"): order-bound remedy credits ("damaged",
  // "out_of_window_return") are capped by item value / the credit cap only. They ignore refunds already
  // issued on the order AND refunds for the same order in the same plan, so the gate auto-approves a double
  // remedy for one order. Expected: per order, auto-approved refund + remedy credit <= paid - refunded.
  // Actual (the three examples below, all AUTO_APPROVED with route "auto"):
  //   1. order fully refunded ($25 of $25) + store_credit damaged $20        -> $20 out on a $0 balance
  //   2. refund damaged $25 + store_credit damaged $20, same order, one plan -> $45 out on a $25 order
  //   3. refund return $20 + store_credit out_of_window_return $20 on an order 8 days old (inside the
  //      30-day window; the gate never checks that the order is actually out of window)
  // A prompt-injected planner can therefore move ~2x the order value without a human, under the auto limit.
  it("auto-approved refund + order-bound remedy credit for one order can exceed paid - refunded", () => {
    // numRuns: 1000 (pure) + 3 explicit examples.
    const REMEDY_CREDITS = new Set(["damaged", "out_of_window_return"]);
    const fresh = exampleOrder();
    fc.assert(
      fc.property(gateCaseArb, ({ input, plan }) => {
        const res = runGate(plan, input);
        for (const o of input.orders.filter((x) => x.customerId === input.customer.id)) {
          const out = res.decisions
            .filter((d) => d.status === "AUTO_APPROVED" && "orderId" in d.action && d.action.orderId === o.id)
            .filter((d) => d.action.type === "refund" || (d.action.type === "store_credit" && REMEDY_CREDITS.has(d.action.reason)))
            .map((d) => (d.action as { amountCents: number }).amountCents);
          expect(sum(out), `money out against ${o.id}`).toBeLessThanOrEqual(refundable(o));
        }
      }),
      {
        seed: SEED,
        numRuns: 1000,
        examples: [
          [{ input: exampleInput(exampleOrder({ refundedCents: 2500, priorRefunds: [{ amountCents: 2500, reason: "return" }] })), plan: [{ type: "store_credit", amountCents: 2000, reason: "damaged", orderId: "ORD-4242" }] }],
          [{ input: exampleInput(fresh), plan: [{ type: "refund", orderId: "ORD-4242", amountCents: 2500, reason: "damaged" }, { type: "store_credit", amountCents: 2000, reason: "damaged", orderId: "ORD-4242" }] }],
          [{ input: exampleInput(fresh), plan: [{ type: "refund", orderId: "ORD-4242", amountCents: 2000, reason: "return" }, { type: "store_credit", amountCents: 2000, reason: "out_of_window_return", orderId: "ORD-4242" }] }],
        ],
      },
    );
  });
});

// =============================================================================================
// (b) approval tokens: single use at the tool boundary
// =============================================================================================

const SIGN_FIELDS = ["tokenId", "sandboxId", "threadId", "action", "orderId", "amountCents", "sku", "qty", "policyId", "policyVersion", "approvedBy", "issuedAt", "expiresAt"] as const;

const payloadArb: fc.Arbitrary<TokenPayload> = fc
  .record({
    tokenId: fc.uuid(),
    sandboxId: fc.stringMatching(/^sb_[A-Za-z0-9_-]{12}$/),
    threadId: fc.stringMatching(/^thr_[a-z0-9]{8}$/),
    action: fc.constantFrom<TokenAction>("refund", "store_credit", "replacement", "return_label"),
    orderId: fc.option(fc.stringMatching(/^ORD-\d{4}$/), { nil: null }),
    amountCents: fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: null }),
    sku: fc.option(fc.constantFrom("KIT-POUR-02", "GLS-AUR-01"), { nil: null }),
    qty: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
    policyId: fc.constantFrom(...POLICY_IDS),
    policyVersion: fc.constantFrom("2024.1", "2025.1", "2026.1"),
    approvedBy: fc.constantFrom("AUTO_GATE", "supervisor:demo"),
    issuedAt: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
  })
  .map((p) => ({ v: 1 as const, currency: "USD" as const, ...p, expiresAt: p.issuedAt + AGENT.tokenTtlSeconds }));

function mutateField(p: TokenPayload, field: (typeof SIGN_FIELDS)[number]): TokenPayload {
  const cur = p[field] as unknown;
  const next = typeof cur === "number" ? cur + 1 : typeof cur === "string" ? (field === "action" ? (cur === "refund" ? "store_credit" : "refund") : `${cur}x`) : 1;
  return { ...p, [field]: next } as TokenPayload;
}

const TOKEN_ORDERS = ["ORD-8820", "ORD-8821", "ORD-9941"] as const;
const mintSpecArb = fc.record({
  thread: fc.integer({ min: 0, max: 1 }),
  action: fc.constantFrom<TokenAction>("refund", "store_credit", "replacement", "return_label"),
  order: fc.integer({ min: 0, max: 2 }),
  creditWithoutOrder: fc.boolean(),
  amountCents: fc.integer({ min: 1, max: 500_000 }),
  sku: fc.constantFrom("KIT-POUR-02", "GLS-AUR-01"),
  qty: fc.integer({ min: 1, max: 3 }),
  // Issued this many seconds ago. TTL is 900 s: 0..600 is live for >= 5 min, >= 1200 is expired (no boundary flakes).
  agoSec: fc.oneof({ arbitrary: fc.integer({ min: 0, max: 600 }), weight: 3 }, { arbitrary: fc.integer({ min: 1200, max: 5000 }), weight: 1 }),
});
type MintSpec = ReturnType<typeof mintSpecArb.generate>["value"];

const MUTATIONS = ["none", "thread", "action", "order", "amount", "sku", "qty"] as const;
const tokenOpArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("mint" as const), m: mintSpecArb }) },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("exec" as const),
      ref: fc.nat(),
      mutate: fc.oneof({ arbitrary: fc.constant("none" as const), weight: 4 }, { arbitrary: fc.constantFrom(...MUTATIONS), weight: 3 }),
      key: fc.oneof({ arbitrary: fc.constant("fresh" as const), weight: 3 }, { arbitrary: fc.nat(), weight: 1 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("reuse" as const), ref: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("replay" as const), ref: fc.nat(), keyRef: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("race" as const), ref: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("forge" as const), how: fc.constantFrom("random_id", "null", "wrong_secret", "tamper", "foreign_sandbox"), ref: fc.nat(), m: mintSpecArb }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("revoke" as const), thread: fc.integer({ min: 0, max: 1 }) }) },
);

type ModelToken = { tokenId: string; scope: GuardScope; status: "issued" | "consumed" | "revoked"; badSig: boolean; expired: boolean; foreign: boolean };

function scopeFor(m: MintSpec, sandboxId: string, threads: string[]): GuardScope {
  const orderId = m.action === "store_credit" && m.creditWithoutOrder ? null : TOKEN_ORDERS[m.order];
  const money = m.action === "refund" || m.action === "store_credit";
  return {
    sandboxId,
    threadId: threads[m.thread],
    action: m.action,
    orderId,
    amountCents: money ? m.amountCents : null,
    sku: m.action === "replacement" ? m.sku : null,
    qty: m.action === "replacement" ? m.qty : null,
  };
}

function mutateScope(scope: GuardScope, how: (typeof MUTATIONS)[number], threads: string[]): GuardScope {
  switch (how) {
    case "none":
      return scope;
    case "thread":
      return { ...scope, threadId: scope.threadId === threads[0] ? threads[1] : threads[0] };
    case "action":
      return { ...scope, action: scope.action === "refund" ? "store_credit" : "refund" };
    case "order":
      return { ...scope, orderId: scope.orderId === "ORD-8820" ? "ORD-8821" : "ORD-8820" };
    case "amount":
      return { ...scope, amountCents: (scope.amountCents ?? 0) + 1 };
    case "sku":
      return { ...scope, sku: "OTHER-SKU" };
    case "qty":
      return { ...scope, qty: (scope.qty ?? 0) + 1 };
  }
}

/** Everything wrong with presenting `scope` + this token, as guard codes. Empty = must succeed. */
function defectsOf(t: ModelToken | null, scope: GuardScope): GuardCode[] {
  if (!t || t.foreign) return ["TOKEN_MISSING"];
  const p = t.scope;
  const d: GuardCode[] = [];
  if (t.badSig) d.push("TOKEN_BAD_SIGNATURE");
  if (
    p.threadId !== scope.threadId ||
    p.action !== scope.action ||
    (p.orderId ?? null) !== (scope.orderId ?? null) ||
    (p.sku ?? null) !== (scope.sku ?? null) ||
    (p.qty ?? null) !== (scope.qty ?? null)
  ) {
    d.push("TOKEN_SCOPE_MISMATCH");
  }
  if ((p.amountCents ?? null) !== (scope.amountCents ?? null)) d.push("TOKEN_AMOUNT_MISMATCH");
  if (t.status === "consumed") d.push("TOKEN_ALREADY_USED");
  if (t.status === "revoked") d.push("TOKEN_REVOKED");
  if (t.expired) d.push("TOKEN_EXPIRED");
  return d;
}

const ATTACKER_SECRET = "attacker-controlled-secret-0123456789abcdef";

describe("(b) approval tokens are single-use at the tool boundary", () => {
  it("pure: a token signature binds every field; key order is irrelevant; forged signatures never verify", () => {
    // numRuns: 3000 (pure).
    fc.assert(
      fc.property(payloadArb, fc.constantFrom(...SIGN_FIELDS), fc.stringMatching(/^[0-9a-f]{64}$/), (p, field, randomSig) => {
        const sig = signPayload(p);
        expect(signatureValid(p, sig)).toBe(true);
        const reordered = Object.fromEntries(Object.entries(p).reverse()) as TokenPayload;
        expect(signatureValid(reordered, sig)).toBe(true);
        expect(signatureValid(mutateField(p, field), sig)).toBe(false);
        expect(signatureValid(p, hmacHex(canonicalize(p), ATTACKER_SECRET))).toBe(false);
        if (randomSig !== sig) expect(signatureValid(p, randomSig)).toBe(false);
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it("DB: random mint/execute/replay/race/forge/revoke sequences — no state change without a valid, unused, matching token", async () => {
    // numRuns: 300 (DB-backed; a fresh sandbox + up to 14 guarded calls per case, ~9-11 s).
    const otherSb = await freshSandbox(); // source of foreign-sandbox tokens only; never written by the calls under test
    const foreignTokenIds: string[] = [];

    await fc.assert(
      fc.asyncProperty(fc.array(mintSpecArb, { minLength: 1, maxLength: 2 }), fc.array(tokenOpArb, { minLength: 1, maxLength: 12 }), async (firstMints, rest) => {
        const ops = [...firstMints.map((m) => ({ k: "mint" as const, m })), ...rest];
        const sb = await freshSandbox();
        const threads = [thr(), thr()];
        const toks: ModelToken[] = [];
        const usedKeys: string[] = [];
        const stored = new Map<string, Record<string, unknown>>();
        const actionCalls: string[] = [];
        let successes = 0;
        let rowSeq = 0;

        // The state change under guard: a refund row bound to the token that authorized it.
        const action = async (tx: Tx, token: TokenPayload) => {
          actionCalls.push(token.tokenId);
          const rowId = `PRB-${++rowSeq}`;
          await tx.insert(s.refunds).values({ sandboxId: sb, id: rowId, orderId: token.orderId ?? "NONE", amountCents: token.amountCents ?? 0, reason: "prop-b", tokenId: token.tokenId });
          return { rowId, tokenId: token.tokenId };
        };
        const call = (tokenId: string | null, scope: GuardScope, key: string) =>
          guardedExecute(db(), { scope, tokenId, idempotencyKey: key, operation: "prop.exec" }, action).then(
            (out) => ({ ok: true as const, out }),
            (err: unknown) => ({ ok: false as const, err }),
          );

        const mint = async (m: MintSpec, sandboxId: string) => {
          const scope = scopeFor(m, sandboxId, threads);
          const { tokenId } = await mintToken(
            db(),
            { sandboxId, threadId: scope.threadId, action: scope.action, orderId: scope.orderId, amountCents: scope.amountCents, sku: scope.sku ?? null, qty: scope.qty ?? null, policyId: "RETURNS_STANDARD", policyVersion: "2026.1", approvedBy: "AUTO_GATE" },
            Date.now() - m.agoSec * 1000,
          );
          return { tokenId, scope: { ...scope, sandboxId: sb }, expired: m.agoSec > AGENT.tokenTtlSeconds };
        };

        /** Executes once and checks the outcome against the model, then updates the model. */
        const execAndCheck = async (t: ModelToken | null, tokenId: string | null, scope: GuardScope, key: string) => {
          const before = actionCalls.length;
          const r = await call(tokenId, scope, key);
          usedKeys.push(key);
          if (stored.has(key)) {
            // A repeated idempotency key returns the stored response and changes nothing.
            expect(r.ok).toBe(true);
            if (r.ok) {
              expect(r.out.replayed).toBe(true);
              expect(r.out.result).toEqual(stored.get(key));
            }
            expect(actionCalls.length).toBe(before);
            return;
          }
          const defects = defectsOf(t, scope);
          if (defects.length === 0) {
            expect(r.ok, `valid token ${tokenId} was rejected: ${!r.ok ? String((r as { err: unknown }).err) : ""}`).toBe(true);
            if (!r.ok) return;
            expect(r.out.replayed).toBe(false);
            expect(actionCalls.length).toBe(before + 1);
            expect(actionCalls[before]).toBe(tokenId);
            t!.status = "consumed";
            stored.set(key, r.out.result);
            successes++;
          } else {
            expect(r.ok, `call with defects [${defects}] succeeded`).toBe(false);
            if (r.ok) return;
            expect(r.err).toBeInstanceOf(GuardError);
            expect(defects).toContain((r.err as GuardError).code);
            expect(actionCalls.length).toBe(before);
          }
        };

        const pick = (ref: number) => (toks.length ? toks[ref % toks.length] : null);
        const fallbackScope: GuardScope = { sandboxId: sb, threadId: threads[0], action: "refund", orderId: "ORD-8820", amountCents: 100, sku: null, qty: null };

        for (const op of ops) {
          switch (op.k) {
            case "mint": {
              const m = await mint(op.m, sb);
              toks.push({ tokenId: m.tokenId, scope: m.scope, status: "issued", badSig: false, expired: m.expired, foreign: false });
              break;
            }
            case "exec": {
              const t = pick(op.ref);
              const scope = t ? mutateScope(t.scope, op.mutate, threads) : fallbackScope;
              const key = op.key === "fresh" || usedKeys.length === 0 ? `k-${randomUUID()}` : usedKeys[op.key % usedKeys.length];
              await execAndCheck(t, t?.tokenId ?? null, scope, key);
              break;
            }
            case "reuse": {
              // Present an already-consumed token again, exactly as approved, under a fresh key.
              const used = toks.filter((t) => t.status === "consumed");
              const t = used.length ? used[op.ref % used.length] : pick(op.ref);
              await execAndCheck(t, t?.tokenId ?? null, t?.scope ?? fallbackScope, `k-${randomUUID()}`);
              break;
            }
            case "replay": {
              // Re-send an already-committed call's key (possibly with a different token): stored response, no change.
              const keys = [...stored.keys()];
              const t = pick(op.ref);
              const key = keys.length ? keys[op.keyRef % keys.length] : `k-${randomUUID()}`;
              await execAndCheck(t, t?.tokenId ?? null, t?.scope ?? fallbackScope, key);
              break;
            }
            case "race": {
              // The same token presented twice concurrently: the row lock lets at most one through.
              const t = pick(op.ref);
              if (!t) break;
              const defects = defectsOf(t, t.scope);
              const before = actionCalls.length;
              const keys = [`k-${randomUUID()}`, `k-${randomUUID()}`];
              const results = await Promise.all(keys.map((k) => call(t.tokenId, t.scope, k)));
              usedKeys.push(...keys);
              const oks = results.filter((x) => x.ok);
              if (defects.length === 0) {
                expect(oks).toHaveLength(1);
                const loser = results.find((x) => !x.ok) as { err: unknown };
                expect(loser.err).toBeInstanceOf(GuardError);
                expect((loser.err as GuardError).code).toBe("TOKEN_ALREADY_USED");
                t.status = "consumed";
                const winIdx = results.findIndex((x) => x.ok);
                stored.set(keys[winIdx], (results[winIdx] as { out: { result: Record<string, unknown> } }).out.result);
                successes++;
                expect(actionCalls.length).toBe(before + 1);
              } else {
                expect(oks).toHaveLength(0);
                for (const x of results) expect(defects).toContain(((x as { err: unknown }).err as GuardError).code);
                expect(actionCalls.length).toBe(before);
              }
              break;
            }
            case "forge": {
              if (op.how === "random_id" || op.how === "null") {
                await execAndCheck(null, op.how === "null" ? null : randomUUID(), scopeFor(op.m, sb, threads), `k-${randomUUID()}`);
              } else if (op.how === "wrong_secret") {
                // A self-made token row: well-formed, scoped exactly to the call, signed with the wrong key.
                const scope = scopeFor(op.m, sb, threads);
                const issuedAt = Math.floor(Date.now() / 1000);
                const payload: TokenPayload = {
                  v: 1, tokenId: randomUUID(), sandboxId: sb, threadId: scope.threadId, action: scope.action, orderId: scope.orderId, amountCents: scope.amountCents,
                  sku: scope.sku ?? null, qty: scope.qty ?? null, currency: "USD", policyId: "RETURNS_STANDARD", policyVersion: "2026.1", approvedBy: "AUTO_GATE",
                  issuedAt, expiresAt: issuedAt + AGENT.tokenTtlSeconds,
                };
                await db().insert(s.approvalTokens).values({
                  tokenId: payload.tokenId, sandboxId: sb, threadId: payload.threadId, action: payload.action, payload: payload as unknown as Record<string, unknown>,
                  signature: hmacHex(canonicalize(payload), ATTACKER_SECRET), status: "issued", issuedAt: new Date(issuedAt * 1000), expiresAt: new Date(payload.expiresAt * 1000),
                });
                const t: ModelToken = { tokenId: payload.tokenId, scope, status: "issued", badSig: true, expired: false, foreign: false };
                toks.push(t);
                await execAndCheck(t, t.tokenId, scope, `k-${randomUUID()}`);
              } else if (op.how === "tamper") {
                // Inflate a stored token's payload in place (DB write access, no signing key), then use it.
                const t = toks.filter((x) => !x.foreign).length ? toks.filter((x) => !x.foreign)[op.ref % toks.filter((x) => !x.foreign).length] : null;
                if (!t) break;
                if (t.scope.amountCents !== null) {
                  const inflated = t.scope.amountCents + 1_000_000;
                  await db().execute(sql`UPDATE approval_tokens SET payload = jsonb_set(payload, '{amountCents}', to_jsonb(${inflated}::int)) WHERE token_id = ${t.tokenId}`);
                  t.scope = { ...t.scope, amountCents: inflated };
                } else {
                  await db().execute(sql`UPDATE approval_tokens SET payload = jsonb_set(payload, '{orderId}', to_jsonb('ORD-0001'::text)) WHERE token_id = ${t.tokenId}`);
                  t.scope = { ...t.scope, orderId: "ORD-0001" };
                }
                t.badSig = true;
                await execAndCheck(t, t.tokenId, t.scope, `k-${randomUUID()}`);
              } else {
                // A genuine, unused token minted for another visitor's sandbox.
                const m = await mint(op.m, otherSb);
                foreignTokenIds.push(m.tokenId);
                const t: ModelToken = { tokenId: m.tokenId, scope: m.scope, status: "issued", badSig: false, expired: m.expired, foreign: true };
                toks.push(t);
                await execAndCheck(t, t.tokenId, t.scope, `k-${randomUUID()}`);
              }
              break;
            }
            case "revoke": {
              await revokeIssuedTokens(db(), sb, threads[op.thread]);
              for (const t of toks) if (!t.foreign && t.scope.threadId === threads[op.thread] && t.status === "issued") t.status = "revoked";
              break;
            }
          }
        }

        // Ledger of state changes vs tokens: one row per successful call, at most one per token.
        const rows = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.reason, "prop-b")));
        expect(rows).toHaveLength(successes);
        const perToken = new Map<string, number>();
        for (const r of rows) perToken.set(r.tokenId!, (perToken.get(r.tokenId!) ?? 0) + 1);
        for (const [tokenId, n] of perToken) {
          expect(n, `token ${tokenId} authorized ${n} state changes`).toBe(1);
          expect(toks.find((t) => t.tokenId === tokenId)?.status).toBe("consumed");
        }
        const tokenRows = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb));
        for (const t of toks.filter((x) => !x.foreign)) {
          const row = tokenRows.find((r) => r.tokenId === t.tokenId)!;
          expect(row.status, t.tokenId).toBe(t.status);
          expect(row.consumedAt !== null).toBe(t.status === "consumed");
          expect(perToken.get(t.tokenId) ?? 0).toBe(t.status === "consumed" ? 1 : 0);
        }
        const keys = await db().select().from(s.idempotencyKeys).where(and(eq(s.idempotencyKeys.sandboxId, sb), eq(s.idempotencyKeys.operation, "prop.exec")));
        expect(keys).toHaveLength(successes);
      }),
      { seed: SEED, numRuns: 300, endOnFailure: true },
    );

    if (foreignTokenIds.length) {
      const foreign = await db().select().from(s.approvalTokens).where(inArray(s.approvalTokens.tokenId, foreignTokenIds));
      expect(foreign.map((t) => t.status)).toEqual(foreign.map(() => "issued"));
    }
  }, 60_000);
});

// =============================================================================================
// (c) saga: refunds never exceed what was paid; at most one refund per saga
// =============================================================================================

describe("(c) saga money invariants under faults", () => {
  const approvedArb: fc.Arbitrary<ApprovedAction[]> = fc.array(
    fc.oneof(
      fc.record({ type: fc.constant("refund" as const), orderId: fc.constantFrom("ORD-8820", "ORD-9941"), amountCents: fc.integer({ min: 1, max: 10_000_000 }), reason: fc.constantFrom(...REFUND_REASONS) }),
      fc.record({ type: fc.constant("store_credit" as const), amountCents: fc.integer({ min: 1, max: 100_000 }), reason: fc.constantFrom(...CREDIT_REASONS), orderId: fc.option(fc.constant("ORD-8820"), { nil: undefined }) }),
      fc.record({ type: fc.constant("replacement" as const), orderId: fc.constant("ORD-8820"), sku: fc.constant("KIT-POUR-02"), qty: fc.integer({ min: 1, max: 3 }) }),
      fc.record({ type: fc.constant("return_label" as const), orderId: fc.constant("ORD-8820") }),
      fc.constant({ type: "escalate" as const, reason: "specialist" }),
    ).chain((action) => fc.option(fc.uuid(), { nil: null }).map((tokenId) => ({ action: action as Action, tokenId }))),
    { maxLength: 7 },
  );

  it("pure: a saga plan has at most one refund step, it is the pivot, and every reversible step runs before it", () => {
    // numRuns: 3000 (pure). Plans include several refunds (a malicious or buggy approval path).
    fc.assert(
      fc.property(approvedArb, (actions) => {
        const plan: SagaPlan = { sandboxId: "sb", threadId: "thr", customerId: "CUS-1002", customerName: "Daniel Okafor", primaryOrderId: "ORD-8820", actions, subject: "s" };
        const steps = buildSteps(plan);
        const refunds = steps.filter((st) => st.name === "billing.refund");
        const firstRefund = actions.find((a) => a.action.type === "refund");
        expect(refunds).toHaveLength(firstRefund ? 1 : 0);
        if (firstRefund) {
          const a = firstRefund.action as Extract<Action, { type: "refund" }>;
          expect(refunds[0].kind).toBe("pivot");
          expect(refunds[0].args).toEqual({ orderId: a.orderId, amountCents: a.amountCents, reason: a.reason });
          expect(refunds[0].tokenId).toBe(firstRefund.tokenId);
        }
        expect(steps.filter((st) => st.name === "billing.issueStoreCredit").length).toBeLessThanOrEqual(1);
        expect(steps.map((st) => st.seq)).toEqual(steps.map((_, i) => i + 1));
        expect(steps[0].name).toBe("tickets.create");
        expect(steps.slice(-2).map((st) => st.name)).toEqual(["tickets.resolve", "tickets.notify"]);
        const pivots = steps.filter((st) => st.kind === "pivot");
        const hasPivotable = actions.some((a) => ["refund", "store_credit", "replacement"].includes(a.action.type));
        expect(pivots).toHaveLength(hasPivotable ? 1 : 0);
        if (pivots.length) {
          for (const st of steps) {
            if (st.kind === "reversible") expect(st.seq).toBeLessThan(pivots[0].seq);
            if (st.kind === "retriable") expect(st.seq).toBeGreaterThan(pivots[0].seq);
          }
        }
      }),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it("pure: the retry layer retries only 429/5xx, stops at maxAttempts, and one idempotency key commits at most once", async () => {
    // numRuns: 2000 (pure). An in-memory idempotent ledger stands in for the billing mock; the retry
    // policy (withRetry / isRetryable / outcomeUnknown) is the real implementation.
    const MODES = ["ok", "fail_503", "rate_limit_429", "timeout_pre", "commit_then_timeout", "schema_drift", "bad_request"] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...MODES), { maxLength: 6 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 150_000 }),
        async (script, paid, refundedPermille, amount) => {
          const KEY = "idem-key";
          const ledger = new Map<string, number>();
          let refunded = Math.floor((paid * refundedPermille) / 1000);
          const seen: unknown[] = [];
          let calls = 0;
          const service = async () => {
            const f = script[calls++] ?? "ok";
            try {
              if (f === "fail_503") throw new ServiceError(503, "UNAVAILABLE", "503", undefined, true);
              if (f === "rate_limit_429") throw new ServiceError(429, "RATE_LIMITED", "429", 1000, true);
              if (f === "timeout_pre") throw new ServiceError(504, "TIMEOUT", "timeout", undefined, true);
              if (f === "bad_request") throw new ServiceError(400, "INVALID", "bad request");
              if (!ledger.has(KEY)) {
                if (amount > paid - refunded) throw new ServiceError(422, "INVALID", "exceeds refundable balance");
                ledger.set(KEY, amount);
                refunded += amount;
              }
              if (f === "commit_then_timeout") throw new ServiceError(504, "TIMEOUT", "committed, response lost", undefined, true);
              if (f === "schema_drift") throw new ServiceError(502, "UPSTREAM_SCHEMA_MISMATCH", "drift", undefined, true);
              seen.push(null);
              return { amountCents: ledger.get(KEY)! };
            } catch (e) {
              seen.push(e);
              throw e;
            }
          };
          const out = await withRetry(service, { sleep: instant.sleep, random: instant.random }).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
          );
          expect(calls).toBeLessThanOrEqual(AGENT.retry.maxAttempts);
          expect(ledger.size).toBeLessThanOrEqual(1);
          expect(refunded).toBeLessThanOrEqual(paid);
          // Every attempt but the last failed with a retryable error.
          for (const e of seen.slice(0, -1)) expect(isRetryable(e)).toBe(true);
          if (out.ok) {
            expect(out.v.value.amountCents).toBe(amount);
            expect(ledger.get(KEY)).toBe(amount);
            expect(out.v.attempts).toBe(calls);
          } else {
            expect(out.e).toBe(seen[seen.length - 1]);
            expect((out.e as { attempts?: number }).attempts).toBe(calls);
            if (isRetryable(out.e)) expect(calls).toBe(AGENT.retry.maxAttempts);
            // A definite pre-commit failure on the only attempt means nothing was committed.
            if (calls === 1 && !outcomeUnknown(out.e)) expect(ledger.size).toBe(0);
          }
        },
      ),
      { seed: SEED, numRuns: 2000 },
    );
  });

  const SAGA_ORDERS = [
    { customerId: "CUS-1002", name: "Daniel Okafor", orderId: "ORD-8820", sku: "KIT-POUR-02" },
    { customerId: "CUS-1003", name: "Priya Raman", orderId: "ORD-8821", sku: "MUG-STN-04" },
    { customerId: "CUS-1004", name: "Tomás Vidal", orderId: "ORD-8822", sku: "SKL-CI-12" },
    { customerId: "CUS-1001", name: "Sarah Jenkins", orderId: "ORD-9941", sku: "GLS-AUR-01" },
  ] as const;

  const FAULT_TARGETS: [ServiceName, string][] = [
    ["tickets", "create"], ["tickets", "addNote"], ["tickets", "close"], ["tickets", "cancel"], ["tickets", "notify"],
    ["orders", "reserveInventory"], ["orders", "releaseInventory"], ["orders", "createReplacementDraft"], ["orders", "cancelDraft"], ["orders", "confirmReplacement"],
    ["billing", "refund"], ["billing", "refund"], ["billing", "refund"], ["billing", "issueStoreCredit"],
    ["carrier_a", "createReturnLabel"], ["carrier_a", "voidLabel"], ["carrier_b", "createReturnLabel"], ["carrier_b", "voidLabel"],
  ];
  const FAULT_MODES: FaultMode[] = ["healthy", "fail_503", "rate_limit_429", "timeout", "commit_then_timeout", "schema_drift", "fail_n_times"];
  const faultArb = fc.record({ target: fc.constantFrom(...FAULT_TARGETS), mode: fc.constantFrom(...FAULT_MODES), n: fc.integer({ min: 1, max: 4 }) });
  type FaultSpec = ReturnType<typeof faultArb.generate>["value"];
  const applyFault = (sb: string, f: FaultSpec) => fault(sb, f.target[0], f.target[1], f.mode, f.mode === "fail_n_times" ? f.n : undefined);

  const sagaSpecArb = fc.record({
    refund: fc.option(
      fc.record({
        amount: fc.oneof(
          { arbitrary: fc.integer({ min: 1, max: 6000 }), weight: 3 },
          { arbitrary: fc.constantFrom("paid", "half", "rest", "rest", "rest+1"), weight: 2 },
          { arbitrary: fc.integer({ min: 1, max: 80_000 }), weight: 1 },
        ),
        reason: fc.constantFrom("damaged", "duplicate_charge", "return"),
      }),
      { nil: null, freq: 6 },
    ),
    extraRefund: fc.option(fc.integer({ min: 1, max: 80_000 }), { nil: null, freq: 2 }), // a 2nd refund in the same plan
    replacementQty: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
    label: fc.boolean(),
    credit: fc.option(fc.record({ amount: fc.integer({ min: 100, max: 3000 }), withOrder: fc.boolean() }), { nil: null, freq: 3 }),
    escalate: fc.boolean(),
    faults: fc.array(faultArb, { maxLength: 3 }),
    // Fault changes applied on successive retry sleeps: faults that change between attempts.
    switches: fc.option(fc.array(fc.option(faultArb, { nil: null }), { minLength: 1, maxLength: 4 }), { nil: null, freq: 4 }),
    replay: fc.boolean(),
  });
  const sagaRunArb = fc.record({ scenario: fc.integer({ min: 0, max: SAGA_ORDERS.length - 1 }), sagas: fc.array(sagaSpecArb, { minLength: 1, maxLength: 3 }) });

  async function balances(sb: string) {
    const res = await db().execute<{ id: string; paid: number; refunded: number }>(sql`
      SELECT o.id,
        COALESCE((SELECT sum(c.amount_cents) FROM charges c WHERE c.sandbox_id = o.sandbox_id AND c.order_id = o.id), 0)::int AS paid,
        COALESCE((SELECT sum(r.amount_cents) FROM refunds r WHERE r.sandbox_id = o.sandbox_id AND r.order_id = o.id), 0)::int AS refunded
      FROM orders o WHERE o.sandbox_id = ${sb}`);
    return res.rows;
  }

  async function mintFor(sb: string, threadId: string, a: Action): Promise<string | null> {
    if (a.type !== "refund" && a.type !== "store_credit" && a.type !== "replacement" && a.type !== "return_label") return null;
    const { tokenId } = await mintToken(db(), {
      sandboxId: sb,
      threadId,
      action: a.type,
      orderId: "orderId" in a && a.orderId ? a.orderId : null,
      amountCents: "amountCents" in a ? a.amountCents : null,
      sku: a.type === "replacement" ? a.sku : null,
      qty: a.type === "replacement" ? a.qty : null,
      policyId: "DAMAGE_TRANSIT",
      policyVersion: "2026.1",
      approvedBy: "AUTO_GATE",
    });
    return tokenId;
  }

  it("DB: per order refunds never exceed paid and each saga refunds at most once, across random faults on random steps", async () => {
    // numRuns: 180 (DB-backed; fresh sandbox, 1-3 sagas, up to 3 static faults + optional fault switches per saga, ~11-14 s).
    // Tokens are minted for every planned action — including refunds larger than the balance and a second
    // refund in the same plan — as if the gate were bypassed, so the saga + billing mock alone must hold the line.
    await fc.assert(
      fc.asyncProperty(sagaRunArb, async ({ scenario, sagas }) => {
        const sb = await freshSandbox();
        const sc = SAGA_ORDERS[scenario];
        const seenSagaIds = new Set<string>();

        for (const spec of sagas) {
          const threadId = thr();
          const bal0 = (await balances(sb)).find((b) => b.id === sc.orderId)!;
          const available = bal0.paid - bal0.refunded;
          const resolve = (x: number | string) =>
            typeof x === "number" ? x : x === "paid" ? bal0.paid : x === "half" ? Math.max(1, Math.floor(bal0.paid / 2)) : x === "rest" ? Math.max(1, available) : available + 1;

          const actions: Action[] = [];
          if (spec.replacementQty) actions.push({ type: "replacement", orderId: sc.orderId, sku: sc.sku, qty: spec.replacementQty, reason: "damaged" });
          if (spec.label) actions.push({ type: "return_label", orderId: sc.orderId, reason: "damaged" });
          if (spec.refund) actions.push({ type: "refund", orderId: sc.orderId, amountCents: resolve(spec.refund.amount), reason: spec.refund.reason as "damaged" });
          if (spec.extraRefund) actions.push({ type: "refund", orderId: sc.orderId, amountCents: spec.extraRefund, reason: "goodwill" });
          // The saga may only ever execute the FIRST refund of a plan.
          const firstRefund = actions.find((a): a is Extract<Action, { type: "refund" }> => a.type === "refund");
          const refundAmount = firstRefund?.amountCents ?? null;
          if (spec.credit) actions.push({ type: "store_credit", amountCents: spec.credit.amount, reason: "goodwill", ...(spec.credit.withOrder ? { orderId: sc.orderId } : {}) });
          if (spec.escalate) actions.push({ type: "escalate", reason: "Customer asked for a manager" });
          const approved: ApprovedAction[] = [];
          for (const a of actions) approved.push({ action: a, tokenId: await mintFor(sb, threadId, a) });
          const plan: SagaPlan = { sandboxId: sb, threadId, customerId: sc.customerId, customerName: sc.name, primaryOrderId: sc.orderId, actions: approved, subject: "Property-based saga" };

          for (const f of spec.faults) await applyFault(sb, f);
          let sleeps = 0;
          let switched = false;
          const hooks = {
            random: instant.random,
            sleep: async () => {
              const next = spec.switches?.[sleeps++];
              if (next) {
                await applyFault(sb, next);
                switched = true;
              }
            },
          };
          const summary: SagaSummary = await runSaga({ db: db(), sandboxId: sb, ...hooks }, plan);
          expect(seenSagaIds.has(summary.sagaId)).toBe(false);
          seenSagaIds.add(summary.sagaId);

          const sagaRefunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.sagaId, summary.sagaId)));
          expect(sagaRefunds.length, `saga ${summary.sagaId} refunds`).toBeLessThanOrEqual(1);
          const refundTokenId = approved.find((a) => a.action.type === "refund")?.tokenId ?? null;
          if (sagaRefunds.length === 1) {
            expect(refundAmount).not.toBeNull();
            expect(sagaRefunds[0].amountCents).toBe(refundAmount);
            expect(sagaRefunds[0].amountCents).toBeLessThanOrEqual(available);
            expect(sagaRefunds[0].orderId).toBe(sc.orderId);
            expect(sagaRefunds[0].tokenId).toBe(refundTokenId);
          }
          if (refundAmount !== null && refundAmount > available) expect(sagaRefunds).toHaveLength(0);
          // The second refund in the plan never executes: its token stays unused.
          const extra = approved.filter((a) => a.action.type === "refund")[1];
          if (extra?.tokenId) {
            const row = (await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.tokenId, extra.tokenId)))[0];
            expect(row.status).toBe("issued");
          }
          if (!switched) {
            // With faults that hold still, the saga's reported outcome agrees with the ledger.
            if (refundAmount !== null && (summary.status === "DONE" || summary.status === "REFUNDED_PENDING_FULFILLMENT")) expect(sagaRefunds).toHaveLength(1);
            if (summary.status === "ROLLED_BACK" || summary.status === "COMPENSATION_FAILED") expect(sagaRefunds).toHaveLength(0);
          }
          const runs = await db().select().from(s.sagaRuns).where(and(eq(s.sagaRuns.sandboxId, sb), eq(s.sagaRuns.threadId, threadId)));
          expect(runs).toHaveLength(1);

          if (spec.replay) {
            // Re-submitting the same plan finds the finished saga instead of running it again.
            const again = await runSaga({ db: db(), sandboxId: sb, ...instant }, plan);
            expect(again.sagaId).toBe(summary.sagaId);
            expect(again.status).toBe(summary.status);
            const after = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.sagaId, summary.sagaId)));
            expect(after).toHaveLength(sagaRefunds.length);
          }
        }

        for (const b of await balances(sb)) expect(b.refunded, `order ${b.id} refunded more than paid`).toBeLessThanOrEqual(b.paid);
        const refundTokens = await db().select().from(s.approvalTokens).where(and(eq(s.approvalTokens.sandboxId, sb), eq(s.approvalTokens.action, "refund")));
        const refundRows = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), inArray(s.refunds.sagaId, [...seenSagaIds])));
        for (const t of refundTokens) {
          expect(t.status === "consumed", `refund token ${t.tokenId}`).toBe(refundRows.some((r) => r.tokenId === t.tokenId));
        }
      }),
      { seed: SEED, numRuns: 180, endOnFailure: true },
    );
  }, 60_000);

  // BUG (src/lib/services/billing.ts refund(), via src/lib/security/tool-guard.ts guardedExecute()): the
  // "never refund more than was paid" balance check reads SUM(charges) - SUM(refunds) with a plain SELECT
  // and nothing serializes two refunds for the SAME order — guardedExecute only row-locks the token being
  // used, and two threads hold two different tokens. Under READ COMMITTED both transactions read the same
  // balance, both pass, both insert. Expected: total refunds for ORD-8820 <= $41.00 paid. Actual: $82.00.
  // Repro (deterministic): two valid refund tokens for ORD-8820 ($41.00 each, two threads); hold the
  // sandbox's RF id_counters row lock so both calls park after their balance check; release; both commit.
  // Fix idea: lock the order row (SELECT ... FROM orders ... FOR UPDATE) or take
  // pg_advisory_xact_lock(hashtext(sandbox_id || order_id)) before reading the balance.
  it("two concurrent refunds on one order (two threads, two valid tokens) can exceed the amount paid", async () => {
    const sb = await freshSandbox();
    const orderId = "ORD-8820";
    const paid = (await balances(sb)).find((b) => b.id === orderId)!.paid;
    expect(paid).toBe(4100);
    const threads = [thr(), thr()];
    const tokens = await Promise.all(threads.map((t) => mintFor(sb, t, { type: "refund", orderId, amountCents: paid, reason: "damaged" })));

    const pool = createPool(process.env.DATABASE_URL!, 1);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT value FROM id_counters WHERE sandbox_id = $1 AND prefix = 'RF' FOR UPDATE", [sb]);
      const calls = threads.map((t, i) =>
        billing
          .refund({ db: db(), sandboxId: sb }, { threadId: t, sagaId: `race-${i}`, tokenId: tokens[i], idempotencyKey: `race-${t}`, orderId, amountCents: paid, reason: "damaged" })
          .then(() => "ok", (e: unknown) => (e instanceof Error ? e.message : String(e))),
      );
      // Wait (max 3 s) until both refund transactions are parked, directly or transitively, behind our lock
      // (a second row-lock waiter queues behind the first waiter, not behind us). A correctly serialized
      // implementation would park the second call behind the first one before its balance read instead.
      for (let i = 0; i < 60; i++) {
        const n = (
          await blocker.query<{ n: number }>(
            "WITH RECURSIVE chain(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))) SELECT (count(*) - 1)::int AS n FROM chain",
            [pid],
          )
        ).rows[0].n;
        if (n >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await blocker.query("COMMIT");
      const outcomes = await Promise.all(calls);
      const refunded = (await balances(sb)).find((b) => b.id === orderId)!.refunded;
      expect(refunded, `outcomes: ${outcomes.join(" | ")}`).toBeLessThanOrEqual(paid);
    } finally {
      blocker.release();
      await pool.end();
    }
  });

  // BUG (src/lib/saga/orchestrator.ts executeStep(), catch block): an unknown outcome at the pivot is
  // reconciled only when the FINAL attempt's error is outcomeUnknown (TIMEOUT / schema mismatch). When an
  // earlier attempt committed but its response was lost and the remaining retries fail with a definite
  // retryable error (503), withRetry throws the 503, the pivot is marked FAILED without reading the ledger,
  // and the saga rolls back to ROLLED_BACK — while the refund exists and its token is consumed. The ticket
  // then says ROLLED_BACK and the customer is told every step was reversed although money moved.
  // Expected: a saga whose refund committed is never ROLLED_BACK (reconcile whenever ANY attempt had an
  // unknown outcome). Actual: status ROLLED_BACK with one refund row for the saga.
  // Repro: billing.refund = commit_then_timeout; on the first retry sleep switch it to fail_503.
  it("a pivot refund committed on an earlier attempt is not reconciled when the last attempt fails with 503", async () => {
    const sb = await freshSandbox();
    const threadId = thr();
    const action: Action = { type: "refund", orderId: "ORD-8820", amountCents: 700, reason: "damaged" };
    const tokenId = await mintFor(sb, threadId, action);
    await fault(sb, "billing", "refund", "commit_then_timeout");
    let sleeps = 0;
    const hooks = {
      random: instant.random,
      sleep: async () => {
        if (sleeps++ === 0) await fault(sb, "billing", "refund", "fail_503");
      },
    };
    const summary = await runSaga(
      { db: db(), sandboxId: sb, ...hooks },
      { sandboxId: sb, threadId, customerId: "CUS-1002", customerName: "Daniel Okafor", primaryOrderId: "ORD-8820", actions: [{ action, tokenId }], subject: "lost response then 503" },
    );
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.sagaId, summary.sagaId)));
    expect(refunds).toHaveLength(1); // the first attempt committed (precondition of the bug)
    expect(summary.status).not.toBe("ROLLED_BACK");
    expect(summary.steps.find((st) => st.name === "billing.refund")?.status).toBe("DONE");
  });
});

// =============================================================================================
// (d) rejected approvals change nothing, (e) replayed resumes never re-run the saga
// =============================================================================================

const BUSINESS_TABLES = [
  "approval_tokens", "charges", "customers", "id_counters", "idempotency_keys", "inventory", "inventory_holds", "labels", "notifications",
  "order_items", "orders", "outbox", "refunds", "replacement_drafts", "saga_runs", "shipments", "store_credits", "ticket_notes", "tickets",
];

/** Every business row of the sandbox (minus the sandbox column), as sorted JSON text. */
async function businessSnapshot(sb: string): Promise<Record<string, string[]>> {
  const union = sql.join(
    BUSINESS_TABLES.map((t) => sql`SELECT ${t}::text AS t, (to_jsonb(x) - 'sandbox_id')::text AS r FROM ${sql.raw(`"${t}"`)} x WHERE x.sandbox_id = ${sb}`),
    sql` UNION ALL `,
  );
  const res = await db().execute<{ t: string; r: string }>(sql`${union} ORDER BY 1, 2`);
  const out: Record<string, string[]> = Object.fromEntries(BUSINESS_TABLES.map((t) => [t, [] as string[]]));
  for (const row of res.rows) out[row.t].push(row.r);
  return out;
}

async function sagaStepsSnapshot(sb: string, threadId: string) {
  const runs = await db().select().from(s.sagaRuns).where(and(eq(s.sagaRuns.sandboxId, sb), eq(s.sagaRuns.threadId, threadId)));
  if (!runs.length) return { runs: [], steps: [] };
  const steps = await db().select().from(s.sagaSteps).where(inArray(s.sagaSteps.sagaId, runs.map((r) => r.id)));
  return {
    runs: runs.map((r) => `${r.id}:${r.status}:${r.ticketStatus}`).sort(),
    steps: steps.map((st) => `${st.sagaId}:${st.seq}:${st.name}:${st.status}:${st.attempts}`).sort(),
  };
}

const HITL_SCENARIOS = [
  { customerId: "CUS-1001", orderId: "ORD-9941", sku: "GLS-AUR-01", price: 32_000, shipping: 0, limit: 10_000, refundReason: "duplicate_charge", intents: ["damaged_item", "double_charge"], message: "My Aurora glass panel kit (ORD-9941) arrived shattered, and I was charged twice for it. Please fix this." },
  { customerId: "CUS-1002", orderId: "ORD-8820", sku: "KIT-POUR-02", price: 3_400, shipping: 700, limit: 5_000, refundReason: "damaged", intents: ["damaged_item"], message: "My pour-over set ORD-8820 arrived broken." },
  { customerId: "CUS-1003", orderId: "ORD-8821", sku: "MUG-STN-04", price: 3_600, shipping: 700, limit: 5_000, refundReason: "damaged", intents: ["damaged_item"], message: "Mug set ORD-8821 arrived broken." },
  { customerId: "CUS-1004", orderId: "ORD-8822", sku: "SKL-CI-12", price: 4_200, shipping: 800, limit: 5_000, refundReason: "damaged", intents: ["damaged_item"], message: "Skillet ORD-8822 arrived cracked." },
] as const;

/** A policy-valid plan for the scenario that is forced to a human (social-engineering signal or amount over the limit). */
const hitlCaseArb = fc
  .record({
    scenario: fc.integer({ min: 0, max: HITL_SCENARIOS.length - 1 }),
    replacement: fc.boolean(),
    label: fc.boolean(),
    refund: fc.boolean(),
    permille: fc.integer({ min: 1, max: 1000 }),
    signals: fc.subarray([...SOCIAL_SIGNALS], { maxLength: 3 }),
  })
  .map((r) => {
    const sc = HITL_SCENARIOS[r.scenario];
    const useRefund = r.refund || !r.replacement;
    const actions: Action[] = [];
    if (r.replacement) actions.push({ type: "replacement", orderId: sc.orderId, sku: sc.sku, qty: 1, reason: "damaged" });
    if (r.label) actions.push({ type: "return_label", orderId: sc.orderId, reason: "damaged" });
    let refundCents = 0;
    if (useRefund) {
      const cap = sc.refundReason === "duplicate_charge" ? sc.price : r.replacement ? sc.shipping : sc.price + sc.shipping;
      refundCents = Math.max(1, Math.round((cap * r.permille) / 1000));
      actions.push({ type: "refund", orderId: sc.orderId, amountCents: refundCents, reason: sc.refundReason });
    }
    const exposure = (r.replacement ? sc.price : 0) + refundCents;
    const signals = r.signals.length === 0 && exposure <= sc.limit ? ["urgency_pressure" as const] : r.signals;
    return { sc, actions, signals, refundCents };
  });
type HitlCase = ReturnType<typeof hitlCaseArb.generate>["value"];

function hitlLlm(c: HitlCase) {
  return new ScriptedLlm({
    triage: () => ({
      intents: c.sc.intents,
      severity: "high",
      sentiment: "negative",
      churnRisk: "low",
      orderIdsMentioned: [c.sc.orderId],
      missingInfo: [],
      clarifyingQuestion: null,
      socialEngineeringSignals: c.signals,
      summary: "Item arrived damaged; customer wants it fixed.",
    }),
    planner: (req) => ({ actions: c.actions, rationale: "Carrier damage scan on file; policy allows this remedy.", citedClauseIds: cite(req, ["§2.1", "§4.2", "§4.5"]) }),
    responder: templateResponder,
  });
}

async function pausedForApproval(c: HitlCase) {
  const sb = await freshSandbox();
  const threadId = await newThread(sb, c.sc.customerId);
  const llm = hitlLlm(c);
  const first = await runTurn({ db: db(), sandboxId: sb, threadId, mode: "live", llm, customerId: c.sc.customerId, message: c.sc.message, evidenceAttached: false, sagaHooks: instant });
  expect(first.status, `expected a HITL pause, got ${first.status} ${first.error?.code ?? ""}`).toBe("AWAITING_APPROVAL");
  return { sb, threadId, llm, first, interruptId: first.approval!.interruptId };
}

const resumeWith = (sb: string, threadId: string, llm: ScriptedLlm, interruptId: string, decision: HitlDecision) =>
  resumeTurn({ db: db(), sandboxId: sb, threadId, mode: "live", llm, interruptId, decision, sagaHooks: instant });

describe("(d) a rejected approval never produces a state change", () => {
  it("pure: after a reject the graph always routes to the responder, never to the executor", () => {
    // numRuns: 2000 (pure).
    fc.assert(
      fc.property(
        fc.record({
          note: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
          amountCents: fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: undefined }),
          removeActions: fc.option(fc.array(fc.nat({ max: 6 }), { maxLength: 4 }), { nil: undefined }),
          finalActions: fc.array(fc.constantFrom<Action>({ type: "refund", orderId: "ORD-8820", amountCents: 700, reason: "damaged" }, { type: "return_label", orderId: "ORD-8820" }), { maxLength: 3 }),
        }),
        (r) => {
          const state = { approval: { decision: "reject", note: r.note, amountCents: r.amountCents, removeActions: r.removeActions, by: "supervisor:demo", at: "", finalActions: r.finalActions, droppedActions: [] } } as unknown as GraphState;
          expect(afterHitl(state)).toBe("respond");
        },
      ),
      { seed: SEED, numRuns: 2000 },
    );
  });

  it("DB: reject (with junk amount/removeActions) and any later approve of the same or a made-up interrupt change nothing", async () => {
    // numRuns: 70 (DB-backed; each case runs a full graph turn to the HITL pause, ~6-7 s).
    await fc.assert(
      fc.asyncProperty(
        hitlCaseArb,
        fc.record({
          note: fc.option(fc.constantFrom("Need photos first", "Suspicious", ""), { nil: undefined }),
          junkAmount: fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: undefined }),
          junkRemove: fc.option(fc.array(fc.nat({ max: 5 }), { maxLength: 3 }), { nil: undefined }),
        }),
        fc.array(fc.constantFrom("approve_same", "modify_same", "approve_other"), { maxLength: 2 }),
        async (c, rej, followups) => {
          const { sb, threadId, llm, interruptId } = await pausedForApproval(c);
          const before = await businessSnapshot(sb);
          expect(before.approval_tokens).toEqual([]);

          const decision: HitlDecision = { decision: "reject", note: rej.note, amountCents: rej.junkAmount, removeActions: rej.junkRemove };
          const r = await resumeWith(sb, threadId, llm, interruptId, decision);
          expect(r.status).toBe("REPLIED");
          expect(r.facts?.outcome).toBe("REJECTED");
          expect(r.saga ?? null).toBeNull();
          expect(await businessSnapshot(sb)).toEqual(before);

          for (const [i, f] of followups.entries()) {
            if (f === "approve_other") {
              const x = await resumeWith(sb, threadId, llm, `${interruptId}-forged-${i}`, { decision: "approve" });
              expect(x.error?.code).toBe("NO_SUCH_INTERRUPT");
            } else {
              const x = await resumeWith(sb, threadId, llm, interruptId, f === "approve_same" ? { decision: "approve" } : { decision: "modify", amountCents: 1 });
              expect(x.duplicate).toBe(true);
              expect(x.facts?.outcome).toBe("REJECTED");
            }
          }
          expect(await businessSnapshot(sb)).toEqual(before);
        },
      ),
      { seed: SEED, numRuns: 70, endOnFailure: true },
    );
  }, 60_000);
});

describe("(e) replaying the same resume never runs the saga twice", () => {
  it("pure: the saga lookup key (plan hash) is stable under JSON key reordering and binds the thread", () => {
    // numRuns: 2000 (pure). runSaga finds an existing run by (thread, planHash); a hash that changed after a
    // jsonb round trip (key order) would start a second saga on re-execution.
    const shuffleKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shuffleKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, shuffleKeys(x)])) : v;
    fc.assert(
      fc.property(fc.array(fc.record({ action: fc.constantFrom<Action>({ type: "refund", orderId: "ORD-8820", amountCents: 700, reason: "damaged" }, { type: "return_label", orderId: "ORD-8820", reason: "damaged" }, { type: "replacement", orderId: "ORD-8820", sku: "KIT-POUR-02", qty: 1 }), tokenId: fc.option(fc.uuid(), { nil: null }) }), { maxLength: 4 }), fc.stringMatching(/^thr_[a-z0-9]{8}$/), (actions, threadId) => {
        const plan: SagaPlan = { sandboxId: "sb", threadId, customerId: "CUS-1002", customerName: "D", primaryOrderId: "ORD-8820", actions, subject: "s" };
        expect(planHashOf(shuffleKeys(plan) as SagaPlan)).toBe(planHashOf(plan));
        expect(planHashOf({ ...plan, threadId: `${threadId}x` })).not.toBe(planHashOf(plan));
      }),
      { seed: SEED, numRuns: 2000 },
    );
  });

  const decisionArb = (c: HitlCase): fc.Arbitrary<HitlDecision> =>
    fc.oneof(
      fc.constant<HitlDecision>({ decision: "approve" }),
      // noNullPrototype: decisions arrive as parsed JSON in the app; drizzle cannot serialize null-prototype objects.
      fc.record(
        {
          decision: fc.constant("modify" as const),
          amountCents: fc.integer({ min: 1, max: Math.max(1, c.refundCents) }),
          removeActions: fc.subarray(c.actions.map((_, i) => i), { maxLength: 1 }),
        },
        { noNullPrototype: true },
      ),
      fc.constant<HitlDecision>({ decision: "reject", note: "late reject" }),
    );

  it("DB: sequential and concurrent replays of one interrupt (with random saga faults) run at most one saga", async () => {
    // numRuns: 70 (DB-backed; full graph turn + 2-4 resumes per case, ~6-7 s).
    const caseArb = hitlCaseArb.chain((c) =>
      fc.record({
        c: fc.constant(c),
        first: fc.oneof({ arbitrary: fc.constant<HitlDecision>({ decision: "approve" }), weight: 3 }, { arbitrary: decisionArb(c), weight: 1 }),
        replays: fc.array(decisionArb(c), { minLength: 1, maxLength: 3 }),
        concurrent: fc.boolean(),
        faults: fc.array(fc.record({ target: fc.constantFrom<[ServiceName, string]>(["billing", "refund"], ["tickets", "create"], ["orders", "reserveInventory"], ["carrier_a", "createReturnLabel"], ["tickets", "notify"]), mode: fc.constantFrom<FaultMode>("fail_503", "commit_then_timeout", "timeout", "schema_drift", "fail_n_times") }), { maxLength: 2 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ c, first, replays, concurrent, faults }) => {
        const { sb, threadId, llm, interruptId } = await pausedForApproval(c);
        for (const f of faults) await fault(sb, f.target[0], f.target[1], f.mode, f.mode === "fail_n_times" ? 1 : undefined);

        let results: (TurnResult & { duplicate?: boolean })[];
        let settled: { biz: Record<string, string[]>; saga: Awaited<ReturnType<typeof sagaStepsSnapshot>> };
        if (concurrent) {
          results = await Promise.all([first, ...replays].map((d) => resumeWith(sb, threadId, llm, interruptId, d)));
          settled = { biz: await businessSnapshot(sb), saga: await sagaStepsSnapshot(sb, threadId) };
          results.push(await resumeWith(sb, threadId, llm, interruptId, { decision: "approve" }));
        } else {
          results = [await resumeWith(sb, threadId, llm, interruptId, first)];
          settled = { biz: await businessSnapshot(sb), saga: await sagaStepsSnapshot(sb, threadId) };
          for (const d of replays) results.push(await resumeWith(sb, threadId, llm, interruptId, d));
        }

        // Exactly one request did the work; every other one was answered from the stored decision.
        const winners = results.filter((r) => !r.duplicate);
        expect(winners).toHaveLength(1);
        const winner = winners[0];
        for (const r of results.filter((x) => x.duplicate)) {
          // A duplicate is answered from the stored result, or (only while the winner is still running) refused.
          if (r.status === "ERROR") expect((concurrent && r.error?.code === "ALREADY_PROCESSING") || winner.status === "ERROR", r.error?.code).toBe(true);
          else {
            expect(r.status).toBe(winner.status);
            expect(r.saga?.sagaId ?? null).toBe(winner.saga?.sagaId ?? null);
          }
        }

        // Nothing changed after the winner settled: same saga log, same business rows.
        expect(await sagaStepsSnapshot(sb, threadId)).toEqual(settled.saga);
        expect(await businessSnapshot(sb)).toEqual(settled.biz);

        const runs = await db().select().from(s.sagaRuns).where(and(eq(s.sagaRuns.sandboxId, sb), eq(s.sagaRuns.threadId, threadId)));
        expect(runs.length).toBeLessThanOrEqual(1);
        if (winner.saga) expect(runs.map((r) => r.id)).toEqual([winner.saga.sagaId]);
        const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, c.sc.orderId)));
        expect(refunds.length).toBeLessThanOrEqual(1);
        for (const b of await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tickets WHERE sandbox_id = ${sb} AND customer_id = ${c.sc.customerId} AND status <> 'CLOSED'`).then((x) => x.rows)) {
          expect(b.n).toBeLessThanOrEqual(1);
        }
        const decisions = await db().select().from(s.hitlDecisions).where(and(eq(s.hitlDecisions.threadId, threadId), eq(s.hitlDecisions.interruptId, interruptId)));
        expect(decisions).toHaveLength(1);
      }),
      { seed: SEED, numRuns: 70, endOnFailure: true },
    );
  }, 60_000);
});
