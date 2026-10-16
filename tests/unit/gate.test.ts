/**
 * Unit tests for the policy gate (src/lib/policy/gate.ts). Pure code, no DB: every
 * GateInput is built by hand so each check can be driven to pass and to fail.
 *
 * Policy numbers come from data/policies/rules.json:
 *   RETURNS   2024: 45d window, credit cap $15, clearance non-refundable | 2025: 90d, $25 | 2026: 30d, $25
 *   BILLING   duplicate report window 60d / 90d / 120d, captures within 24h
 *   SHIPPING  2024: 3d late -> $5 flat credit, lost 21d | 2025: 2d -> shipping refund, lost 14d
 *             2026: 3d -> 10% credit capped $20, lost 10d
 *   DAMAGE    2024: 7d, evidence > $50, no scan, no label, no shipping | 2025: 14d, > $100, scan, label
 *             2026: 14d, > $150, scan, label, shipping refundable
 *   GOODWILL  2024: platinum, $15 | 2025: all tiers, $25 | 2026: gold+platinum, $20; cooldown 180/90/90d
 *   APPROVAL  auto limit $30 / $50 / $50, VIP (platinum) $75 / $100 / $100, one refund per resolution
 * RETURNS / SHIPPING / DAMAGE are governed by the order date; BILLING / GOODWILL / APPROVAL by the claim date.
 */
import { describe, it, expect } from "vitest";
import type { Action } from "@/lib/agent/schemas";
import { runGate, findDuplicateCapture, type ActionDecision, type GateInput, type GateOrder } from "@/lib/policy/gate";

const CUSTOMER = "CUS-1001";

const LAMP = { sku: "LMP-01", name: "Desk lamp", category: "lighting", qty: 1, unitPriceCents: 4000 };
const SOFA = { sku: "SOF-01", name: "Linen sofa", category: "furniture", qty: 1, unitPriceCents: 20000 };

function cap(id: string, amountCents: number, capturedAt: string) {
  return { id, amountCents, capturedAt };
}

/** A delivered 2026 order: $40.00 lamp + $9.00 shipping = $49.00, paid once. */
function makeOrder(o: Partial<GateOrder> = {}): GateOrder {
  return {
    id: "ORD-1001",
    customerId: CUSTOMER,
    orderDate: "2026-09-01",
    promisedDate: "2026-09-05",
    deliveredDate: "2026-09-05",
    status: "delivered",
    shippingCents: 900,
    totalCents: 4900,
    items: [LAMP],
    captures: [cap("CAP-1", 4900, "2026-09-01T12:00:00.000Z")],
    paidCents: 4900,
    refundedCents: 0,
    priorRefunds: [],
    priorReplacements: 0,
    activeLabels: 0,
    damageScan: false,
    lastTrackingEventDate: "2026-09-05",
    ...o,
  };
}

/** Same order shape, but a $200.00 sofa (+ $9.00 shipping). */
function sofaOrder(o: Partial<GateOrder> = {}): GateOrder {
  return makeOrder({
    items: [SOFA],
    totalCents: 20900,
    paidCents: 20900,
    captures: [cap("CAP-1", 20900, "2026-09-01T12:00:00.000Z")],
    ...o,
  });
}

function makeInput(o: Partial<GateInput> = {}): GateInput {
  return {
    claimDate: "2026-09-10",
    customer: { id: CUSTOMER, tier: "standard" },
    churnRisk: "low",
    orders: [makeOrder()],
    storeCredits: [],
    inventory: { "LMP-01": 3, "SOF-01": 2 },
    evidenceAttached: false,
    firewallFlagged: false,
    socialSignals: [],
    ...o,
  };
}

function chk(d: ActionDecision, code: string) {
  const c = d.checks.find((x) => x.code === code);
  if (!c) throw new Error(`no ${code} check; got ${d.checks.map((x) => x.code).join(", ")}`);
  return c;
}

const codesOf = (d: ActionDecision) => d.checks.map((c) => c.code);

const refund = (amountCents: number, reason: Extract<Action, { type: "refund" }>["reason"], extra: Partial<Extract<Action, { type: "refund" }>> = {}): Action => ({
  type: "refund",
  orderId: "ORD-1001",
  amountCents,
  reason,
  ...extra,
});

const credit = (amountCents: number, reason: Extract<Action, { type: "store_credit" }>["reason"], extra: Partial<Extract<Action, { type: "store_credit" }>> = {}): Action => ({
  type: "store_credit",
  amountCents,
  reason,
  ...extra,
});

// ---------------------------------------------------------------------------------------------

describe("ORDER_FOUND", () => {
  it("passes for the customer's own order", () => {
    const r = runGate([refund(1000, "return")], makeInput());
    const d = r.decisions[0];
    expect(chk(d, "ORDER_FOUND")).toEqual({ code: "ORDER_FOUND", pass: true, hard: true, detail: "ORD-1001 belongs to this customer." });
    expect(d.status).toBe("AUTO_APPROVED");
    expect(d.exposureCents).toBe(1000);
    expect(r.route).toBe("auto");
  });

  it("denies a refund on another customer's order and stops evaluating", () => {
    const input = makeInput({ orders: [makeOrder(), makeOrder({ id: "ORD-2002", customerId: "CUS-2002" })] });
    const r = runGate([refund(1000, "return", { orderId: "ORD-2002" })], input);
    const d = r.decisions[0];
    expect(d.checks).toEqual([
      { code: "ORDER_FOUND", pass: false, hard: true, detail: "ORD-2002 is not one of this customer's orders." },
    ]);
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["ORDER_FOUND"]);
    expect(d.policy).toBeNull();
    expect(d.exposureCents).toBe(0);
    expect(r.totalExposureCents).toBe(0);
    expect(r.route).toBe("deny");
    expect(r.humanReasons).toEqual([]);
  });

  it.each<Action>([
    { type: "replacement", orderId: "ORD-2002", sku: "LMP-01", qty: 1, reason: "damaged" },
    { type: "return_label", orderId: "ORD-2002", reason: "return" },
    { type: "store_credit", orderId: "ORD-2002", amountCents: 500, reason: "late_delivery" },
  ])("denies $type on another customer's order", (action) => {
    const input = makeInput({ orders: [makeOrder({ id: "ORD-2002", customerId: "CUS-2002" })] });
    const r = runGate([action], input);
    const d = r.decisions[0];
    expect(d.checks).toEqual([
      { code: "ORDER_FOUND", pass: false, hard: true, detail: "ORD-2002 is not one of this customer's orders." },
    ]);
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["ORDER_FOUND"]);
    expect(d.policy).toBeNull();
    expect(d.exposureCents).toBe(0);
    expect(r.decisions).toHaveLength(1);
    expect(r.route).toBe("deny");
  });

  it("denies an order id that does not exist at all", () => {
    const d = runGate([refund(1000, "return", { orderId: "ORD-9999" })], makeInput()).decisions[0];
    expect(chk(d, "ORDER_FOUND").pass).toBe(false);
    expect(d.reasonCodes).toEqual(["ORDER_FOUND"]);
  });
});

describe("refund: AMOUNT_WITHIN_PAID / NO_DUPLICATE_CLAIM / ONE_REFUND_PER_RESOLUTION", () => {
  it("AMOUNT_WITHIN_PAID passes at exactly paid minus refunded", () => {
    const input = makeInput({ orders: [makeOrder({ refundedCents: 900 })] });
    const d = runGate([refund(4000, "return")], input).decisions[0];
    expect(chk(d, "AMOUNT_WITHIN_PAID")).toEqual({
      code: "AMOUNT_WITHIN_PAID",
      pass: true,
      hard: true,
      detail: "Refund $40.00 vs paid $49.00 minus refunded $9.00 = $40.00.",
    });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("AMOUNT_WITHIN_PAID fails one cent above what is left to refund", () => {
    const input = makeInput({ orders: [makeOrder({ refundedCents: 901 })] });
    const r = runGate([refund(4000, "return")], input);
    const d = r.decisions[0];
    expect(chk(d, "AMOUNT_WITHIN_PAID").pass).toBe(false);
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["AMOUNT_WITHIN_PAID"]);
    expect(d.exposureCents).toBe(0);
    expect(r.route).toBe("deny");
  });

  it("NO_DUPLICATE_CLAIM fails when a refund with the same reason already exists", () => {
    const input = makeInput({ orders: [makeOrder({ priorRefunds: [{ amountCents: 1000, reason: "return" }] })] });
    const d = runGate([refund(1000, "return")], input).decisions[0];
    expect(chk(d, "NO_DUPLICATE_CLAIM")).toMatchObject({ pass: false, hard: true, detail: "A return refund already exists on ORD-1001." });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["NO_DUPLICATE_CLAIM"]);
  });

  it("NO_DUPLICATE_CLAIM passes when the earlier refund had a different reason", () => {
    const input = makeInput({ orders: [makeOrder({ priorRefunds: [{ amountCents: 900, reason: "late_delivery" }] })] });
    const d = runGate([refund(1000, "return")], input).decisions[0];
    expect(chk(d, "NO_DUPLICATE_CLAIM")).toMatchObject({ pass: true, detail: "No earlier return refund on ORD-1001." });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("ONE_REFUND_PER_RESOLUTION allows the first refund and denies the second", () => {
    const input = makeInput({ orders: [makeOrder(), makeOrder({ id: "ORD-1002" })] });
    const r = runGate([refund(1000, "return"), refund(1000, "return", { orderId: "ORD-1002" })], input);
    expect(chk(r.decisions[0], "ONE_REFUND_PER_RESOLUTION")).toMatchObject({ pass: true, detail: "At most 1 refund per resolution." });
    expect(r.decisions[0].status).toBe("AUTO_APPROVED");
    expect(chk(r.decisions[1], "ONE_REFUND_PER_RESOLUTION").pass).toBe(false);
    expect(r.decisions[1].status).toBe("DENIED");
    expect(r.decisions[1].reasonCodes).toEqual(["ONE_REFUND_PER_RESOLUTION"]);
    expect(r.totalExposureCents).toBe(1000);
    expect(r.route).toBe("auto");
  });
});

describe("refund: duplicate_charge", () => {
  const dupOrder = (o: Partial<GateOrder> = {}) =>
    makeOrder({
      captures: [cap("CAP-1", 4900, "2026-09-01T12:00:00.000Z"), cap("CAP-2", 4900, "2026-09-01T12:05:00.000Z")],
      paidCents: 9800,
      ...o,
    });

  it("passes every check for a real double capture reported in time", () => {
    const d = runGate([refund(4900, "duplicate_charge")], makeInput({ orders: [dupOrder()] })).decisions[0];
    expect(codesOf(d)).toEqual([
      "ORDER_FOUND",
      "AMOUNT_WITHIN_PAID",
      "NO_DUPLICATE_CLAIM",
      "ONE_REFUND_PER_RESOLUTION",
      "DOUBLE_CHARGE_CONFIRMED",
      "AMOUNT_MATCHES_DUPLICATE",
      "REPORTED_IN_TIME",
    ]);
    expect(chk(d, "DOUBLE_CHARGE_CONFIRMED")).toMatchObject({ pass: true, hard: true, detail: "Ledger shows 2 captures of $49.00 within 24 hours." });
    expect(chk(d, "AMOUNT_MATCHES_DUPLICATE")).toMatchObject({ pass: true, hard: true, detail: "Duplicate amount is $49.00." });
    expect(chk(d, "REPORTED_IN_TIME")).toEqual({ code: "REPORTED_IN_TIME", pass: true, hard: false, detail: "Reported 9 days after capture; window is 120 days." });
    expect(d.policy).toEqual({ policyId: "BILLING_DISPUTES", version: "2026.1", clauseIds: ["§2.1", "§2.2"] });
    expect(d.status).toBe("AUTO_APPROVED");
    expect(d.exposureCents).toBe(4900);
  });

  it("DOUBLE_CHARGE_CONFIRMED fails with a single capture and skips the amount/time checks", () => {
    const d = runGate([refund(4900, "duplicate_charge")], makeInput()).decisions[0];
    expect(chk(d, "DOUBLE_CHARGE_CONFIRMED")).toMatchObject({ pass: false, hard: true, detail: "Ledger shows no duplicate capture on this order." });
    expect(codesOf(d)).not.toContain("AMOUNT_MATCHES_DUPLICATE");
    expect(codesOf(d)).not.toContain("REPORTED_IN_TIME");
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["DOUBLE_CHARGE_CONFIRMED"]);
  });

  it("captures more than 24 hours apart are not a duplicate; exactly 24 hours is", () => {
    const apart = dupOrder({ captures: [cap("A", 4900, "2026-09-01T12:00:00.000Z"), cap("B", 4900, "2026-09-02T12:00:01.000Z")] });
    expect(runGate([refund(4900, "duplicate_charge")], makeInput({ orders: [apart] })).decisions[0].reasonCodes).toEqual([
      "DOUBLE_CHARGE_CONFIRMED",
    ]);
    const edge = dupOrder({ captures: [cap("A", 4900, "2026-09-01T12:00:00.000Z"), cap("B", 4900, "2026-09-02T12:00:00.000Z")] });
    expect(runGate([refund(4900, "duplicate_charge")], makeInput({ orders: [edge] })).decisions[0].status).toBe("AUTO_APPROVED");
  });

  it("captures of different amounts are not a duplicate", () => {
    const o = dupOrder({ captures: [cap("A", 4900, "2026-09-01T12:00:00.000Z"), cap("B", 900, "2026-09-01T12:01:00.000Z")], paidCents: 5800 });
    const d = runGate([refund(900, "duplicate_charge")], makeInput({ orders: [o] })).decisions[0];
    expect(chk(d, "DOUBLE_CHARGE_CONFIRMED").pass).toBe(false);
  });

  it("AMOUNT_MATCHES_DUPLICATE fails one cent above the duplicated amount", () => {
    const d = runGate([refund(4901, "duplicate_charge")], makeInput({ orders: [dupOrder()] })).decisions[0];
    expect(chk(d, "AMOUNT_WITHIN_PAID").pass).toBe(true);
    expect(chk(d, "AMOUNT_MATCHES_DUPLICATE").pass).toBe(false);
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["AMOUNT_MATCHES_DUPLICATE"]);
  });

  it("a triple capture allows refunding two extra captures", () => {
    const o = dupOrder({
      captures: [
        cap("A", 4900, "2026-09-01T12:00:00.000Z"),
        cap("B", 4900, "2026-09-01T12:01:00.000Z"),
        cap("C", 4900, "2026-09-01T12:02:00.000Z"),
      ],
      paidCents: 14700,
    });
    const ok = runGate([refund(9800, "duplicate_charge")], makeInput({ orders: [o] })).decisions[0];
    expect(chk(ok, "DOUBLE_CHARGE_CONFIRMED").detail).toBe("Ledger shows 3 captures of $49.00 within 24 hours.");
    expect(chk(ok, "AMOUNT_MATCHES_DUPLICATE")).toMatchObject({ pass: true, detail: "Duplicate amount is $98.00." });
    // $98.00 is above the $50.00 standard auto limit, so it is approvable but needs a human.
    expect(ok.status).toBe("NEEDS_HUMAN");
    expect(ok.reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
    const over = runGate([refund(9801, "duplicate_charge")], makeInput({ orders: [{ ...o, paidCents: 20000 }] })).decisions[0];
    expect(over.reasonCodes).toEqual(["AMOUNT_MATCHES_DUPLICATE"]);
  });

  it("REPORTED_IN_TIME (soft) passes at exactly 120 days and fails at 121 in 2026", () => {
    const o = dupOrder({
      orderDate: "2026-01-05",
      captures: [cap("A", 4900, "2026-01-05T10:00:00.000Z"), cap("B", 4900, "2026-01-05T10:03:00.000Z")],
    });
    const atEdge = runGate([refund(4900, "duplicate_charge")], makeInput({ claimDate: "2026-05-05", orders: [o] })).decisions[0];
    expect(chk(atEdge, "REPORTED_IN_TIME")).toMatchObject({ pass: true, detail: "Reported 120 days after capture; window is 120 days." });
    expect(atEdge.status).toBe("AUTO_APPROVED");

    const late = runGate([refund(4900, "duplicate_charge")], makeInput({ claimDate: "2026-05-06", orders: [o] })).decisions[0];
    expect(chk(late, "REPORTED_IN_TIME")).toEqual({ code: "REPORTED_IN_TIME", pass: false, hard: false, detail: "Reported 121 days after capture; window is 120 days." });
    expect(late.status).toBe("DENIED");
    expect(late.reasonCodes).toEqual(["REPORTED_IN_TIME"]);
  });

  it("REPORTED_IN_TIME counts from the LAST duplicate capture (captures straddling midnight)", () => {
    const o = dupOrder({
      orderDate: "2026-01-05",
      captures: [cap("A", 4900, "2026-01-05T23:00:00.000Z"), cap("B", 4900, "2026-01-06T01:00:00.000Z")],
    });
    // 121 days after the first capture, 120 after the second: still in time.
    const d = runGate([refund(4900, "duplicate_charge")], makeInput({ claimDate: "2026-05-06", orders: [o] })).decisions[0];
    expect(chk(d, "REPORTED_IN_TIME")).toMatchObject({ pass: true, detail: "Reported 120 days after capture; window is 120 days." });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("uses the claim date's billing version: 60 days in 2024, 90 days in 2025", () => {
    const o2024 = dupOrder({
      orderDate: "2024-01-10",
      captures: [cap("A", 2000, "2024-01-10T10:00:00.000Z"), cap("B", 2000, "2024-01-10T10:02:00.000Z")],
      paidCents: 4000,
    });
    const d2024 = runGate([refund(2000, "duplicate_charge")], makeInput({ claimDate: "2024-03-15", orders: [o2024] })).decisions[0];
    expect(chk(d2024, "REPORTED_IN_TIME")).toMatchObject({ pass: false, detail: "Reported 65 days after capture; window is 60 days." });
    expect(d2024.policy?.version).toBe("2024.1");

    // Captured in December 2024 but claimed in 2025: the 2025 (90-day) window governs.
    const o2025 = dupOrder({
      orderDate: "2024-12-01",
      captures: [cap("A", 2000, "2024-12-01T10:00:00.000Z"), cap("B", 2000, "2024-12-01T10:02:00.000Z")],
      paidCents: 4000,
    });
    const d2025 = runGate([refund(2000, "duplicate_charge")], makeInput({ claimDate: "2025-02-15", orders: [o2025] })).decisions[0];
    expect(chk(d2025, "REPORTED_IN_TIME")).toMatchObject({ pass: true, detail: "Reported 76 days after capture; window is 90 days." });
    expect(d2025.policy).toEqual({ policyId: "BILLING_DISPUTES", version: "2025.1", clauseIds: ["§2.1", "§2.2"] });
    expect(d2025.status).toBe("AUTO_APPROVED");
  });

  it("findDuplicateCapture reports count, amount and last capture time", () => {
    expect(
      findDuplicateCapture(
        [cap("A", 500, "2026-01-01T00:00:00.000Z"), cap("B", 500, "2026-01-01T05:00:00.000Z"), cap("C", 700, "2026-01-01T06:00:00.000Z")],
        24,
      ),
    ).toEqual({ amountCents: 500, count: 2, lastCapturedAt: "2026-01-01T05:00:00.000Z" });
    expect(findDuplicateCapture([cap("A", 500, "2026-01-01T00:00:00.000Z")], 24)).toBeNull();
    // The largest cluster wins, even when a smaller one was seen first.
    expect(
      findDuplicateCapture(
        [
          cap("A", 500, "2026-01-01T00:00:00.000Z"),
          cap("B", 500, "2026-01-01T01:00:00.000Z"),
          cap("C", 700, "2026-01-01T02:00:00.000Z"),
          cap("D", 700, "2026-01-01T03:00:00.000Z"),
          cap("E", 700, "2026-01-01T04:00:00.000Z"),
        ],
        24,
      ),
    ).toEqual({ amountCents: 700, count: 3, lastCapturedAt: "2026-01-01T04:00:00.000Z" });
  });
});

describe("refund: damaged", () => {
  it("DELIVERED fails for an undelivered order and the window check is skipped", () => {
    const input = makeInput({ orders: [makeOrder({ deliveredDate: null, status: "shipped" })] });
    const d = runGate([refund(1000, "damaged")], input).decisions[0];
    expect(chk(d, "DELIVERED")).toMatchObject({ pass: false, hard: true, detail: "Not delivered yet." });
    expect(codesOf(d)).not.toContain("WITHIN_WINDOW");
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["DELIVERED"]);
  });

  it("WITHIN_WINDOW (soft) passes on day 14 and fails on day 15 in 2026", () => {
    const ok = runGate([refund(1000, "damaged")], makeInput({ claimDate: "2026-09-19" })).decisions[0];
    expect(chk(ok, "DELIVERED")).toMatchObject({ pass: true, detail: "Delivered 2026-09-05." });
    expect(chk(ok, "WITHIN_WINDOW")).toMatchObject({ pass: true, hard: false, detail: "Reported 14 days after delivery; window is 14 days." });
    expect(ok.status).toBe("AUTO_APPROVED");
    expect(ok.policy).toEqual({ policyId: "DAMAGE_TRANSIT", version: "2026.1", clauseIds: ["§4.2", "§4.3"] });

    const late = runGate([refund(1000, "damaged")], makeInput({ claimDate: "2026-09-20" })).decisions[0];
    expect(chk(late, "WITHIN_WINDOW")).toMatchObject({ pass: false, hard: false });
    expect(late.status).toBe("DENIED");
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);
  });

  it("WITHIN_WINDOW is 7 days under the 2024 policy", () => {
    const o = makeOrder({ orderDate: "2024-05-01", promisedDate: "2024-05-04", deliveredDate: "2024-05-04" });
    const ok = runGate([refund(1000, "damaged")], makeInput({ claimDate: "2024-05-11", orders: [o] })).decisions[0];
    expect(chk(ok, "WITHIN_WINDOW")).toMatchObject({ pass: true, detail: "Reported 7 days after delivery; window is 7 days." });
    const late = runGate([refund(1000, "damaged")], makeInput({ claimDate: "2024-05-12", orders: [o] })).decisions[0];
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);
  });

  it("the damage version follows the order date, not the claim date", () => {
    const o = makeOrder({ orderDate: "2025-12-28", promisedDate: "2026-01-02", deliveredDate: "2026-01-02" });
    const input = makeInput({ claimDate: "2026-01-05", orders: [o] });
    const r = runGate([refund(1000, "damaged")], input);
    expect(r.decisions[0].policy?.version).toBe("2025.1");
    expect(r.approvalPolicy).toEqual({ policyId: "APPROVAL_AUTHORITY", version: "2026.1", clauseIds: ["§6.1", "§6.2", "§6.4"] });
    // Behaviour, not just the label: the 2025 rules do not refund shipping (2026 would allow $49.00).
    const withShipping = runGate([refund(4900, "damaged")], input).decisions[0];
    expect(chk(withShipping, "NO_DOUBLE_REMEDY")).toMatchObject({ pass: false, detail: "Item value plus refundable shipping is $40.00." });
    expect(withShipping.reasonCodes).toEqual(["NO_DOUBLE_REMEDY"]);

    // A 2024 order claimed in 2025 keeps the 2024 7-day window (2025 would allow 14).
    const o2024 = makeOrder({ orderDate: "2024-12-20", promisedDate: "2024-12-27", deliveredDate: "2024-12-27" });
    const d2024 = runGate([refund(1000, "damaged")], makeInput({ claimDate: "2025-01-06", orders: [o2024] })).decisions[0];
    expect(d2024.policy?.version).toBe("2024.1");
    expect(chk(d2024, "WITHIN_WINDOW")).toMatchObject({ pass: false, detail: "Reported 10 days after delivery; window is 7 days." });
    expect(d2024.reasonCodes).toEqual(["WITHIN_WINDOW"]);
  });

  it("NO_DOUBLE_REMEDY: 2026 also refunds shipping (item + shipping allowed)", () => {
    const d = runGate([refund(4900, "damaged")], makeInput()).decisions[0];
    expect(chk(d, "NO_DOUBLE_REMEDY")).toMatchObject({ pass: true, hard: true, detail: "Item value plus refundable shipping is $49.00." });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("NO_DOUBLE_REMEDY: 2025 refunds only the item value, so item + shipping is denied", () => {
    const o = makeOrder({ orderDate: "2025-06-01", promisedDate: "2025-06-05", deliveredDate: "2025-06-05" });
    const input = makeInput({ claimDate: "2025-06-10", orders: [o] });
    const over = runGate([refund(4900, "damaged")], input).decisions[0];
    expect(chk(over, "NO_DOUBLE_REMEDY")).toMatchObject({ pass: false, detail: "Item value plus refundable shipping is $40.00." });
    expect(over.status).toBe("DENIED");
    expect(over.reasonCodes).toEqual(["NO_DOUBLE_REMEDY"]);
    expect(runGate([refund(4000, "damaged")], input).decisions[0].status).toBe("AUTO_APPROVED");
  });

  it("NO_DOUBLE_REMEDY: with a replacement in the plan only the shipping fee may be refunded", () => {
    const repl: Action = { type: "replacement", orderId: "ORD-1001", sku: "LMP-01", qty: 1, reason: "damaged" };
    const ok = runGate([refund(900, "damaged"), repl], makeInput());
    expect(chk(ok.decisions[0], "NO_DOUBLE_REMEDY")).toMatchObject({
      pass: true,
      detail: "A replacement is in the plan, so only the shipping fee ($9.00) can also be refunded.",
    });
    expect(ok.decisions.map((d) => d.status)).toEqual(["AUTO_APPROVED", "AUTO_APPROVED"]);
    expect(ok.totalExposureCents).toBe(4900);

    const over = runGate([refund(901, "damaged"), repl], makeInput());
    expect(over.decisions[0].status).toBe("DENIED");
    expect(over.decisions[0].reasonCodes).toEqual(["NO_DOUBLE_REMEDY"]);
    expect(over.decisions[1].status).toBe("AUTO_APPROVED");
  });

  it("NO_DOUBLE_REMEDY only counts a replacement for the SAME order", () => {
    const input = makeInput({ orders: [makeOrder(), makeOrder({ id: "ORD-1002" })] });
    const otherOrderRepl: Action = { type: "replacement", orderId: "ORD-1002", sku: "LMP-01", qty: 1, reason: "damaged" };
    const r = runGate([refund(4900, "damaged"), otherOrderRepl], input);
    expect(chk(r.decisions[0], "NO_DOUBLE_REMEDY")).toMatchObject({ pass: true, detail: "Item value plus refundable shipping is $49.00." });
    // Both live; $49.00 + $40.00 is above the $50.00 limit.
    expect(r.decisions.map((d) => d.status)).toEqual(["NEEDS_HUMAN", "NEEDS_HUMAN"]);
    expect(r.decisions.map((d) => d.reasonCodes)).toEqual([["AMOUNT_ABOVE_AUTO_LIMIT"], ["AMOUNT_ABOVE_AUTO_LIMIT"]]);
    expect(r.totalExposureCents).toBe(8900);
  });

  it("EVIDENCE_PRESENT is not checked at or below the threshold", () => {
    expect(codesOf(runGate([refund(4900, "damaged")], makeInput()).decisions[0])).not.toContain("EVIDENCE_PRESENT");
    const o = sofaOrder({ orderDate: "2024-05-01", promisedDate: "2024-05-04", deliveredDate: "2024-05-04" });
    const input = makeInput({ claimDate: "2024-05-06", orders: [o] });
    expect(codesOf(runGate([refund(5000, "damaged")], input).decisions[0])).not.toContain("EVIDENCE_PRESENT");
    expect(codesOf(runGate([refund(5001, "damaged")], input).decisions[0])).toContain("EVIDENCE_PRESENT");
  });

  it("EVIDENCE_PRESENT fails above the 2026 threshold without photos or scan, and asks for a photo", () => {
    const r = runGate([refund(20000, "damaged")], makeInput({ orders: [sofaOrder()] }));
    const d = r.decisions[0];
    expect(chk(d, "EVIDENCE_PRESENT")).toEqual({ code: "EVIDENCE_PRESENT", pass: false, hard: true, detail: "Claims above $150.00 need evidence." });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["EVIDENCE_PRESENT"]);
    expect(d.alternatives).toEqual([{ type: "ask_customer", question: "Could you attach a photo of the damage so we can process this?" }]);
    // ask_customer alternatives are never added to the decision list.
    expect(r.decisions).toHaveLength(1);
    expect(r.route).toBe("deny");
  });

  it("a carrier damage scan counts as evidence in 2026 and 2025", () => {
    const d2026 = runGate([refund(20000, "damaged")], makeInput({ orders: [sofaOrder({ damageScan: true })] })).decisions[0];
    expect(chk(d2026, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Carrier damage scan counts as evidence." });
    expect(d2026.alternatives).toEqual([]);
    expect(d2026.status).toBe("NEEDS_HUMAN"); // $200 is above the $50 auto limit
    expect(d2026.reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);

    const o2025 = sofaOrder({ orderDate: "2025-05-01", promisedDate: "2025-05-04", deliveredDate: "2025-05-04", damageScan: true });
    const d2025 = runGate([refund(15000, "damaged")], makeInput({ claimDate: "2025-05-06", orders: [o2025] })).decisions[0];
    expect(chk(d2025, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Carrier damage scan counts as evidence." });
  });

  it("a carrier damage scan does NOT count as evidence in 2024, but attached photos do", () => {
    const o = sofaOrder({ orderDate: "2024-05-01", promisedDate: "2024-05-04", deliveredDate: "2024-05-04", damageScan: true });
    const scanOnly = runGate([refund(6000, "damaged")], makeInput({ claimDate: "2024-05-06", orders: [o] })).decisions[0];
    expect(chk(scanOnly, "EVIDENCE_PRESENT")).toMatchObject({ pass: false, detail: "Claims above $50.00 need evidence." });
    expect(scanOnly.status).toBe("DENIED");
    expect(scanOnly.alternatives).toHaveLength(1);

    const photos = runGate([refund(6000, "damaged")], makeInput({ claimDate: "2024-05-06", orders: [o], evidenceAttached: true })).decisions[0];
    expect(chk(photos, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Customer attached evidence." });
    expect(photos.status).toBe("NEEDS_HUMAN"); // above the 2024 $30 auto limit
  });

  it("with a replacement in the plan the shipping-only refund skips the evidence check", () => {
    // $160.00 freight on a $200.00 sofa: the refund is above the $150.00 evidence threshold and
    // there are no photos and no scan, yet the claim value counted for evidence is $0.
    const o = sofaOrder({ shippingCents: 16000, totalCents: 36000, paidCents: 36000 });
    const repl: Action = { type: "replacement", orderId: "ORD-1001", sku: "SOF-01", qty: 1, reason: "damaged" };
    const r = runGate([refund(16000, "damaged"), repl], makeInput({ orders: [o] }));
    const d = r.decisions[0];
    expect(codesOf(d)).toEqual([
      "ORDER_FOUND",
      "AMOUNT_WITHIN_PAID",
      "NO_DUPLICATE_CLAIM",
      "ONE_REFUND_PER_RESOLUTION",
      "DELIVERED",
      "WITHIN_WINDOW",
      "NO_DOUBLE_REMEDY",
    ]);
    expect(d.checks.every((c) => c.pass)).toBe(true);
    expect(d.status).toBe("NEEDS_HUMAN");
    expect(d.reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
    // The $200.00 replacement itself still needs evidence.
    expect(r.decisions[1].status).toBe("DENIED");
    expect(r.decisions[1].reasonCodes).toEqual(["EVIDENCE_PRESENT"]);
    expect(r.totalExposureCents).toBe(16000);
  });
});

describe("refund / store credit: late_delivery", () => {
  const lateOrder = (y: number, o: Partial<GateOrder> = {}) =>
    makeOrder({
      orderDate: `${y}-03-01`,
      promisedDate: `${y}-03-05`,
      deliveredDate: `${y}-03-10`,
      lastTrackingEventDate: `${y}-03-10`,
      captures: [cap("CAP-1", 4900, `${y}-03-01T12:00:00.000Z`)],
      ...o,
    });
  const lateInput = (y: number, o: Partial<GateOrder> = {}, i: Partial<GateInput> = {}) =>
    makeInput({ claimDate: `${y}-03-12`, orders: [lateOrder(y, o)], ...i });

  it("2024: a refund is denied and the gate adds a flat $5.00 store credit", () => {
    const r = runGate([refund(900, "late_delivery")], lateInput(2024));
    const [d, alt] = r.decisions;
    expect(chk(d, "LATE_CONFIRMED")).toMatchObject({ pass: true, detail: "Delivered 5 days after the promised date; threshold is 3 days." });
    expect(chk(d, "REMEDY_MATCHES_POLICY")).toMatchObject({
      pass: false,
      hard: true,
      detail: "This policy compensates late deliveries with store credit, not a refund.",
    });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["REMEDY_MATCHES_POLICY"]);
    expect(d.policy).toEqual({ policyId: "SHIPPING_DELAYS", version: "2024.1", clauseIds: ["§3.2", "§3.3", "§3.4"] });
    expect(d.alternatives).toEqual([{ type: "store_credit", amountCents: 500, reason: "late_delivery", orderId: "ORD-1001" }]);

    expect(r.decisions).toHaveLength(2);
    expect(alt.addedByGate).toBe(true);
    expect(alt.index).toBe(1);
    expect(alt.action).toEqual({ type: "store_credit", amountCents: 500, reason: "late_delivery", orderId: "ORD-1001" });
    expect(alt.status).toBe("AUTO_APPROVED");
    expect(chk(alt, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: true, detail: "Late-delivery credit for this order is at most $5.00." });
    expect(alt.exposureCents).toBe(500);
    expect(r.totalExposureCents).toBe(500);
    expect(r.route).toBe("auto");
  });

  it("2025: refunding the shipping fee matches policy; more than the fee does not", () => {
    const ok = runGate([refund(900, "late_delivery")], lateInput(2025));
    expect(chk(ok.decisions[0], "LATE_CONFIRMED")).toMatchObject({ pass: true, detail: "Delivered 5 days after the promised date; threshold is 2 days." });
    expect(chk(ok.decisions[0], "REMEDY_MATCHES_POLICY")).toMatchObject({ pass: true, detail: "This policy refunds the shipping fee ($9.00)." });
    expect(ok.decisions).toHaveLength(1);
    expect(ok.decisions[0].status).toBe("AUTO_APPROVED");

    const over = runGate([refund(901, "late_delivery")], lateInput(2025));
    expect(over.decisions[0].reasonCodes).toEqual(["REMEDY_MATCHES_POLICY"]);
    expect(over.decisions).toHaveLength(1); // no alternative in the shipping-refund branch
    expect(over.route).toBe("deny");
  });

  it("LATE_CONFIRMED uses each version's threshold (2 days in 2025, 3 in 2024/2026)", () => {
    const twoLate = (y: number) => lateInput(y, { deliveredDate: `${y}-03-07` });
    expect(chk(runGate([refund(900, "late_delivery")], twoLate(2025)).decisions[0], "LATE_CONFIRMED").pass).toBe(true);
    const oneLate = runGate([refund(900, "late_delivery")], lateInput(2025, { deliveredDate: "2025-03-06" })).decisions[0];
    expect(chk(oneLate, "LATE_CONFIRMED")).toMatchObject({ pass: false, detail: "Delivered 1 days after the promised date; threshold is 2 days." });
    expect(oneLate.reasonCodes).toEqual(["LATE_CONFIRMED"]);

    const d2024 = runGate([credit(500, "late_delivery", { orderId: "ORD-1001" })], twoLate(2024)).decisions[0];
    expect(chk(d2024, "LATE_CONFIRMED").pass).toBe(false);
    const d2026 = runGate([credit(490, "late_delivery", { orderId: "ORD-1001" })], twoLate(2026)).decisions[0];
    expect(chk(d2026, "LATE_CONFIRMED").pass).toBe(false);
    const three2026 = runGate([credit(490, "late_delivery", { orderId: "ORD-1001" })], lateInput(2026, { deliveredDate: "2026-03-08" })).decisions[0];
    expect(three2026.status).toBe("AUTO_APPROVED");
  });

  it.each([
    [4900, 490],
    [4905, 491],
    [20000, 2000],
    [35000, 2000],
  ])("2026: refund denied, gate offers 10%% of a %i-cent order capped at $20.00 -> %i", (totalCents, expected) => {
    const r = runGate([refund(900, "late_delivery")], lateInput(2026, { totalCents, paidCents: Math.max(totalCents, 4900) }));
    expect(r.decisions[0].reasonCodes).toEqual(["REMEDY_MATCHES_POLICY"]);
    expect(r.decisions[0].alternatives).toEqual([{ type: "store_credit", amountCents: expected, reason: "late_delivery", orderId: "ORD-1001" }]);
    expect(r.decisions[1]).toMatchObject({ addedByGate: true, status: "AUTO_APPROVED", exposureCents: expected });
  });

  it("no credit alternative when the order has not been delivered", () => {
    const r = runGate([refund(900, "late_delivery")], lateInput(2024, { deliveredDate: null, status: "in_transit" }));
    expect(chk(r.decisions[0], "LATE_CONFIRMED")).toMatchObject({ pass: false, detail: "Not delivered yet." });
    expect(r.decisions[0].reasonCodes).toEqual(["LATE_CONFIRMED", "REMEDY_MATCHES_POLICY"]);
    expect(r.decisions[0].alternatives).toEqual([]);
    expect(r.decisions).toHaveLength(1);
    expect(r.route).toBe("deny");
  });

  it("store credit: WITHIN_CREDIT_CAP (hard) per version", () => {
    const cap2026 = (amt: number) => runGate([credit(amt, "late_delivery", { orderId: "ORD-1001" })], lateInput(2026)).decisions[0];
    expect(cap2026(490).status).toBe("AUTO_APPROVED");
    const over = cap2026(491);
    expect(chk(over, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: false, hard: true, detail: "Late-delivery credit for this order is at most $4.90." });
    expect(over.reasonCodes).toEqual(["WITHIN_CREDIT_CAP"]);

    const cap2024 = (amt: number) => runGate([credit(amt, "late_delivery", { orderId: "ORD-1001" })], lateInput(2024)).decisions[0];
    expect(cap2024(500).status).toBe("AUTO_APPROVED");
    expect(cap2024(501).reasonCodes).toEqual(["WITHIN_CREDIT_CAP"]);
  });

  it("store credit in 2025 is denied and the gate adds a shipping-fee refund instead", () => {
    const r = runGate([credit(900, "late_delivery", { orderId: "ORD-1001" })], lateInput(2025));
    const [d, alt] = r.decisions;
    expect(chk(d, "REMEDY_MATCHES_POLICY")).toMatchObject({ pass: false, detail: "This policy refunds the shipping fee instead of giving credit." });
    expect(d.status).toBe("DENIED");
    expect(d.alternatives).toEqual([{ type: "refund", orderId: "ORD-1001", amountCents: 900, reason: "late_delivery" }]);
    expect(alt.addedByGate).toBe(true);
    expect(alt.action).toEqual({ type: "refund", orderId: "ORD-1001", amountCents: 900, reason: "late_delivery" });
    expect(alt.status).toBe("AUTO_APPROVED");
    expect(r.route).toBe("auto");
    expect(r.totalExposureCents).toBe(900);
  });

  it("store credit without an order id fails ORDER_REQUIRED", () => {
    const d = runGate([credit(500, "late_delivery")], lateInput(2024)).decisions[0];
    expect(d.checks).toEqual([{ code: "ORDER_REQUIRED", pass: false, hard: true, detail: "Late-delivery credit must reference an order." }]);
    expect(d.status).toBe("DENIED");
  });

  it.each([2024, 2026])("%i: a refund only 2 days late gets no credit alternative", (y) => {
    const r = runGate([refund(900, "late_delivery")], lateInput(y, { deliveredDate: `${y}-03-07` }));
    expect(chk(r.decisions[0], "LATE_CONFIRMED")).toMatchObject({ pass: false, detail: "Delivered 2 days after the promised date; threshold is 3 days." });
    expect(r.decisions[0].reasonCodes).toEqual(["LATE_CONFIRMED", "REMEDY_MATCHES_POLICY"]);
    expect(r.decisions[0].alternatives).toEqual([]);
    expect(r.decisions).toHaveLength(1);
    expect(r.route).toBe("deny");
  });

  it("2025 store credit: no refund alternative when not late enough or when shipping was free", () => {
    const notLate = runGate([credit(900, "late_delivery", { orderId: "ORD-1001" })], lateInput(2025, { deliveredDate: "2025-03-06" }));
    expect(notLate.decisions[0].reasonCodes).toEqual(["LATE_CONFIRMED", "REMEDY_MATCHES_POLICY"]);
    expect(notLate.decisions[0].alternatives).toEqual([]);
    expect(notLate.decisions).toHaveLength(1);

    const freeShipping = runGate([credit(500, "late_delivery", { orderId: "ORD-1001" })], lateInput(2025, { shippingCents: 0 }));
    expect(chk(freeShipping.decisions[0], "LATE_CONFIRMED").pass).toBe(true);
    expect(freeShipping.decisions[0].reasonCodes).toEqual(["REMEDY_MATCHES_POLICY"]);
    expect(freeShipping.decisions[0].alternatives).toEqual([]);
    expect(freeShipping.decisions).toHaveLength(1);
    expect(freeShipping.route).toBe("deny");
  });

  it("the shipping-delay version follows the order date (2025 order, 2026 claim)", () => {
    const o = makeOrder({ orderDate: "2025-12-20", promisedDate: "2025-12-24", deliveredDate: "2025-12-30", lastTrackingEventDate: "2025-12-30" });
    const input = makeInput({ claimDate: "2026-01-05", orders: [o] });
    const ok = runGate([refund(900, "late_delivery")], input);
    expect(ok.decisions[0].policy?.version).toBe("2025.1");
    expect(chk(ok.decisions[0], "LATE_CONFIRMED").detail).toBe("Delivered 6 days after the promised date; threshold is 2 days.");
    expect(chk(ok.decisions[0], "REMEDY_MATCHES_POLICY")).toMatchObject({ pass: true, detail: "This policy refunds the shipping fee ($9.00)." });
    expect(ok.decisions[0].status).toBe("AUTO_APPROVED");
    expect(ok.decisions).toHaveLength(1);

    // Under the 2026 rules a credit would pass; the order's 2025 rules swap it for a shipping refund.
    const cr = runGate([credit(490, "late_delivery", { orderId: "ORD-1001" })], input);
    expect(cr.decisions[0].policy?.version).toBe("2025.1");
    expect(cr.decisions[0].reasonCodes).toEqual(["REMEDY_MATCHES_POLICY"]);
    expect(cr.decisions[1]).toMatchObject({
      addedByGate: true,
      status: "AUTO_APPROVED",
      action: { type: "refund", orderId: "ORD-1001", amountCents: 900, reason: "late_delivery" },
    });
  });

  it("gate-added refunds still respect ONE_REFUND_PER_RESOLUTION", () => {
    const input = makeInput({ claimDate: "2025-03-12", orders: [lateOrder(2025), lateOrder(2025, { id: "ORD-1002" })] });
    const r = runGate(
      [credit(900, "late_delivery", { orderId: "ORD-1001" }), credit(900, "late_delivery", { orderId: "ORD-1002" })],
      input,
    );
    expect(r.decisions.map((d) => [d.index, d.action.type, d.status, d.addedByGate])).toEqual([
      [0, "store_credit", "DENIED", false],
      [1, "store_credit", "DENIED", false],
      [2, "refund", "AUTO_APPROVED", true],
      [3, "refund", "DENIED", true],
    ]);
    expect(r.decisions[3].action).toEqual({ type: "refund", orderId: "ORD-1002", amountCents: 900, reason: "late_delivery" });
    expect(r.decisions[3].reasonCodes).toEqual(["ONE_REFUND_PER_RESOLUTION"]);
    expect(r.totalExposureCents).toBe(900);
    expect(r.route).toBe("auto");
  });
});

describe("refund: lost_package", () => {
  const lostOrder = (o: Partial<GateOrder> = {}) =>
    makeOrder({ deliveredDate: null, status: "in_transit", lastTrackingEventDate: "2026-09-03", ...o });

  it("LOST_CONFIRMED passes after 10 days without tracking in 2026 and fails at 9", () => {
    const ok = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-09-13", orders: [lostOrder()] })).decisions[0];
    expect(chk(ok, "LOST_CONFIRMED")).toMatchObject({ pass: true, hard: true, detail: "Lost after 10 days without a tracking update." });
    expect(chk(ok, "NO_DOUBLE_REMEDY")).toMatchObject({ pass: true, detail: "Refund instead of replacement." });
    expect(chk(ok, "AMOUNT_WITHIN_ITEM_VALUE")).toMatchObject({ pass: true, detail: "Item value is $40.00." });
    expect(ok.status).toBe("AUTO_APPROVED");
    expect(ok.policy).toEqual({ policyId: "SHIPPING_DELAYS", version: "2026.1", clauseIds: ["§3.2", "§3.3", "§3.4"] });

    const early = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-09-12", orders: [lostOrder()] })).decisions[0];
    expect(early.status).toBe("DENIED");
    expect(early.reasonCodes).toEqual(["LOST_CONFIRMED"]);
  });

  it("status 'lost' confirms immediately; delivered or untracked orders do not", () => {
    const lost = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-09-04", orders: [lostOrder({ status: "lost" })] })).decisions[0];
    expect(chk(lost, "LOST_CONFIRMED").pass).toBe(true);
    const delivered = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-10-30" })).decisions[0];
    expect(chk(delivered, "LOST_CONFIRMED").pass).toBe(false);
    const untracked = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-10-30", orders: [lostOrder({ lastTrackingEventDate: null })] })).decisions[0];
    expect(chk(untracked, "LOST_CONFIRMED").pass).toBe(false);
  });

  it("uses 21 days under the 2024 policy", () => {
    const o = lostOrder({ orderDate: "2024-03-01", promisedDate: "2024-03-05", lastTrackingEventDate: "2024-03-03" });
    const early = runGate([refund(2000, "lost_package")], makeInput({ claimDate: "2024-03-23", orders: [o] })).decisions[0];
    expect(chk(early, "LOST_CONFIRMED")).toMatchObject({ pass: false, detail: "Lost after 21 days without a tracking update." });
    const ok = runGate([refund(2000, "lost_package")], makeInput({ claimDate: "2024-03-24", orders: [o] })).decisions[0];
    expect(ok.status).toBe("AUTO_APPROVED");
  });

  it("NO_DOUBLE_REMEDY fails with a replacement in the plan; AMOUNT_WITHIN_ITEM_VALUE caps at item value", () => {
    const input = makeInput({ claimDate: "2026-09-13", orders: [lostOrder()] });
    const r = runGate([refund(4000, "lost_package"), { type: "replacement", orderId: "ORD-1001", sku: "LMP-01", qty: 1 }], input);
    expect(chk(r.decisions[0], "NO_DOUBLE_REMEDY")).toMatchObject({ pass: false, detail: "A replacement is already in the plan." });
    expect(r.decisions[0].reasonCodes).toEqual(["NO_DOUBLE_REMEDY"]);

    const over = runGate([refund(4001, "lost_package")], input).decisions[0];
    expect(over.reasonCodes).toEqual(["AMOUNT_WITHIN_ITEM_VALUE"]);
  });

  it("the lost-package window follows the order date (2025 order, 2026 claim)", () => {
    const o = lostOrder({ orderDate: "2025-12-20", promisedDate: "2025-12-24", lastTrackingEventDate: "2025-12-24" });
    // 11 days without tracking: lost under 2026 (10 days), not under the order's 2025 policy (14 days).
    const early = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-01-04", orders: [o] })).decisions[0];
    expect(chk(early, "LOST_CONFIRMED")).toMatchObject({ pass: false, detail: "Lost after 14 days without a tracking update." });
    expect(early.policy?.version).toBe("2025.1");
    expect(early.reasonCodes).toEqual(["LOST_CONFIRMED"]);
    const ok = runGate([refund(4000, "lost_package")], makeInput({ claimDate: "2026-01-07", orders: [o] })).decisions[0];
    expect(ok.status).toBe("AUTO_APPROVED");
  });
});

describe("refund / store credit: return", () => {
  it("WITHIN_WINDOW passes on day 30 and fails on day 31 in 2026", () => {
    const o = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
    const ok = runGate([refund(4000, "return")], makeInput({ claimDate: "2026-08-31", orders: [o] })).decisions[0];
    expect(chk(ok, "WITHIN_WINDOW")).toMatchObject({ pass: true, hard: false, detail: "Ordered 30 days ago; return window is 30 days from the order date." });
    expect(ok.status).toBe("AUTO_APPROVED");
    expect(ok.policy).toEqual({ policyId: "RETURNS_STANDARD", version: "2026.1", clauseIds: ["§1.4", "§1.5", "§1.6"] });

    const late = runGate([refund(4000, "return")], makeInput({ claimDate: "2026-09-01", orders: [o] })).decisions[0];
    expect(late.status).toBe("DENIED");
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);
  });

  it("out of window in 2026: refund denied, gate adds out-of-window store credit capped at $25.00", () => {
    const o = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
    const r = runGate([refund(4000, "return")], makeInput({ orders: [o] }));
    const [d, alt] = r.decisions;
    expect(chk(d, "WITHIN_WINDOW")).toEqual({
      code: "WITHIN_WINDOW",
      pass: false,
      hard: false,
      detail: "Ordered 40 days ago; return window is 30 days from the order date.",
    });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["WITHIN_WINDOW"]);
    expect(d.exposureCents).toBe(0);
    expect(d.alternatives).toEqual([{ type: "store_credit", amountCents: 2500, reason: "out_of_window_return", orderId: "ORD-1001" }]);

    expect(alt).toMatchObject({ index: 1, addedByGate: true, status: "AUTO_APPROVED", exposureCents: 2500 });
    expect(codesOf(alt)).toEqual(["ORDER_FOUND", "CATEGORY_ALLOWED", "OUT_OF_WINDOW", "WITHIN_CREDIT_CAP", "NO_DOUBLE_REMEDY"]);
    expect(alt.checks.every((c) => c.pass)).toBe(true);
    expect(alt.policy?.version).toBe("2026.1");
    expect(r.totalExposureCents).toBe(2500);
    expect(r.route).toBe("auto");
  });

  it("the gate-added credit is the refund amount when that is below the cap", () => {
    const o = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
    const r = runGate([refund(1000, "return")], makeInput({ orders: [o] }));
    expect(r.decisions[1].action).toEqual({ type: "store_credit", amountCents: 1000, reason: "out_of_window_return", orderId: "ORD-1001" });
  });

  it("2024: 45-day window, out-of-window credit capped at $15.00", () => {
    const o = makeOrder({ orderDate: "2024-03-01", promisedDate: "2024-03-05", deliveredDate: "2024-03-05" });
    const r = runGate([refund(4000, "return")], makeInput({ claimDate: "2024-05-01", orders: [o] }));
    expect(chk(r.decisions[0], "WITHIN_WINDOW").detail).toBe("Ordered 61 days ago; return window is 45 days from the order date.");
    expect(r.decisions[1].action).toEqual({ type: "store_credit", amountCents: 1500, reason: "out_of_window_return", orderId: "ORD-1001" });
    expect(r.decisions[1].status).toBe("AUTO_APPROVED");
    expect(r.autoLimitCents).toBe(3000);
  });

  it("2025: the same 61-day-old order is still within the 90-day window", () => {
    const o = makeOrder({ orderDate: "2025-03-01", promisedDate: "2025-03-05", deliveredDate: "2025-03-05" });
    const r = runGate([refund(4000, "return")], makeInput({ claimDate: "2025-05-01", orders: [o] }));
    expect(chk(r.decisions[0], "WITHIN_WINDOW")).toMatchObject({ pass: true, detail: "Ordered 61 days ago; return window is 90 days from the order date." });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].status).toBe("AUTO_APPROVED");
  });

  it("the return window follows the order date (2025 order, 2026 claim)", () => {
    const o = makeOrder({ orderDate: "2025-12-15", promisedDate: "2025-12-19", deliveredDate: "2025-12-19" });
    const d = runGate([refund(4000, "return")], makeInput({ claimDate: "2026-02-01", orders: [o] })).decisions[0];
    expect(d.policy?.version).toBe("2025.1");
    expect(chk(d, "WITHIN_WINDOW")).toMatchObject({ pass: true, detail: "Ordered 48 days ago; return window is 90 days from the order date." });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("a return refund on an undelivered order fails DELIVERED", () => {
    const d = runGate([refund(4000, "return")], makeInput({ orders: [makeOrder({ deliveredDate: null, status: "shipped" })] })).decisions[0];
    expect(d.reasonCodes).toEqual(["DELIVERED"]);
  });

  it("store credit out_of_window_return: OUT_OF_WINDOW is hard", () => {
    const d = runGate([credit(2000, "out_of_window_return", { orderId: "ORD-1001" })], makeInput()).decisions[0];
    expect(chk(d, "OUT_OF_WINDOW")).toMatchObject({ pass: false, hard: true });
    expect(d.status).toBe("DENIED");
  });

  it("store credit out_of_window_return: WITHIN_CREDIT_CAP is soft, ORDER_REQUIRED without an order", () => {
    const oow = makeInput({ orders: [makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" })] });
    const ok = runGate([credit(2500, "out_of_window_return", { orderId: "ORD-1001" })], oow).decisions[0];
    expect(chk(ok, "CATEGORY_ALLOWED")).toMatchObject({ pass: true, detail: "Item category allows a return." });
    expect(chk(ok, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: true, hard: false, detail: "Out-of-window credit cap is $25.00." });
    expect(ok.status).toBe("AUTO_APPROVED");

    const over = runGate([credit(2501, "out_of_window_return", { orderId: "ORD-1001" })], oow).decisions[0];
    expect(chk(over, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: false, hard: false });
    expect(over.status).toBe("DENIED");
    expect(over.reasonCodes).toEqual(["WITHIN_CREDIT_CAP"]);

    const noOrder = runGate([credit(1000, "out_of_window_return")], makeInput()).decisions[0];
    expect(noOrder.checks).toEqual([{ code: "ORDER_REQUIRED", pass: false, hard: true, detail: "Out-of-window credit must reference an order." }]);
  });

  it("store credit out_of_window_return follows the order date's cap and categories (2024 order, 2025 claim)", () => {
    const o = makeOrder({ orderDate: "2024-12-01", promisedDate: "2024-12-05", deliveredDate: "2024-12-05" });
    const d = runGate([credit(2000, "out_of_window_return", { orderId: "ORD-1001" })], makeInput({ claimDate: "2025-03-01", orders: [o] })).decisions[0];
    expect(d.policy?.version).toBe("2024.1");
    expect(chk(d, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: false, hard: false, detail: "Out-of-window credit cap is $15.00." });
    expect(d.reasonCodes).toEqual(["WITHIN_CREDIT_CAP"]);

    const clearance = { sku: "CLR-01", name: "Clearance vase", category: "clearance", qty: 1, unitPriceCents: 2000 };
    const c = runGate(
      [credit(1000, "out_of_window_return", { orderId: "ORD-1001" })],
      makeInput({ claimDate: "2025-03-01", orders: [{ ...o, items: [clearance] }] }),
    ).decisions[0];
    expect(c.reasonCodes).toEqual(["CATEGORY_ALLOWED"]);
  });
});

describe("CATEGORY_ALLOWED", () => {
  const giftCard = { sku: "GC-50", name: "Gift card", category: "gift_card", qty: 1, unitPriceCents: 5000 };
  const glass = { sku: "GLS-CUT", name: "Custom-cut glass top", category: "custom_cut_glass", qty: 1, unitPriceCents: 4500 };

  it("denies a return refund on a gift card", () => {
    const o = makeOrder({ items: [giftCard], shippingCents: 0, totalCents: 5000, paidCents: 5000 });
    const d = runGate([refund(5000, "return")], makeInput({ orders: [o] })).decisions[0];
    expect(chk(d, "CATEGORY_ALLOWED")).toEqual({ code: "CATEGORY_ALLOWED", pass: false, hard: true, detail: "Every item on this order is non-refundable." });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["CATEGORY_ALLOWED"]);
  });

  it("custom-cut glass out of window: denied (hard before soft) and no store-credit alternative", () => {
    const o = makeOrder({ orderDate: "2026-08-01", items: [glass], totalCents: 5400, paidCents: 5400 });
    const r = runGate([refund(4500, "return")], makeInput({ orders: [o] }));
    expect(r.decisions[0].reasonCodes).toEqual(["CATEGORY_ALLOWED", "WITHIN_WINDOW"]);
    expect(r.decisions[0].alternatives).toEqual([]);
    expect(r.decisions).toHaveLength(1);
    expect(r.route).toBe("deny");
  });

  it("a mixed order refunds only the refundable items", () => {
    const o = makeOrder({ items: [giftCard, LAMP], totalCents: 9900, paidCents: 9900 });
    const ok = runGate([refund(4000, "return")], makeInput({ orders: [o] })).decisions[0];
    expect(chk(ok, "CATEGORY_ALLOWED")).toMatchObject({ pass: true, detail: "Refundable item value is $40.00." });
    expect(ok.status).toBe("AUTO_APPROVED");
    const over = runGate([refund(4001, "return")], makeInput({ orders: [o] })).decisions[0];
    expect(over.reasonCodes).toEqual(["CATEGORY_ALLOWED"]);
  });

  it("clearance is non-refundable in 2024 but refundable in 2025", () => {
    const clearance = { sku: "CLR-01", name: "Clearance vase", category: "clearance", qty: 1, unitPriceCents: 2000 };
    const o2024 = makeOrder({ orderDate: "2024-03-01", promisedDate: "2024-03-05", deliveredDate: "2024-03-05", items: [clearance] });
    expect(runGate([refund(2000, "return")], makeInput({ claimDate: "2024-03-10", orders: [o2024] })).decisions[0].reasonCodes).toEqual([
      "CATEGORY_ALLOWED",
    ]);
    const o2025 = makeOrder({ orderDate: "2025-03-01", promisedDate: "2025-03-05", deliveredDate: "2025-03-05", items: [clearance] });
    expect(runGate([refund(2000, "return")], makeInput({ claimDate: "2025-03-10", orders: [o2025] })).decisions[0].status).toBe("AUTO_APPROVED");
  });

  it("an out-of-window store credit on a gift card is denied", () => {
    const o = makeOrder({ items: [giftCard] });
    const d = runGate([credit(1000, "out_of_window_return", { orderId: "ORD-1001" })], makeInput({ orders: [o] })).decisions[0];
    expect(chk(d, "CATEGORY_ALLOWED")).toMatchObject({ pass: false, detail: "Item is non-refundable." });
    expect(d.status).toBe("DENIED");
  });
});

describe("goodwill", () => {
  const gold = { id: CUSTOMER, tier: "gold" as const };

  it("a goodwill refund is denied and converted to store credit capped at $20.00 (2026, gold)", () => {
    const r = runGate([refund(3000, "goodwill")], makeInput({ customer: gold }));
    const [d, alt] = r.decisions;
    expect(chk(d, "GOODWILL_IS_STORE_CREDIT_ONLY")).toEqual({
      code: "GOODWILL_IS_STORE_CREDIT_ONLY",
      pass: false,
      hard: true,
      detail: "Goodwill is store credit, never a card refund.",
    });
    expect(d.status).toBe("DENIED");
    expect(d.reasonCodes).toEqual(["GOODWILL_IS_STORE_CREDIT_ONLY"]);
    expect(d.policy).toEqual({ policyId: "GOODWILL_RETENTION", version: "2026.1", clauseIds: ["§5.2", "§5.3", "§5.6"] });
    expect(d.alternatives).toEqual([{ type: "store_credit", amountCents: 2000, reason: "goodwill" }]);
    expect(alt).toMatchObject({ addedByGate: true, status: "AUTO_APPROVED", exposureCents: 2000 });
    expect(r.route).toBe("auto");
    expect(r.totalExposureCents).toBe(2000);
  });

  it("a goodwill refund below the cap converts at the same amount", () => {
    const r = runGate([refund(1000, "goodwill")], makeInput({ customer: gold }));
    expect(r.decisions[0].alternatives).toEqual([{ type: "store_credit", amountCents: 1000, reason: "goodwill" }]);
    expect(r.decisions[1]).toMatchObject({ addedByGate: true, status: "AUTO_APPROVED", exposureCents: 1000 });
    expect(r.totalExposureCents).toBe(1000);
  });

  it("supervisorApproved clears CHURN_EXCEPTION", () => {
    const r = runGate([credit(1500, "goodwill")], makeInput({ customer: gold, churnRisk: "high", supervisorApproved: true }));
    expect(r.decisions[0].status).toBe("AUTO_APPROVED");
    expect(r.decisions[0].reasonCodes).toEqual(["SUPERVISOR_APPROVED"]);
    expect(r.humanReasons).toEqual([]);
    expect(r.route).toBe("auto");
  });

  it("a goodwill refund for an ineligible tier gets no alternative", () => {
    const r = runGate([refund(1000, "goodwill")], makeInput());
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].alternatives).toEqual([]);
    expect(r.route).toBe("deny");
  });

  it("TIER_ELIGIBLE follows the claim-date version", () => {
    const std2026 = runGate([credit(1000, "goodwill")], makeInput()).decisions[0];
    expect(chk(std2026, "TIER_ELIGIBLE")).toMatchObject({ pass: false, hard: true, detail: "Goodwill is available to gold, platinum customers." });
    expect(std2026.reasonCodes).toEqual(["TIER_ELIGIBLE"]);

    const std2025 = runGate([credit(1000, "goodwill")], makeInput({ claimDate: "2025-06-01" })).decisions[0];
    expect(chk(std2025, "TIER_ELIGIBLE").pass).toBe(true);
    expect(std2025.status).toBe("AUTO_APPROVED");

    const gold2024 = runGate([credit(1000, "goodwill")], makeInput({ claimDate: "2024-06-01", customer: gold })).decisions[0];
    expect(chk(gold2024, "TIER_ELIGIBLE")).toMatchObject({ pass: false, detail: "Goodwill is available to platinum customers." });
    const plat2024 = runGate([credit(1500, "goodwill")], makeInput({ claimDate: "2024-06-01", customer: { id: CUSTOMER, tier: "platinum" } })).decisions[0];
    expect(plat2024.status).toBe("AUTO_APPROVED");
  });

  it("WITHIN_CREDIT_CAP is soft: $20.00 passes, $20.01 is denied in 2026", () => {
    const ok = runGate([credit(2000, "goodwill")], makeInput({ customer: gold })).decisions[0];
    expect(chk(ok, "WITHIN_CREDIT_CAP")).toMatchObject({ pass: true, hard: false, detail: "Goodwill cap is $20.00." });
    expect(ok.status).toBe("AUTO_APPROVED");
    const over = runGate([credit(2001, "goodwill")], makeInput({ customer: gold })).decisions[0];
    expect(over.status).toBe("DENIED");
    expect(over.reasonCodes).toEqual(["WITHIN_CREDIT_CAP"]);
  });

  it("GOODWILL_COOLDOWN blocks a second goodwill credit within 90 days (inclusive)", () => {
    const at90 = makeInput({ customer: gold, storeCredits: [{ amountCents: 1000, reason: "goodwill", createdAt: "2026-06-12T09:00:00.000Z" }] });
    const blocked = runGate([credit(1000, "goodwill")], at90).decisions[0];
    expect(chk(blocked, "GOODWILL_COOLDOWN")).toMatchObject({ pass: false, hard: true, detail: "A goodwill credit was issued within 90 days." });
    expect(blocked.reasonCodes).toEqual(["GOODWILL_COOLDOWN"]);

    const at91 = makeInput({ customer: gold, storeCredits: [{ amountCents: 1000, reason: "goodwill", createdAt: "2026-06-11T09:00:00.000Z" }] });
    const ok = runGate([credit(1000, "goodwill")], at91).decisions[0];
    expect(chk(ok, "GOODWILL_COOLDOWN")).toMatchObject({ pass: true, detail: "No recent goodwill credit." });
    expect(ok.status).toBe("AUTO_APPROVED");
  });

  it("a recent non-goodwill credit does not trigger the cooldown", () => {
    const input = makeInput({ customer: gold, storeCredits: [{ amountCents: 500, reason: "late_delivery", createdAt: "2026-09-01T09:00:00.000Z" }] });
    expect(chk(runGate([credit(1000, "goodwill")], input).decisions[0], "GOODWILL_COOLDOWN").pass).toBe(true);
  });

  it("CHURN_EXCEPTION: a high-churn goodwill credit always goes to a human", () => {
    const r = runGate([credit(1500, "goodwill")], makeInput({ customer: gold, churnRisk: "high" }));
    expect(r.decisions[0].status).toBe("NEEDS_HUMAN");
    expect(r.decisions[0].reasonCodes).toEqual(["CHURN_EXCEPTION"]);
    expect(r.humanReasons).toEqual(["CHURN_EXCEPTION"]);
    expect(r.route).toBe("human");

    expect(runGate([credit(1500, "goodwill")], makeInput({ customer: gold, churnRisk: "medium" })).route).toBe("auto");
  });

  it("CHURN_EXCEPTION also applies to a gate-added goodwill credit, but not to other credits or denied goodwill", () => {
    const viaRefund = runGate([refund(3000, "goodwill")], makeInput({ customer: gold, churnRisk: "high" }));
    expect(viaRefund.decisions[1]).toMatchObject({ addedByGate: true, status: "NEEDS_HUMAN", reasonCodes: ["CHURN_EXCEPTION"] });
    expect(viaRefund.route).toBe("human");

    const late = makeOrder({ orderDate: "2026-03-01", promisedDate: "2026-03-05", deliveredDate: "2026-03-10" });
    const other = runGate([credit(490, "late_delivery", { orderId: "ORD-1001" })], makeInput({ claimDate: "2026-03-12", orders: [late], churnRisk: "high" }));
    expect(other.route).toBe("auto");

    const denied = runGate([credit(1500, "goodwill")], makeInput({ churnRisk: "high" })); // standard tier in 2026
    expect(denied.decisions[0].status).toBe("DENIED");
    expect(denied.humanReasons).toEqual([]);
    expect(denied.route).toBe("deny");
  });
});

describe("store credit: damaged / unsupported reason", () => {
  const dmg = (amountCents: number, extra: Partial<Extract<Action, { type: "store_credit" }>> = { orderId: "ORD-1001" }) =>
    credit(amountCents, "damaged", extra);

  it("passes DELIVERED / WITHIN_WINDOW (day 14) / AMOUNT_WITHIN_ITEM_VALUE (exactly item value)", () => {
    const d = runGate([dmg(4000)], makeInput({ claimDate: "2026-09-19" })).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "DELIVERED", "WITHIN_WINDOW", "AMOUNT_WITHIN_ITEM_VALUE", "NO_DOUBLE_REMEDY"]);
    expect(chk(d, "WITHIN_WINDOW")).toEqual({
      code: "WITHIN_WINDOW",
      pass: true,
      hard: false,
      detail: "Reported 14 days after delivery; window is 14 days.",
    });
    expect(chk(d, "AMOUNT_WITHIN_ITEM_VALUE")).toMatchObject({ pass: true, hard: true, detail: "Item value is $40.00." });
    expect(d.policy).toEqual({ policyId: "DAMAGE_TRANSIT", version: "2026.1", clauseIds: ["§4.2", "§4.3"] });
    expect(d.status).toBe("AUTO_APPROVED");
    expect(d.exposureCents).toBe(4000);
  });

  it("fails WITHIN_WINDOW (soft) on day 15 and AMOUNT_WITHIN_ITEM_VALUE one cent above item value", () => {
    const late = runGate([dmg(1000)], makeInput({ claimDate: "2026-09-20" })).decisions[0];
    expect(chk(late, "WITHIN_WINDOW")).toMatchObject({ pass: false, hard: false });
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);
    expect(late.status).toBe("DENIED");

    const over = runGate([dmg(4001)], makeInput()).decisions[0];
    expect(over.reasonCodes).toEqual(["AMOUNT_WITHIN_ITEM_VALUE"]);
    expect(over.exposureCents).toBe(0);
  });

  it("fails DELIVERED for an undelivered order and skips the window check", () => {
    const d = runGate([dmg(1000)], makeInput({ orders: [makeOrder({ deliveredDate: null, status: "shipped" })] })).decisions[0];
    expect(chk(d, "DELIVERED")).toMatchObject({ pass: false, hard: true, detail: "Not delivered yet." });
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "DELIVERED", "AMOUNT_WITHIN_ITEM_VALUE"]);
    expect(d.reasonCodes).toEqual(["DELIVERED"]);
  });

  it("follows the order date's window (2024 order, 2025 claim) and requires an order", () => {
    const o = makeOrder({ orderDate: "2024-12-20", promisedDate: "2024-12-27", deliveredDate: "2024-12-27" });
    const d = runGate([dmg(1000)], makeInput({ claimDate: "2025-01-06", orders: [o] })).decisions[0];
    expect(d.policy?.version).toBe("2024.1");
    expect(chk(d, "WITHIN_WINDOW").detail).toBe("Reported 10 days after delivery; window is 7 days.");
    expect(d.reasonCodes).toEqual(["WITHIN_WINDOW"]);

    const noOrder = runGate([dmg(1000, {})], makeInput()).decisions[0];
    expect(noOrder.checks).toEqual([{ code: "ORDER_REQUIRED", pass: false, hard: true, detail: "Damage credit must reference an order." }]);
    expect(noOrder.status).toBe("DENIED");
  });

  it("an unsupported store-credit reason is denied and the gate adds an escalation", () => {
    const r = runGate([credit(1000, "other")], makeInput());
    expect(r.decisions[0].checks).toEqual([{ code: "SUPPORTED_REASON", pass: false, hard: true, detail: "No policy covers this credit reason." }]);
    expect(r.decisions[0].status).toBe("DENIED");
    expect(r.decisions[0].alternatives).toEqual([{ type: "escalate", reason: "Store credit request without a policy basis" }]);
    expect(r.decisions).toHaveLength(2);
    expect(r.decisions[1]).toMatchObject({
      index: 1,
      addedByGate: true,
      status: "AUTO_APPROVED",
      action: { type: "escalate", reason: "Store credit request without a policy basis" },
    });
    expect(r.totalExposureCents).toBe(0);
    expect(r.route).toBe("auto");
  });
});

describe("replacement", () => {
  const repl = (extra: Partial<Extract<Action, { type: "replacement" }>> = {}): Action => ({
    type: "replacement",
    orderId: "ORD-1001",
    sku: "LMP-01",
    qty: 1,
    reason: "damaged",
    ...extra,
  });

  it("passes every check for an in-stock damaged item below the evidence threshold", () => {
    const d = runGate([repl()], makeInput()).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER", "DELIVERED", "WITHIN_WINDOW", "EVIDENCE_PRESENT", "NO_DUPLICATE_CLAIM", "IN_STOCK"]);
    expect(chk(d, "SKU_IN_ORDER").detail).toBe("Desk lamp x1 on the order.");
    expect(chk(d, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Below the $150.00 evidence threshold." });
    expect(chk(d, "IN_STOCK")).toMatchObject({ pass: true, detail: "3 available." });
    expect(d.status).toBe("AUTO_APPROVED");
    expect(d.exposureCents).toBe(4000);
    expect(d.policy?.policyId).toBe("DAMAGE_TRANSIT");
  });

  it("SKU_IN_ORDER fails for a SKU not on the order and stops evaluating", () => {
    const d = runGate([repl({ sku: "XYZ-99" })], makeInput()).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER"]);
    expect(chk(d, "SKU_IN_ORDER")).toMatchObject({ pass: false, detail: "XYZ-99 is not on ORD-1001." });
    expect(d.status).toBe("DENIED");
    expect(d.exposureCents).toBe(0);
  });

  it("SKU_IN_ORDER fails when asking for more units than were ordered", () => {
    const d = runGate([repl({ qty: 2 })], makeInput()).decisions[0];
    expect(chk(d, "SKU_IN_ORDER").pass).toBe(false);
    expect(d.reasonCodes).toEqual(["SKU_IN_ORDER"]);
  });

  it("NO_DUPLICATE_CLAIM fails when a replacement was already sent", () => {
    const d = runGate([repl()], makeInput({ orders: [makeOrder({ priorReplacements: 1 })] })).decisions[0];
    expect(chk(d, "NO_DUPLICATE_CLAIM")).toMatchObject({ pass: false, detail: "A replacement was already sent for this order." });
    expect(d.reasonCodes).toEqual(["NO_DUPLICATE_CLAIM"]);
  });

  it("IN_STOCK fails when out of stock (or SKU missing from inventory) and a refund alternative is proposed", () => {
    for (const inventory of [{ "LMP-01": 0 }, {}] as Record<string, number>[]) {
      const r = runGate([repl()], makeInput({ inventory }));
      const d = r.decisions[0];
      expect(chk(d, "IN_STOCK")).toMatchObject({ pass: false, detail: "0 available." });
      expect(d.status).toBe("DENIED");
      expect(d.alternatives).toEqual([{ type: "refund", orderId: "ORD-1001", amountCents: 4000, reason: "damaged" }]);
      expect(r.decisions).toHaveLength(2);
      expect(r.decisions[1].addedByGate).toBe(true);
      expect(r.decisions[1].action).toEqual({ type: "refund", orderId: "ORD-1001", amountCents: 4000, reason: "damaged" });
    }
  });

  // BUG: src/lib/policy/gate.ts runGate/evaluate — the refund the gate proposes for an
  // out-of-stock replacement is evaluated against the extended plan, which still contains the
  // (denied) replacement. So `replacementInPlan` is true and NO_DOUBLE_REMEDY caps the refund at
  // the shipping fee ($9.00 in 2026, $0 in 2024/2025). The alternative is therefore always DENIED.
  // Expected: AUTO_APPROVED $40.00 refund. Actual: DENIED with reasonCodes ["NO_DOUBLE_REMEDY"].
  // (Same for lost_package replacements: NO_DOUBLE_REMEDY = !replacementInPlan always fails.)
  it("the gate-added refund for an out-of-stock replacement is approvable", () => {
    const r = runGate([repl()], makeInput({ inventory: { "LMP-01": 0 } }));
    expect(r.decisions[1].status).toBe("AUTO_APPROVED");
    expect(r.route).toBe("auto");
  });

  it("evidence is required above the threshold; a 2026 carrier scan satisfies it", () => {
    const noEvidence = runGate([repl({ sku: "SOF-01" })], makeInput({ orders: [sofaOrder()] })).decisions[0];
    expect(chk(noEvidence, "EVIDENCE_PRESENT")).toMatchObject({ pass: false, detail: "Claims above $150.00 need evidence." });
    expect(noEvidence.alternatives).toEqual([{ type: "ask_customer", question: "Could you attach a photo of the damage so we can send a replacement?" }]);
    expect(noEvidence.status).toBe("DENIED");

    const scanned = runGate([repl({ sku: "SOF-01" })], makeInput({ orders: [sofaOrder({ damageScan: true })] })).decisions[0];
    expect(chk(scanned, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Carrier damage scan counts as evidence." });
    expect(scanned.exposureCents).toBe(20000);
  });

  it("without a reason, a lost order is judged as lost_package (LOST_CONFIRMED)", () => {
    const o = makeOrder({ deliveredDate: null, status: "in_transit", lastTrackingEventDate: "2026-09-03" });
    const d = runGate([repl({ reason: undefined })], makeInput({ claimDate: "2026-09-13", orders: [o] })).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER", "LOST_CONFIRMED", "NO_DUPLICATE_CLAIM", "IN_STOCK"]);
    expect(d.policy?.policyId).toBe("SHIPPING_DELAYS");
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("without a reason, a delivered (not lost) order is judged as damaged", () => {
    const d = runGate([repl({ reason: undefined })], makeInput()).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER", "DELIVERED", "WITHIN_WINDOW", "EVIDENCE_PRESENT", "NO_DUPLICATE_CLAIM", "IN_STOCK"]);
    expect(d.policy).toEqual({ policyId: "DAMAGE_TRANSIT", version: "2026.1", clauseIds: ["§4.2", "§4.3"] });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("an explicit reason overrides the inferred basis", () => {
    // Delivered order, but reason lost_package: judged as lost, and it is not lost.
    const asLost = runGate([repl({ reason: "lost_package" })], makeInput()).decisions[0];
    expect(codesOf(asLost)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER", "LOST_CONFIRMED", "NO_DUPLICATE_CLAIM", "IN_STOCK"]);
    expect(chk(asLost, "LOST_CONFIRMED")).toMatchObject({ pass: false, detail: "Lost after 10 days without a tracking update." });
    expect(asLost.policy?.policyId).toBe("SHIPPING_DELAYS");
    expect(asLost.reasonCodes).toEqual(["LOST_CONFIRMED"]);

    // Lost order, but reason damaged: damage rules apply, and they need a delivery.
    const lost = makeOrder({ deliveredDate: null, status: "in_transit", lastTrackingEventDate: "2026-09-03" });
    const asDamaged = runGate([repl({ reason: "damaged" })], makeInput({ claimDate: "2026-09-13", orders: [lost] })).decisions[0];
    expect(asDamaged.policy?.policyId).toBe("DAMAGE_TRANSIT");
    expect(codesOf(asDamaged)).toEqual(["ORDER_FOUND", "SKU_IN_ORDER", "DELIVERED", "EVIDENCE_PRESENT", "NO_DUPLICATE_CLAIM", "IN_STOCK"]);
    expect(asDamaged.reasonCodes).toEqual(["DELIVERED"]);
  });

  it("exposure is unit price x requested qty; IN_STOCK passes with exactly enough units and fails one short", () => {
    const o = makeOrder({ items: [{ ...LAMP, qty: 3 }], totalCents: 12900, paidCents: 12900 });
    const r = runGate([repl({ qty: 2 })], makeInput({ orders: [o], inventory: { "LMP-01": 2 } }));
    const d = r.decisions[0];
    expect(chk(d, "SKU_IN_ORDER")).toMatchObject({ pass: true, detail: "Desk lamp x3 on the order." });
    expect(chk(d, "IN_STOCK")).toMatchObject({ pass: true, detail: "2 available." });
    expect(d.exposureCents).toBe(8000);
    expect(d.status).toBe("NEEDS_HUMAN"); // $80.00 is above the $50.00 limit
    expect(d.reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
    expect(r.totalExposureCents).toBe(8000);

    const short = runGate([repl({ qty: 2 })], makeInput({ orders: [o], inventory: { "LMP-01": 1 } })).decisions[0];
    expect(chk(short, "IN_STOCK")).toMatchObject({ pass: false, detail: "1 available." });
    expect(short.reasonCodes).toEqual(["IN_STOCK"]);
    expect(short.alternatives).toEqual([{ type: "refund", orderId: "ORD-1001", amountCents: 8000, reason: "damaged" }]);
  });

  it("damage WITHIN_WINDOW is soft: day 14 passes, day 15 is denied", () => {
    const ok = runGate([repl()], makeInput({ claimDate: "2026-09-19" })).decisions[0];
    expect(chk(ok, "WITHIN_WINDOW")).toMatchObject({ pass: true, hard: false, detail: "Reported 14 days after delivery; window is 14 days." });
    expect(ok.status).toBe("AUTO_APPROVED");
    const late = runGate([repl()], makeInput({ claimDate: "2026-09-20" })).decisions[0];
    expect(chk(late, "WITHIN_WINDOW")).toMatchObject({ pass: false, hard: false, detail: "Reported 15 days after delivery; window is 14 days." });
    expect(late.status).toBe("DENIED");
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);
  });

  it("2024 rules (by order date): $50.00 threshold is exclusive, scans do not count, photos do", () => {
    const rug = (cents: number) => ({ sku: "RUG-01", name: "Wool rug", category: "home", qty: 1, unitPriceCents: cents });
    const run = (cents: number, order: Partial<GateOrder> = {}, input: Partial<GateInput> = {}) =>
      runGate(
        [repl({ sku: "RUG-01" })],
        makeInput({
          claimDate: "2025-01-02", // claimed in 2025: the damage rules still come from the 2024 order date
          orders: [makeOrder({ orderDate: "2024-12-20", promisedDate: "2024-12-27", deliveredDate: "2024-12-27", items: [rug(cents)], ...order })],
          inventory: { "RUG-01": 5 },
          ...input,
        }),
      ).decisions[0];

    const atThreshold = run(5000);
    expect(atThreshold.policy?.version).toBe("2024.1");
    expect(chk(atThreshold, "WITHIN_WINDOW").detail).toBe("Reported 6 days after delivery; window is 7 days.");
    expect(chk(atThreshold, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Below the $50.00 evidence threshold." });
    expect(atThreshold.status).toBe("AUTO_APPROVED");

    const oneCentOver = run(5001);
    expect(chk(oneCentOver, "EVIDENCE_PRESENT")).toMatchObject({ pass: false, detail: "Claims above $50.00 need evidence." });
    expect(oneCentOver.reasonCodes).toEqual(["EVIDENCE_PRESENT"]);
    expect(oneCentOver.alternatives).toEqual([{ type: "ask_customer", question: "Could you attach a photo of the damage so we can send a replacement?" }]);

    const scanOnly = run(6000, { damageScan: true });
    expect(chk(scanOnly, "EVIDENCE_PRESENT")).toMatchObject({ pass: false, detail: "Claims above $50.00 need evidence." });
    expect(scanOnly.status).toBe("DENIED");

    const photos = run(6000, {}, { evidenceAttached: true });
    expect(chk(photos, "EVIDENCE_PRESENT")).toMatchObject({ pass: true, detail: "Customer attached evidence." });
    expect(photos.alternatives).toEqual([]);
    expect(photos.status).toBe("NEEDS_HUMAN"); // $60.00 > the 2025 (claim-date) $50.00 limit
  });

  it("a lost-package replacement follows the order date's lost window (2025 order, 2026 claim)", () => {
    const o = makeOrder({ orderDate: "2025-12-20", promisedDate: "2025-12-24", deliveredDate: null, status: "in_transit", lastTrackingEventDate: "2025-12-24" });
    const early = runGate([repl({ reason: "lost_package" })], makeInput({ claimDate: "2026-01-04", orders: [o] })).decisions[0];
    expect(chk(early, "LOST_CONFIRMED")).toMatchObject({ pass: false, detail: "Lost after 14 days without a tracking update." });
    expect(early.policy?.version).toBe("2025.1");
    expect(early.reasonCodes).toEqual(["LOST_CONFIRMED"]);
    const ok = runGate([repl({ reason: "lost_package" })], makeInput({ claimDate: "2026-01-07", orders: [o] })).decisions[0];
    expect(ok.status).toBe("AUTO_APPROVED");
  });

  it("an out-of-stock lost-package replacement proposes a lost_package refund", () => {
    const o = makeOrder({ deliveredDate: null, status: "lost" });
    const r = runGate([repl({ reason: "lost_package" })], makeInput({ orders: [o], inventory: {} }));
    expect(r.decisions[0].reasonCodes).toEqual(["IN_STOCK"]);
    expect(r.decisions[0].alternatives).toEqual([{ type: "refund", orderId: "ORD-1001", amountCents: 4000, reason: "lost_package" }]);
    expect(r.decisions[1]).toMatchObject({
      index: 1,
      addedByGate: true,
      action: { type: "refund", orderId: "ORD-1001", amountCents: 4000, reason: "lost_package" },
    });
  });

  // BUG (same root cause as the damaged case above): the proposed lost_package refund is judged
  // against the extended plan that still holds the denied replacement, so
  // NO_DOUBLE_REMEDY = !replacementInPlan always fails. Expected AUTO_APPROVED; actual DENIED.
  it("the gate-added refund for an out-of-stock lost-package replacement is approvable", () => {
    const o = makeOrder({ deliveredDate: null, status: "lost" });
    const r = runGate([repl({ reason: "lost_package" })], makeInput({ orders: [o], inventory: {} }));
    expect(r.decisions[1].status).toBe("AUTO_APPROVED");
    expect(r.route).toBe("auto");
  });
});

describe("return_label", () => {
  it("RETURN_LABEL_PROVIDED is false for damage under 2024 and true for 2025/2026", () => {
    const o2024 = makeOrder({ orderDate: "2024-05-01", promisedDate: "2024-05-04", deliveredDate: "2024-05-04" });
    const d2024 = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "damaged" }], makeInput({ claimDate: "2024-05-06", orders: [o2024] })).decisions[0];
    expect(chk(d2024, "RETURN_LABEL_PROVIDED")).toEqual({
      code: "RETURN_LABEL_PROVIDED",
      pass: false,
      hard: true,
      detail: "Under this policy the customer keeps the damaged item.",
    });
    expect(d2024.status).toBe("DENIED");
    expect(d2024.reasonCodes).toEqual(["RETURN_LABEL_PROVIDED"]);

    const o2025 = makeOrder({ orderDate: "2025-05-01", promisedDate: "2025-05-04", deliveredDate: "2025-05-04" });
    const d2025 = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "damaged" }], makeInput({ claimDate: "2025-05-06", orders: [o2025] })).decisions[0];
    expect(chk(d2025, "RETURN_LABEL_PROVIDED")).toMatchObject({ pass: true, detail: "Policy provides a prepaid label for damaged items." });
    expect(d2025.status).toBe("AUTO_APPROVED");

    const d2026 = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "damaged" }], makeInput()).decisions[0];
    expect(d2026.status).toBe("AUTO_APPROVED");
    expect(d2026.exposureCents).toBe(0);
  });

  it("infers the damaged basis from a carrier damage scan", () => {
    const d = runGate([{ type: "return_label", orderId: "ORD-1001" }], makeInput({ orders: [makeOrder({ damageScan: true })] })).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "RETURN_LABEL_PROVIDED", "NO_ACTIVE_LABEL"]);
    expect(d.checks.every((c) => c.pass)).toBe(true);
    expect(d.policy?.policyId).toBe("DAMAGE_TRANSIT");
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("without a reason and without a damage scan, the return basis is used", () => {
    const d = runGate([{ type: "return_label", orderId: "ORD-1001" }], makeInput()).decisions[0];
    expect(codesOf(d)).toEqual(["ORDER_FOUND", "DELIVERED", "CATEGORY_ALLOWED", "WITHIN_WINDOW", "NO_ACTIVE_LABEL"]);
    expect(d.policy).toEqual({ policyId: "RETURNS_STANDARD", version: "2026.1", clauseIds: ["§1.4", "§1.5", "§1.6"] });
    expect(d.status).toBe("AUTO_APPROVED");
  });

  it("the damage label rule follows the order date (2024 order claimed in 2025 gets no label)", () => {
    const o = makeOrder({ orderDate: "2024-12-20", promisedDate: "2024-12-27", deliveredDate: "2024-12-27" });
    const d = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "damaged" }], makeInput({ claimDate: "2025-01-02", orders: [o] })).decisions[0];
    expect(d.policy?.version).toBe("2024.1");
    expect(d.reasonCodes).toEqual(["RETURN_LABEL_PROVIDED"]);
    expect(d.status).toBe("DENIED");
  });

  it("return basis: gift card fails CATEGORY_ALLOWED, undelivered fails DELIVERED", () => {
    const giftCard = { sku: "GC-50", name: "Gift card", category: "gift_card", qty: 1, unitPriceCents: 5000 };
    const gc = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "return" }], makeInput({ orders: [makeOrder({ items: [giftCard] })] })).decisions[0];
    expect(chk(gc, "CATEGORY_ALLOWED")).toMatchObject({ pass: false, hard: true, detail: "Item is non-refundable." });
    expect(gc.reasonCodes).toEqual(["CATEGORY_ALLOWED"]);

    const undelivered = runGate(
      [{ type: "return_label", orderId: "ORD-1001", reason: "return" }],
      makeInput({ orders: [makeOrder({ deliveredDate: null, status: "shipped" })] }),
    ).decisions[0];
    expect(chk(undelivered, "DELIVERED")).toMatchObject({ pass: false, hard: true, detail: "Not delivered yet." });
    expect(undelivered.reasonCodes).toEqual(["DELIVERED"]);
  });

  it("return basis WITHIN_WINDOW is soft, inclusive, and follows the order date", () => {
    const label: Action = { type: "return_label", orderId: "ORD-1001", reason: "return" };
    const o = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
    const ok = runGate([label], makeInput({ claimDate: "2026-08-31", orders: [o] })).decisions[0];
    expect(chk(ok, "WITHIN_WINDOW")).toMatchObject({ pass: true, hard: false, detail: "Ordered 30 days ago; return window is 30 days." });
    expect(ok.status).toBe("AUTO_APPROVED");
    const late = runGate([label], makeInput({ claimDate: "2026-09-01", orders: [o] })).decisions[0];
    expect(chk(late, "WITHIN_WINDOW")).toMatchObject({ pass: false, hard: false, detail: "Ordered 31 days ago; return window is 30 days." });
    expect(late.status).toBe("DENIED");
    expect(late.reasonCodes).toEqual(["WITHIN_WINDOW"]);

    // 2025 order claimed in 2026: the 2025 90-day window (2026 would be 30).
    const o2025 = makeOrder({ orderDate: "2025-12-01", promisedDate: "2025-12-05", deliveredDate: "2025-12-05" });
    const d2025 = runGate([label], makeInput({ claimDate: "2026-01-20", orders: [o2025] })).decisions[0];
    expect(d2025.policy?.version).toBe("2025.1");
    expect(chk(d2025, "WITHIN_WINDOW")).toMatchObject({ pass: true, detail: "Ordered 50 days ago; return window is 90 days." });
    expect(d2025.status).toBe("AUTO_APPROVED");
  });

  it("return basis checks delivery, category, window and an existing label", () => {
    const ok = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "return" }], makeInput()).decisions[0];
    expect(codesOf(ok)).toEqual(["ORDER_FOUND", "DELIVERED", "CATEGORY_ALLOWED", "WITHIN_WINDOW", "NO_ACTIVE_LABEL"]);
    expect(ok.policy?.policyId).toBe("RETURNS_STANDARD");
    expect(ok.status).toBe("AUTO_APPROVED");

    const dup = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "return" }], makeInput({ orders: [makeOrder({ activeLabels: 1 })] })).decisions[0];
    expect(chk(dup, "NO_ACTIVE_LABEL")).toMatchObject({ pass: false, detail: "An active return label already exists." });
    expect(dup.reasonCodes).toEqual(["NO_ACTIVE_LABEL"]);
  });
});

describe("approval tiers and routing", () => {
  const sofa = () => makeInput({ orders: [sofaOrder()] });

  it("AUTO under the standard $50.00 limit", () => {
    const r = runGate([refund(4000, "return")], makeInput());
    expect(r.autoLimitCents).toBe(5000);
    expect(r.decisions[0].status).toBe("AUTO_APPROVED");
    expect(r.decisions[0].reasonCodes).toEqual([]);
    expect(r.humanReasons).toEqual([]);
    expect(r.route).toBe("auto");
    expect(r.approvalPolicy).toEqual({ policyId: "APPROVAL_AUTHORITY", version: "2026.1", clauseIds: ["§6.1", "§6.2", "§6.4"] });
  });

  it("exactly at the limit is AUTO; one cent above needs a human", () => {
    expect(runGate([refund(5000, "return")], sofa()).route).toBe("auto");
    const r = runGate([refund(5001, "return")], sofa());
    expect(r.decisions[0].status).toBe("NEEDS_HUMAN");
    expect(r.decisions[0].reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
    expect(r.humanReasons).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
    expect(r.totalExposureCents).toBe(5001);
    expect(r.route).toBe("human");
  });

  it("platinum (VIP) customers get the $100.00 limit; gold does not", () => {
    const plat = (amt: number) => runGate([refund(amt, "return")], makeInput({ customer: { id: CUSTOMER, tier: "platinum" }, orders: [sofaOrder()] }));
    expect(plat(6000).autoLimitCents).toBe(10000);
    expect(plat(6000).route).toBe("auto");
    expect(plat(10000).route).toBe("auto");
    expect(plat(10001).route).toBe("human");

    const gold = runGate([refund(6000, "return")], makeInput({ customer: { id: CUSTOMER, tier: "gold" }, orders: [sofaOrder()] }));
    expect(gold.autoLimitCents).toBe(5000);
    expect(gold.route).toBe("human");
  });

  it("2024 limits ($30.00 / $75.00 VIP) follow the claim date", () => {
    const o = sofaOrder({ orderDate: "2024-05-01", promisedDate: "2024-05-04", deliveredDate: "2024-05-04" });
    const std = runGate([refund(3001, "return")], makeInput({ claimDate: "2024-05-10", orders: [o] }));
    expect(std.autoLimitCents).toBe(3000);
    expect(std.route).toBe("human");
    expect(runGate([refund(3000, "return")], makeInput({ claimDate: "2024-05-10", orders: [o] })).route).toBe("auto");
    const vip = runGate([refund(7500, "return")], makeInput({ claimDate: "2024-05-10", orders: [o], customer: { id: CUSTOMER, tier: "platinum" } }));
    expect(vip.autoLimitCents).toBe(7500);
    expect(vip.route).toBe("auto");
  });

  it("autoLimitOverrideCents replaces the policy limit", () => {
    const r = runGate([refund(1500, "return")], makeInput({ autoLimitOverrideCents: 1000 }));
    expect(r.autoLimitCents).toBe(1000);
    expect(r.decisions[0].reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
  });

  it("the limit applies to the total of all live actions; denied actions do not count", () => {
    const r = runGate([refund(3000, "return"), { type: "replacement", orderId: "ORD-1001", sku: "LMP-01", qty: 1, reason: "damaged" }], makeInput());
    expect(r.totalExposureCents).toBe(7000);
    expect(r.decisions.map((d) => d.status)).toEqual(["NEEDS_HUMAN", "NEEDS_HUMAN"]);
    expect(r.decisions.map((d) => d.reasonCodes)).toEqual([["AMOUNT_ABOVE_AUTO_LIMIT"], ["AMOUNT_ABOVE_AUTO_LIMIT"]]);
    expect(r.humanReasons).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);

    const input = makeInput({ orders: [makeOrder(), makeOrder({ id: "ORD-1002" })] });
    const withDenied = runGate([refund(4000, "return"), refund(4000, "return", { orderId: "ORD-1002" })], input);
    expect(withDenied.decisions.map((d) => d.status)).toEqual(["AUTO_APPROVED", "DENIED"]);
    expect(withDenied.decisions[1].exposureCents).toBe(0);
    expect(withDenied.totalExposureCents).toBe(4000);
    expect(withDenied.route).toBe("auto");
  });

  it("FIREWALL_FLAGGED forces a human only when money is involved", () => {
    const money = runGate([refund(1000, "return")], makeInput({ firewallFlagged: true }));
    expect(money.decisions[0].status).toBe("NEEDS_HUMAN");
    expect(money.decisions[0].reasonCodes).toEqual(["FIREWALL_FLAGGED"]);
    expect(money.humanReasons).toEqual(["FIREWALL_FLAGGED"]);
    expect(money.route).toBe("human");

    const noMoney = runGate(
      [{ type: "return_label", orderId: "ORD-1001", reason: "return" }, { type: "escalate", reason: "Customer asked for a person" }],
      makeInput({ firewallFlagged: true }),
    );
    expect(noMoney.totalExposureCents).toBe(0);
    expect(noMoney.decisions.map((d) => d.status)).toEqual(["AUTO_APPROVED", "AUTO_APPROVED"]);
    expect(noMoney.humanReasons).toEqual([]);
    expect(noMoney.route).toBe("auto");
  });

  it("a replacement counts as exposure, so a flagged replacement-only plan needs a human", () => {
    const r = runGate([{ type: "replacement", orderId: "ORD-1001", sku: "LMP-01", qty: 1, reason: "damaged" }], makeInput({ firewallFlagged: true }));
    expect(r.totalExposureCents).toBe(4000);
    expect(r.decisions[0].status).toBe("NEEDS_HUMAN");
    expect(r.decisions[0].reasonCodes).toEqual(["FIREWALL_FLAGGED"]);
    expect(r.route).toBe("human");
  });

  it("SOCIAL_ENGINEERING_SIGNAL forces a human only when money is involved", () => {
    const money = runGate([refund(1000, "return")], makeInput({ socialSignals: ["authority_claim"] }));
    expect(money.decisions[0].reasonCodes).toEqual(["SOCIAL_ENGINEERING_SIGNAL"]);
    expect(money.route).toBe("human");

    const noMoney = runGate([{ type: "return_label", orderId: "ORD-1001", reason: "return" }], makeInput({ socialSignals: ["urgency_pressure"] }));
    expect(noMoney.route).toBe("auto");
    expect(noMoney.humanReasons).toEqual([]);
  });

  it("a flagged plan whose money actions are all denied routes to deny, not human", () => {
    const r = runGate([refund(9999, "return")], makeInput({ firewallFlagged: true, socialSignals: ["instruction_override"] }));
    expect(r.decisions[0].status).toBe("DENIED");
    expect(r.humanReasons).toEqual([]);
    expect(r.route).toBe("deny");
  });

  it("human reasons accumulate in a fixed order", () => {
    const r = runGate([refund(6000, "return")], makeInput({ orders: [sofaOrder()], firewallFlagged: true, socialSignals: ["authority_claim"] }));
    expect(r.humanReasons).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT", "FIREWALL_FLAGGED", "SOCIAL_ENGINEERING_SIGNAL"]);
    expect(r.decisions[0].reasonCodes).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT", "FIREWALL_FLAGGED", "SOCIAL_ENGINEERING_SIGNAL"]);
  });

  it("supervisorApproved re-check approves what needed a human", () => {
    const r = runGate([refund(6000, "return")], makeInput({ orders: [sofaOrder()], firewallFlagged: true, supervisorApproved: true }));
    expect(r.decisions[0].status).toBe("AUTO_APPROVED");
    expect(r.decisions[0].reasonCodes).toEqual(["SUPERVISOR_APPROVED"]);
    expect(r.humanReasons).toEqual([]);
    expect(r.totalExposureCents).toBe(6000);
    expect(r.route).toBe("auto");
  });

  it("supervisorApproved still enforces hard checks and non-exception soft checks", () => {
    const hard = runGate([refund(30000, "return")], makeInput({ orders: [sofaOrder()], supervisorApproved: true }));
    expect(hard.decisions[0].status).toBe("DENIED");
    expect(hard.decisions[0].reasonCodes).toEqual(["AMOUNT_WITHIN_PAID", "CATEGORY_ALLOWED"]);
    expect(hard.route).toBe("deny");

    const late = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
    const soft = runGate([refund(4000, "return")], makeInput({ orders: [late], supervisorApproved: true }));
    expect(soft.decisions[0].status).toBe("DENIED");
    expect(soft.decisions[0].reasonCodes).toEqual(["WITHIN_WINDOW"]);
    expect(soft.decisions[1]).toMatchObject({ addedByGate: true, status: "AUTO_APPROVED", reasonCodes: ["SUPERVISOR_APPROVED"] });
  });

  describe("exception: true (soft-check override)", () => {
    // Damage reported on day 15 of a 14-day window: only the soft WITHIN_WINDOW check fails,
    // and no alternative is proposed, so the exception path is isolated.
    const lateDamage = (i: Partial<GateInput> = {}) => makeInput({ claimDate: "2026-09-20", ...i });
    const exceptional = refund(1000, "damaged", { exception: true });

    it("is honoured for platinum customers (goes to a human)", () => {
      const r = runGate([exceptional], lateDamage({ customer: { id: CUSTOMER, tier: "platinum" } }));
      expect(r.decisions[0].status).toBe("NEEDS_HUMAN");
      expect(r.decisions[0].reasonCodes).toEqual(["POLICY_EXCEPTION_REQUESTED", "WITHIN_WINDOW"]);
      expect(r.humanReasons).toEqual(["POLICY_EXCEPTION_REQUESTED"]);
      expect(r.totalExposureCents).toBe(1000);
      expect(r.route).toBe("human");
    });

    it("is honoured for high churn risk regardless of tier", () => {
      const r = runGate([exceptional], lateDamage({ churnRisk: "high" }));
      expect(r.decisions[0].status).toBe("NEEDS_HUMAN");
      expect(r.decisions[0].reasonCodes).toEqual(["POLICY_EXCEPTION_REQUESTED", "WITHIN_WINDOW"]);
    });

    it.each([
      ["standard", "low"],
      ["gold", "medium"],
    ] as const)("is ignored for %s tier with %s churn", (tier, churnRisk) => {
      const r = runGate([exceptional], lateDamage({ customer: { id: CUSTOMER, tier }, churnRisk }));
      expect(r.decisions[0].status).toBe("DENIED");
      expect(r.decisions[0].reasonCodes).toEqual(["WITHIN_WINDOW"]);
      expect(r.route).toBe("deny");
    });

    it("exception: false (or absent) is not an exception request, even for platinum", () => {
      const plat = { id: CUSTOMER, tier: "platinum" as const };
      for (const action of [refund(1000, "damaged", { exception: false }), refund(1000, "damaged")]) {
        const r = runGate([action], lateDamage({ customer: plat }));
        expect(r.decisions[0].status).toBe("DENIED");
        expect(r.decisions[0].reasonCodes).toEqual(["WITHIN_WINDOW"]);
        expect(r.humanReasons).toEqual([]);
        expect(r.route).toBe("deny");
      }
    });

    it("never overrides a hard check", () => {
      const notDelivered = lateDamage({ customer: { id: CUSTOMER, tier: "platinum" }, orders: [makeOrder({ deliveredDate: null, status: "shipped" })] });
      const r = runGate([exceptional], notDelivered);
      expect(r.decisions[0].status).toBe("DENIED");
      expect(r.decisions[0].reasonCodes).toEqual(["DELIVERED"]);
    });

    it("is approved on a supervisor re-check", () => {
      const r = runGate([exceptional], lateDamage({ customer: { id: CUSTOMER, tier: "platinum" }, supervisorApproved: true }));
      expect(r.decisions[0].status).toBe("AUTO_APPROVED");
      expect(r.decisions[0].reasonCodes).toEqual(["SUPERVISOR_EXCEPTION", "SUPERVISOR_APPROVED"]);
      expect(r.humanReasons).toEqual([]);
      expect(r.route).toBe("auto");
    });

    it("is still denied on a supervisor re-check when the customer is not eligible", () => {
      const r = runGate([exceptional], lateDamage({ supervisorApproved: true }));
      expect(r.decisions[0].status).toBe("DENIED");
      expect(r.decisions[0].reasonCodes).toEqual(["WITHIN_WINDOW"]);
    });

    it("covers a duplicate charge reported late and a goodwill credit over the cap", () => {
      const o = makeOrder({
        orderDate: "2026-01-05",
        captures: [cap("A", 4900, "2026-01-05T10:00:00.000Z"), cap("B", 4900, "2026-01-05T10:03:00.000Z")],
        paidCents: 9800,
      });
      const plat = { id: CUSTOMER, tier: "platinum" as const };
      const dup = runGate([refund(4900, "duplicate_charge", { exception: true })], makeInput({ claimDate: "2026-05-06", orders: [o], customer: plat }));
      expect(dup.decisions[0].reasonCodes).toEqual(["POLICY_EXCEPTION_REQUESTED", "REPORTED_IN_TIME"]);

      const gw = runGate([credit(2500, "goodwill", { exception: true })], makeInput({ customer: plat }));
      expect(gw.decisions[0].status).toBe("NEEDS_HUMAN");
      expect(gw.decisions[0].reasonCodes).toEqual(["POLICY_EXCEPTION_REQUESTED", "WITHIN_CREDIT_CAP"]);
    });

    // BUG: src/lib/policy/gate.ts runGate — when an out-of-window return refund carries
    // exception:true for an eligible customer, the refund goes to NEEDS_HUMAN (exception path) but
    // the gate ALSO appends its fallback out-of-window store credit as a live NEEDS_HUMAN action.
    // Both count toward exposure ($40.00 + $25.00 = $65.00) and, on a plain supervisor "approve",
    // the HITL re-check (src/lib/agent/nodes/hitl.ts -> runGate(..., supervisorApproved)) approves
    // BOTH, so the customer gets a full refund plus store credit for one return (double remedy).
    // Expected: only the exception refund is live (exposure $40.00). Actual: two live remedies.
    it("an exception refund does not also queue the gate's fallback store credit", () => {
      const o = makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05" });
      const input = makeInput({ customer: { id: CUSTOMER, tier: "platinum" }, orders: [o] });
      const first = runGate([refund(4000, "return", { exception: true })], input);
      expect(first.decisions[0].status).toBe("NEEDS_HUMAN");
      const live = first.decisions.filter((d) => d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED");
      expect(live).toHaveLength(1);
      expect(first.totalExposureCents).toBe(4000);

      const recheck = runGate(live.map((d) => d.action), { ...input, supervisorApproved: true });
      const approvedMoney = recheck.decisions.filter((d) => d.status === "AUTO_APPROVED" && (d.action.type === "refund" || d.action.type === "store_credit"));
      expect(approvedMoney).toHaveLength(1);
    });
  });

  describe("route values and non-executable actions", () => {
    it("deny / ask_customer are INFO with no checks or exposure; an INFO-only plan routes to deny", () => {
      const r = runGate(
        [
          { type: "ask_customer", question: "Which order is this about?" },
          { type: "deny", reason: "Outside policy" },
        ],
        makeInput(),
      );
      for (const d of r.decisions) {
        expect(d).toMatchObject({ status: "INFO", checks: [], reasonCodes: [], exposureCents: 0, policy: null, addedByGate: false });
      }
      expect(r.route).toBe("deny");
      expect(r.totalExposureCents).toBe(0);
    });

    it("escalate is always allowed and routes auto", () => {
      const r = runGate([{ type: "escalate", reason: "Needs a specialist" }], makeInput());
      expect(r.decisions[0].checks).toEqual([
        { code: "ESCALATION_ALLOWED", pass: true, hard: true, detail: "Handing off to a human specialist is always allowed." },
      ]);
      expect(r.decisions[0].status).toBe("AUTO_APPROVED");
      expect(r.route).toBe("auto");
    });

    it("an unsupported refund reason is denied and the gate adds an escalation", () => {
      const r = runGate([refund(1000, "other")], makeInput());
      expect(codesOf(r.decisions[0])).toEqual(["ORDER_FOUND", "AMOUNT_WITHIN_PAID", "NO_DUPLICATE_CLAIM", "ONE_REFUND_PER_RESOLUTION", "SUPPORTED_REASON"]);
      expect(chk(r.decisions[0], "SUPPORTED_REASON")).toMatchObject({
        pass: false,
        hard: true,
        detail: "No policy covers this refund reason; a specialist must review it.",
      });
      expect(r.decisions[0].policy).toBeNull();
      expect(r.decisions[0].reasonCodes).toEqual(["SUPPORTED_REASON"]);
      expect(r.decisions).toHaveLength(2);
      expect(r.decisions[1]).toMatchObject({
        addedByGate: true,
        status: "AUTO_APPROVED",
        action: { type: "escalate", reason: "Refund request without a policy basis" },
      });
      expect(r.route).toBe("auto");
    });

    it("route is human if any decision needs a human, even alongside approvals and denials", () => {
      const input = makeInput({ orders: [sofaOrder(), makeOrder({ id: "ORD-1002", customerId: "CUS-2002" })] });
      const r = runGate(
        [refund(6000, "return"), { type: "return_label", orderId: "ORD-1002", reason: "return" }, { type: "ask_customer", question: "Anything else?" }],
        input,
      );
      expect(r.decisions.map((d) => d.status)).toEqual(["NEEDS_HUMAN", "DENIED", "INFO"]);
      expect(r.route).toBe("human");
    });
  });
});

describe("gate-added alternatives: de-duplication against the plan", () => {
  const oowOrder = (o: Partial<GateOrder> = {}) =>
    makeOrder({ orderDate: "2026-08-01", promisedDate: "2026-08-05", deliveredDate: "2026-08-05", ...o });

  it("are not added when the plan already has the same kind of action for that order", () => {
    const r = runGate(
      [refund(4000, "return"), credit(2500, "out_of_window_return", { orderId: "ORD-1001" })],
      makeInput({ orders: [oowOrder()] }),
    );
    expect(r.decisions).toHaveLength(2);
    expect(r.decisions.map((d) => [d.action.type, d.status, d.addedByGate])).toEqual([
      ["refund", "DENIED", false],
      ["store_credit", "AUTO_APPROVED", false],
    ]);
    // The refund still records what it would have proposed.
    expect(r.decisions[0].alternatives).toEqual([{ type: "store_credit", amountCents: 2500, reason: "out_of_window_return", orderId: "ORD-1001" }]);
    expect(r.totalExposureCents).toBe(2500);
    expect(r.route).toBe("auto");
  });

  it("are still added when the same kind of action targets a different order", () => {
    const input = makeInput({ orders: [oowOrder(), oowOrder({ id: "ORD-1002" })] });
    const r = runGate([refund(4000, "return"), credit(1000, "out_of_window_return", { orderId: "ORD-1002" })], input);
    expect(r.decisions).toHaveLength(3);
    expect(r.decisions[2]).toMatchObject({
      index: 2,
      addedByGate: true,
      status: "AUTO_APPROVED",
      exposureCents: 2500,
      action: { type: "store_credit", amountCents: 2500, reason: "out_of_window_return", orderId: "ORD-1001" },
    });
    expect(r.totalExposureCents).toBe(3500);
    expect(r.route).toBe("auto");
  });
});
