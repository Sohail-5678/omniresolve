/**
 * N4b — the policy gate. Pure, deterministic code that judges every action the planner
 * proposed against the versioned rules and the customer's real data, and returns
 * AUTO_APPROVED / NEEDS_HUMAN / DENIED per action with reason codes.
 *
 * The LLM proposes; this decides. Nothing here trusts the plan's numbers: amounts are
 * checked against the ledger, windows against real dates, claims against carrier scans.
 * Limits: one primary order per action; categories are checked per order, not per line.
 */
import type { Action } from "@/lib/agent/schemas";
import { daysBetween } from "@/lib/util/dates";
import { formatCents } from "@/lib/util/money";
import { policyFor, isVip, type PolicyId, type Tier } from "./rules";

export type DecisionStatus = "AUTO_APPROVED" | "NEEDS_HUMAN" | "DENIED" | "INFO";

export type Check = { code: string; pass: boolean; hard: boolean; detail: string };

export type GateOrder = {
  id: string;
  customerId: string;
  orderDate: string;
  promisedDate: string;
  deliveredDate: string | null;
  status: string;
  shippingCents: number;
  totalCents: number;
  items: { sku: string; name: string; category: string; qty: number; unitPriceCents: number }[];
  captures: { id: string; amountCents: number; capturedAt: string }[];
  paidCents: number;
  refundedCents: number;
  priorRefunds: { amountCents: number; reason: string }[];
  priorReplacements: number;
  activeLabels: number;
  damageScan: boolean;
  lastTrackingEventDate: string | null;
};

export type GateInput = {
  claimDate: string;
  customer: { id: string; tier: Tier };
  churnRisk: "low" | "medium" | "high";
  orders: GateOrder[];
  storeCredits: { amountCents: number; reason: string; createdAt: string }[];
  inventory: Record<string, number>;
  evidenceAttached: boolean;
  firewallFlagged: boolean;
  socialSignals: string[];
  /** Set when re-checking a plan a supervisor approved or modified. */
  supervisorApproved?: boolean;
  autoLimitOverrideCents?: number;
};

export type PolicyRef = { policyId: PolicyId; version: string; clauseIds: string[] };

export type ActionDecision = {
  index: number;
  action: Action;
  status: DecisionStatus;
  checks: Check[];
  reasonCodes: string[];
  policy: PolicyRef | null;
  exposureCents: number;
  alternatives: Action[];
  addedByGate: boolean;
};

export type GateResult = {
  decisions: ActionDecision[];
  route: "auto" | "human" | "deny";
  totalExposureCents: number;
  autoLimitCents: number;
  approvalPolicy: PolicyRef;
  humanReasons: string[];
};

const EXECUTABLE = new Set(["refund", "store_credit", "replacement", "return_label", "escalate"]);

type Draft = Omit<ActionDecision, "status" | "reasonCodes"> & { exceptionAllowed: boolean };

function check(code: string, pass: boolean, hard: boolean, detail: string): Check {
  return { code, pass, hard, detail };
}

function ref(policyId: PolicyId, date: string): PolicyRef {
  const p = policyFor(policyId, date);
  return { policyId, version: p.version, clauseIds: p.clauseIds };
}

function itemValue(order: GateOrder): number {
  return order.items.reduce((sum, i) => sum + i.unitPriceCents * i.qty, 0);
}

/** Two or more captures of the same amount on one order inside the window hours. */
export function findDuplicateCapture(
  captures: GateOrder["captures"],
  windowHours: number,
): { amountCents: number; count: number; lastCapturedAt: string } | null {
  const byAmount = new Map<number, string[]>();
  for (const c of captures) byAmount.set(c.amountCents, [...(byAmount.get(c.amountCents) ?? []), c.capturedAt]);
  let best: { amountCents: number; count: number; lastCapturedAt: string } | null = null;
  for (const [amountCents, times] of byAmount) {
    if (times.length < 2) continue;
    const sorted = times.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
    let count = 1;
    let last = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] <= windowHours * 3_600_000) {
        count++;
        last = sorted[i];
      }
    }
    if (count >= 2 && (!best || count > best.count)) {
      best = { amountCents, count, lastCapturedAt: new Date(last).toISOString() };
    }
  }
  return best;
}

function nonRefundableValue(order: GateOrder, categories: string[]): number {
  return order.items
    .filter((i) => categories.includes(i.category))
    .reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
}

function isLost(order: GateOrder, claimDate: string, lostAfterDays: number): boolean {
  if (order.status === "lost") return true;
  if (order.deliveredDate) return false;
  if (!order.lastTrackingEventDate) return false;
  return daysBetween(order.lastTrackingEventDate, claimDate) >= lostAfterDays;
}

function lateDays(order: GateOrder): number | null {
  if (!order.deliveredDate) return null;
  return daysBetween(order.promisedDate, order.deliveredDate);
}

function evaluate(action: Action, index: number, plan: Action[], input: GateInput, addedByGate: boolean): Draft {
  const checks: Check[] = [];
  const alternatives: Action[] = [];
  let policy: PolicyRef | null = null;
  let exposureCents = 0;
  const exceptionAllowed = input.churnRisk === "high" || input.customer.tier === "platinum";
  const orderOf = (id: string) => input.orders.find((o) => o.id === id && o.customerId === input.customer.id);
  const base = { index, action, alternatives, addedByGate, exceptionAllowed };

  if (action.type === "deny" || action.type === "ask_customer") {
    return { ...base, checks, policy, exposureCents };
  }
  if (action.type === "escalate") {
    checks.push(check("ESCALATION_ALLOWED", true, true, "Handing off to a human specialist is always allowed."));
    return { ...base, checks, policy, exposureCents };
  }

  const order = "orderId" in action && action.orderId ? orderOf(action.orderId) : undefined;
  if ("orderId" in action && action.orderId) {
    checks.push(
      check("ORDER_FOUND", !!order, true, order ? `${action.orderId} belongs to this customer.` : `${action.orderId} is not one of this customer's orders.`),
    );
    if (!order) return { ...base, checks, policy, exposureCents: 0 };
  }

  switch (action.type) {
    case "refund": {
      const o = order!;
      exposureCents = action.amountCents;
      const available = o.paidCents - o.refundedCents;
      checks.push(
        check(
          "AMOUNT_WITHIN_PAID",
          action.amountCents <= available,
          true,
          `Refund ${formatCents(action.amountCents)} vs paid ${formatCents(o.paidCents)} minus refunded ${formatCents(o.refundedCents)} = ${formatCents(available)}.`,
        ),
      );
      checks.push(
        check(
          "NO_DUPLICATE_CLAIM",
          !o.priorRefunds.some((r) => r.reason === action.reason),
          true,
          o.priorRefunds.some((r) => r.reason === action.reason)
            ? `A ${action.reason} refund already exists on ${o.id}.`
            : `No earlier ${action.reason} refund on ${o.id}.`,
        ),
      );
      const approval = policyFor("APPROVAL_AUTHORITY", input.claimDate);
      const refundsBefore = plan.slice(0, index).filter((a) => a.type === "refund").length;
      checks.push(
        check(
          "ONE_REFUND_PER_RESOLUTION",
          refundsBefore < approval.params.maxRefundsPerResolution,
          true,
          `At most ${approval.params.maxRefundsPerResolution} refund per resolution.`,
        ),
      );
      const replacementInPlan = plan.some((a) => a.type === "replacement" && a.orderId === o.id);

      if (action.reason === "duplicate_charge") {
        const p = policyFor("BILLING_DISPUTES", input.claimDate);
        policy = ref("BILLING_DISPUTES", input.claimDate);
        const dup = findDuplicateCapture(o.captures, p.params.duplicateCaptureWindowHours);
        checks.push(
          check(
            "DOUBLE_CHARGE_CONFIRMED",
            !!dup,
            true,
            dup
              ? `Ledger shows ${dup.count} captures of ${formatCents(dup.amountCents)} within ${p.params.duplicateCaptureWindowHours} hours.`
              : "Ledger shows no duplicate capture on this order.",
          ),
        );
        if (dup) {
          const max = dup.amountCents * (dup.count - 1);
          checks.push(
            check("AMOUNT_MATCHES_DUPLICATE", action.amountCents <= max, true, `Duplicate amount is ${formatCents(max)}.`),
          );
          const age = daysBetween(dup.lastCapturedAt.slice(0, 10), input.claimDate);
          checks.push(
            check(
              "REPORTED_IN_TIME",
              age <= p.params.duplicateReportWindowDays,
              false,
              `Reported ${age} days after capture; window is ${p.params.duplicateReportWindowDays} days.`,
            ),
          );
        }
      } else if (action.reason === "damaged") {
        const p = policyFor("DAMAGE_TRANSIT", o.orderDate);
        policy = ref("DAMAGE_TRANSIT", o.orderDate);
        checks.push(check("DELIVERED", !!o.deliveredDate, true, o.deliveredDate ? `Delivered ${o.deliveredDate}.` : "Not delivered yet."));
        if (o.deliveredDate) {
          const age = daysBetween(o.deliveredDate, input.claimDate);
          checks.push(
            check("WITHIN_WINDOW", age <= p.params.damageReportWindowDays, false, `Reported ${age} days after delivery; window is ${p.params.damageReportWindowDays} days.`),
          );
        }
        const shipping = p.params.shippingFeeRefund ? o.shippingCents : 0;
        const max = replacementInPlan ? shipping : itemValue(o) + shipping;
        checks.push(
          check(
            "NO_DOUBLE_REMEDY",
            action.amountCents <= max,
            true,
            replacementInPlan
              ? `A replacement is in the plan, so only the shipping fee (${formatCents(shipping)}) can also be refunded.`
              : `Item value plus refundable shipping is ${formatCents(max)}.`,
          ),
        );
        const claimValue = replacementInPlan ? 0 : action.amountCents;
        if (claimValue > p.params.evidenceRequiredAboveCents) {
          const scan = p.params.carrierScanCountsAsEvidence && o.damageScan;
          checks.push(
            check(
              "EVIDENCE_PRESENT",
              input.evidenceAttached || scan,
              true,
              input.evidenceAttached
                ? "Customer attached evidence."
                : scan
                  ? "Carrier damage scan counts as evidence."
                  : `Claims above ${formatCents(p.params.evidenceRequiredAboveCents)} need evidence.`,
            ),
          );
          if (!input.evidenceAttached && !scan) {
            alternatives.push({ type: "ask_customer", question: "Could you attach a photo of the damage so we can process this?" });
          }
        }
      } else if (action.reason === "late_delivery") {
        const p = policyFor("SHIPPING_DELAYS", o.orderDate);
        policy = ref("SHIPPING_DELAYS", o.orderDate);
        const late = lateDays(o);
        checks.push(
          check("LATE_CONFIRMED", late !== null && late >= p.params.lateThresholdDays, true, late === null ? "Not delivered yet." : `Delivered ${late} days after the promised date; threshold is ${p.params.lateThresholdDays} days.`),
        );
        if (p.params.lateRemedy === "shipping_refund") {
          checks.push(check("REMEDY_MATCHES_POLICY", action.amountCents <= o.shippingCents, true, `This policy refunds the shipping fee (${formatCents(o.shippingCents)}).`));
        } else {
          checks.push(check("REMEDY_MATCHES_POLICY", false, true, "This policy compensates late deliveries with store credit, not a refund."));
          const credit = lateCredit(o, p.params);
          if (late !== null && late >= p.params.lateThresholdDays && credit > 0) {
            alternatives.push({ type: "store_credit", amountCents: credit, reason: "late_delivery", orderId: o.id });
          }
        }
      } else if (action.reason === "lost_package") {
        const p = policyFor("SHIPPING_DELAYS", o.orderDate);
        policy = ref("SHIPPING_DELAYS", o.orderDate);
        checks.push(check("LOST_CONFIRMED", isLost(o, input.claimDate, p.params.lostAfterDays), true, `Lost after ${p.params.lostAfterDays} days without a tracking update.`));
        checks.push(check("NO_DOUBLE_REMEDY", !replacementInPlan, true, replacementInPlan ? "A replacement is already in the plan." : "Refund instead of replacement."));
        checks.push(check("AMOUNT_WITHIN_ITEM_VALUE", action.amountCents <= itemValue(o), true, `Item value is ${formatCents(itemValue(o))}.`));
      } else if (action.reason === "return") {
        const p = policyFor("RETURNS_STANDARD", o.orderDate);
        policy = ref("RETURNS_STANDARD", o.orderDate);
        checks.push(check("DELIVERED", !!o.deliveredDate, true, o.deliveredDate ? `Delivered ${o.deliveredDate}.` : "Not delivered yet."));
        const refundable = itemValue(o) - nonRefundableValue(o, p.params.nonRefundableCategories);
        checks.push(
          check("CATEGORY_ALLOWED", refundable > 0 && action.amountCents <= refundable, true, refundable > 0 ? `Refundable item value is ${formatCents(refundable)}.` : "Every item on this order is non-refundable."),
        );
        const age = daysBetween(o.orderDate, input.claimDate);
        const inWindow = age <= p.params.returnWindowDays;
        checks.push(check("WITHIN_WINDOW", inWindow, false, `Ordered ${age} days ago; return window is ${p.params.returnWindowDays} days from the order date.`));
        if (!inWindow && refundable > 0 && p.params.outOfWindowStoreCreditMaxCents > 0) {
          alternatives.push({
            type: "store_credit",
            amountCents: Math.min(action.amountCents, p.params.outOfWindowStoreCreditMaxCents),
            reason: "out_of_window_return",
            orderId: o.id,
          });
        }
      } else if (action.reason === "goodwill") {
        const p = policyFor("GOODWILL_RETENTION", input.claimDate);
        policy = ref("GOODWILL_RETENTION", input.claimDate);
        checks.push(check("GOODWILL_IS_STORE_CREDIT_ONLY", false, true, "Goodwill is store credit, never a card refund."));
        if (p.params.goodwillTiers.includes(input.customer.tier)) {
          alternatives.push({ type: "store_credit", amountCents: Math.min(action.amountCents, p.params.goodwillMaxCents), reason: "goodwill" });
        }
      } else {
        checks.push(check("SUPPORTED_REASON", false, true, "No policy covers this refund reason; a specialist must review it."));
        alternatives.push({ type: "escalate", reason: "Refund request without a policy basis" });
      }
      break;
    }

    case "store_credit": {
      exposureCents = action.amountCents;
      if (action.reason === "out_of_window_return") {
        if (!order) {
          checks.push(check("ORDER_REQUIRED", false, true, "Out-of-window credit must reference an order."));
          break;
        }
        const p = policyFor("RETURNS_STANDARD", order.orderDate);
        policy = ref("RETURNS_STANDARD", order.orderDate);
        const refundable = itemValue(order) - nonRefundableValue(order, p.params.nonRefundableCategories);
        checks.push(check("CATEGORY_ALLOWED", refundable > 0, true, refundable > 0 ? "Item category allows a return." : "Item is non-refundable."));
        const age = daysBetween(order.orderDate, input.claimDate);
        checks.push(
          check("OUT_OF_WINDOW", age > p.params.returnWindowDays, true, `Ordered ${age} days ago; return window is ${p.params.returnWindowDays} days, so a refund applies instead.`),
        );
        checks.push(
          check("WITHIN_CREDIT_CAP", action.amountCents <= p.params.outOfWindowStoreCreditMaxCents, false, `Out-of-window credit cap is ${formatCents(p.params.outOfWindowStoreCreditMaxCents)}.`),
        );
      } else if (action.reason === "late_delivery") {
        if (!order) {
          checks.push(check("ORDER_REQUIRED", false, true, "Late-delivery credit must reference an order."));
          break;
        }
        const p = policyFor("SHIPPING_DELAYS", order.orderDate);
        policy = ref("SHIPPING_DELAYS", order.orderDate);
        const late = lateDays(order);
        checks.push(
          check("LATE_CONFIRMED", late !== null && late >= p.params.lateThresholdDays, true, late === null ? "Not delivered yet." : `Delivered ${late} days late; threshold is ${p.params.lateThresholdDays} days.`),
        );
        if (p.params.lateRemedy === "shipping_refund") {
          checks.push(check("REMEDY_MATCHES_POLICY", false, true, "This policy refunds the shipping fee instead of giving credit."));
          if (late !== null && late >= p.params.lateThresholdDays && order.shippingCents > 0) {
            alternatives.push({ type: "refund", orderId: order.id, amountCents: order.shippingCents, reason: "late_delivery" });
          }
        } else {
          const max = lateCredit(order, p.params);
          checks.push(check("WITHIN_CREDIT_CAP", action.amountCents <= max, true, `Late-delivery credit for this order is at most ${formatCents(max)}.`));
        }
      } else if (action.reason === "goodwill") {
        const p = policyFor("GOODWILL_RETENTION", input.claimDate);
        policy = ref("GOODWILL_RETENTION", input.claimDate);
        checks.push(
          check("TIER_ELIGIBLE", p.params.goodwillTiers.includes(input.customer.tier), true, `Goodwill is available to ${p.params.goodwillTiers.join(", ")} customers.`),
        );
        checks.push(check("WITHIN_CREDIT_CAP", action.amountCents <= p.params.goodwillMaxCents, false, `Goodwill cap is ${formatCents(p.params.goodwillMaxCents)}.`));
        const recent = input.storeCredits.some(
          (c) => c.reason === "goodwill" && daysBetween(c.createdAt.slice(0, 10), input.claimDate) <= p.params.goodwillCooldownDays,
        );
        checks.push(check("GOODWILL_COOLDOWN", !recent, true, recent ? `A goodwill credit was issued within ${p.params.goodwillCooldownDays} days.` : "No recent goodwill credit."));
      } else if (action.reason === "damaged") {
        if (!order) {
          checks.push(check("ORDER_REQUIRED", false, true, "Damage credit must reference an order."));
          break;
        }
        const p = policyFor("DAMAGE_TRANSIT", order.orderDate);
        policy = ref("DAMAGE_TRANSIT", order.orderDate);
        checks.push(check("DELIVERED", !!order.deliveredDate, true, order.deliveredDate ? `Delivered ${order.deliveredDate}.` : "Not delivered yet."));
        if (order.deliveredDate) {
          const age = daysBetween(order.deliveredDate, input.claimDate);
          checks.push(check("WITHIN_WINDOW", age <= p.params.damageReportWindowDays, false, `Reported ${age} days after delivery; window is ${p.params.damageReportWindowDays} days.`));
        }
        checks.push(check("AMOUNT_WITHIN_ITEM_VALUE", action.amountCents <= itemValue(order), true, `Item value is ${formatCents(itemValue(order))}.`));
      } else {
        checks.push(check("SUPPORTED_REASON", false, true, "No policy covers this credit reason."));
        alternatives.push({ type: "escalate", reason: "Store credit request without a policy basis" });
      }
      break;
    }

    case "replacement": {
      const o = order!;
      const line = o.items.find((i) => i.sku === action.sku);
      checks.push(check("SKU_IN_ORDER", !!line && line.qty >= action.qty, true, line ? `${line.name} x${line.qty} on the order.` : `${action.sku} is not on ${o.id}.`));
      if (!line) break;
      exposureCents = line.unitPriceCents * action.qty;
      const shipping = policyFor("SHIPPING_DELAYS", o.orderDate);
      const basis = action.reason ?? (isLost(o, input.claimDate, shipping.params.lostAfterDays) ? "lost_package" : "damaged");
      if (basis === "damaged") {
        const p = policyFor("DAMAGE_TRANSIT", o.orderDate);
        policy = ref("DAMAGE_TRANSIT", o.orderDate);
        checks.push(check("DELIVERED", !!o.deliveredDate, true, o.deliveredDate ? `Delivered ${o.deliveredDate}.` : "Not delivered yet."));
        if (o.deliveredDate) {
          const age = daysBetween(o.deliveredDate, input.claimDate);
          checks.push(check("WITHIN_WINDOW", age <= p.params.damageReportWindowDays, false, `Reported ${age} days after delivery; window is ${p.params.damageReportWindowDays} days.`));
        }
        const scan = p.params.carrierScanCountsAsEvidence && o.damageScan;
        const needsEvidence = exposureCents > p.params.evidenceRequiredAboveCents;
        checks.push(
          check(
            "EVIDENCE_PRESENT",
            !needsEvidence || input.evidenceAttached || scan,
            true,
            !needsEvidence
              ? `Below the ${formatCents(p.params.evidenceRequiredAboveCents)} evidence threshold.`
              : input.evidenceAttached
                ? "Customer attached evidence."
                : scan
                  ? "Carrier damage scan counts as evidence."
                  : `Claims above ${formatCents(p.params.evidenceRequiredAboveCents)} need evidence.`,
          ),
        );
        if (needsEvidence && !input.evidenceAttached && !scan) {
          alternatives.push({ type: "ask_customer", question: "Could you attach a photo of the damage so we can send a replacement?" });
        }
      } else {
        policy = ref("SHIPPING_DELAYS", o.orderDate);
        checks.push(check("LOST_CONFIRMED", isLost(o, input.claimDate, shipping.params.lostAfterDays), true, `Lost after ${shipping.params.lostAfterDays} days without a tracking update.`));
      }
      checks.push(check("NO_DUPLICATE_CLAIM", o.priorReplacements === 0, true, o.priorReplacements ? "A replacement was already sent for this order." : "No earlier replacement."));
      const available = input.inventory[action.sku] ?? 0;
      const inStock = available >= action.qty;
      checks.push(check("IN_STOCK", inStock, true, `${available} available.`));
      if (!inStock) {
        alternatives.push({ type: "refund", orderId: o.id, amountCents: exposureCents, reason: basis });
      }
      break;
    }

    case "return_label": {
      const o = order!;
      const basis = action.reason ?? (o.damageScan ? "damaged" : "return");
      if (basis === "damaged") {
        const p = policyFor("DAMAGE_TRANSIT", o.orderDate);
        policy = ref("DAMAGE_TRANSIT", o.orderDate);
        checks.push(
          check("RETURN_LABEL_PROVIDED", p.params.returnLabelProvided, true, p.params.returnLabelProvided ? "Policy provides a prepaid label for damaged items." : "Under this policy the customer keeps the damaged item."),
        );
      } else {
        const p = policyFor("RETURNS_STANDARD", o.orderDate);
        policy = ref("RETURNS_STANDARD", o.orderDate);
        checks.push(check("DELIVERED", !!o.deliveredDate, true, o.deliveredDate ? `Delivered ${o.deliveredDate}.` : "Not delivered yet."));
        const refundable = itemValue(o) - nonRefundableValue(o, p.params.nonRefundableCategories);
        checks.push(check("CATEGORY_ALLOWED", refundable > 0, true, refundable > 0 ? "Item category allows a return." : "Item is non-refundable."));
        const age = daysBetween(o.orderDate, input.claimDate);
        checks.push(check("WITHIN_WINDOW", age <= p.params.returnWindowDays, false, `Ordered ${age} days ago; return window is ${p.params.returnWindowDays} days.`));
      }
      checks.push(check("NO_ACTIVE_LABEL", o.activeLabels === 0, true, o.activeLabels ? "An active return label already exists." : "No active label."));
      break;
    }
  }

  return { ...base, checks, policy, exposureCents };
}

function lateCredit(order: GateOrder, p: ReturnType<typeof policyFor<"SHIPPING_DELAYS">>["params"]): number {
  if (p.lateRemedy === "store_credit_flat") return p.lateCreditCents ?? 0;
  if (p.lateRemedy === "store_credit_pct") {
    return Math.min(Math.round((order.totalCents * (p.lateCreditPct ?? 0)) / 100), p.lateCreditMaxCents ?? 0);
  }
  return 0;
}

function hasSameKind(plan: Action[], alt: Action): boolean {
  return plan.some((a) => {
    if (a.type !== alt.type) return false;
    if ("orderId" in a && "orderId" in alt) return a.orderId === alt.orderId;
    return true;
  });
}

export function runGate(plan: Action[], input: GateInput): GateResult {
  const approval = policyFor("APPROVAL_AUTHORITY", input.claimDate);
  const approvalPolicy = ref("APPROVAL_AUTHORITY", input.claimDate);
  const limit =
    input.autoLimitOverrideCents ??
    (isVip(input.customer.tier, approval.params) ? approval.params.vipAutoLimitCents : approval.params.autoRefundLimitCents);

  const drafts = plan.map((a, i) => evaluate(a, i, plan, input, false));

  // Gate-proposed alternatives for denied actions (e.g. store credit for an out-of-window return).
  // An exception request that only fails soft checks goes to a human as asked, so it gets no
  // fallback remedy (otherwise one approval would release both). Alternatives are judged against
  // the plan with hard-denied actions blanked out: a denied replacement is not "in the plan".
  const extended = [...plan];
  const hardDenied = (d: Draft) => d.checks.some((c) => !c.pass && c.hard);
  const exceptionPending = (d: Draft) =>
    "exception" in d.action && d.action.exception === true && d.exceptionAllowed && !hardDenied(d);
  for (const d of [...drafts]) {
    const failed = d.checks.some((c) => !c.pass);
    if (!failed || exceptionPending(d)) continue;
    for (const alt of d.alternatives) {
      if (alt.type === "ask_customer" || hasSameKind(extended, alt)) continue;
      extended.push(alt);
      const judgedPlan = extended.map((a, i) =>
        drafts[i] && hardDenied(drafts[i]) ? ({ type: "deny", reason: "denied by the gate" } as Action) : a,
      );
      drafts.push(evaluate(alt, extended.length - 1, judgedPlan, input, true));
    }
  }

  const statusOf = (d: Draft): { status: DecisionStatus; codes: string[] } => {
    if (!EXECUTABLE.has(d.action.type)) return { status: "INFO", codes: [] };
    const failedHard = d.checks.filter((c) => !c.pass && c.hard).map((c) => c.code);
    const failedSoft = d.checks.filter((c) => !c.pass && !c.hard).map((c) => c.code);
    if (failedHard.length) return { status: "DENIED", codes: [...failedHard, ...failedSoft] };
    if (failedSoft.length) {
      const wantsException = "exception" in d.action && d.action.exception === true;
      if (wantsException && d.exceptionAllowed && !input.supervisorApproved) {
        return { status: "NEEDS_HUMAN", codes: ["POLICY_EXCEPTION_REQUESTED", ...failedSoft] };
      }
      if (wantsException && d.exceptionAllowed && input.supervisorApproved) return { status: "AUTO_APPROVED", codes: ["SUPERVISOR_EXCEPTION"] };
      return { status: "DENIED", codes: failedSoft };
    }
    return { status: "AUTO_APPROVED", codes: [] };
  };

  const first = drafts.map((d) => ({ d, ...statusOf(d) }));

  // Per order, refunds plus order-bound remedy credits (damage / out-of-window) may not exceed
  // what is still refundable. Refunds are counted first; a credit that would push past the
  // balance is denied as a double remedy.
  const isLive = (x: { status: DecisionStatus }) => x.status === "AUTO_APPROVED" || x.status === "NEEDS_HUMAN";
  const remedyCredit = (a: Action) => a.type === "store_credit" && (a.reason === "damaged" || a.reason === "out_of_window_return");
  for (const o of input.orders.filter((x) => x.customerId === input.customer.id)) {
    const onOrder = first.filter((x) => isLive(x) && "orderId" in x.d.action && x.d.action.orderId === o.id);
    let out = onOrder.filter((x) => x.d.action.type === "refund").reduce((s, x) => s + x.d.exposureCents, 0);
    const balance = o.paidCents - o.refundedCents;
    for (const x of onOrder.filter((y) => remedyCredit(y.d.action))) {
      const pass = out + x.d.exposureCents <= balance;
      x.d.checks.push(
        check(
          "NO_DOUBLE_REMEDY",
          pass,
          true,
          `Refunds and remedy credits on ${o.id} total ${formatCents(out + x.d.exposureCents)}; ${formatCents(balance)} is still refundable.`,
        ),
      );
      if (pass) out += x.d.exposureCents;
      else Object.assign(x, statusOf(x.d));
    }
  }
  const live = first.filter((x) => x.status === "AUTO_APPROVED" || x.status === "NEEDS_HUMAN");
  const totalExposureCents = live.reduce((s, x) => s + x.d.exposureCents, 0);

  const humanReasons: string[] = [];
  if (first.some((x) => x.codes.includes("POLICY_EXCEPTION_REQUESTED"))) humanReasons.push("POLICY_EXCEPTION_REQUESTED");
  if (totalExposureCents > limit) humanReasons.push("AMOUNT_ABOVE_AUTO_LIMIT");
  if (input.firewallFlagged && totalExposureCents > 0) humanReasons.push("FIREWALL_FLAGGED");
  if (input.socialSignals.length > 0 && totalExposureCents > 0) humanReasons.push("SOCIAL_ENGINEERING_SIGNAL");
  const goodwill = policyFor("GOODWILL_RETENTION", input.claimDate);
  if (
    input.churnRisk === "high" &&
    goodwill.params.churnExceptionRequiresHuman &&
    live.some((x) => x.d.action.type === "store_credit" && x.d.action.reason === "goodwill")
  ) {
    humanReasons.push("CHURN_EXCEPTION");
  }
  const needHuman = humanReasons.length > 0 && !input.supervisorApproved;

  const decisions: ActionDecision[] = first.map(({ d, status, codes }) => {
    let finalStatus = status;
    let reasonCodes = codes;
    if (status === "AUTO_APPROVED" || status === "NEEDS_HUMAN") {
      if (needHuman) {
        finalStatus = "NEEDS_HUMAN";
        reasonCodes = [...new Set([...codes, ...humanReasons])];
      } else {
        finalStatus = "AUTO_APPROVED";
        reasonCodes = input.supervisorApproved ? [...new Set([...codes.filter((c) => c !== "POLICY_EXCEPTION_REQUESTED"), "SUPERVISOR_APPROVED"])] : codes;
      }
    }
    return {
      index: d.index,
      action: d.action,
      status: finalStatus,
      checks: d.checks,
      reasonCodes,
      policy: d.policy,
      exposureCents: finalStatus === "DENIED" || finalStatus === "INFO" ? 0 : d.exposureCents,
      alternatives: d.alternatives,
      addedByGate: d.addedByGate,
    };
  });

  const route: GateResult["route"] = decisions.some((d) => d.status === "NEEDS_HUMAN")
    ? "human"
    : decisions.some((d) => d.status === "AUTO_APPROVED")
      ? "auto"
      : "deny";

  return {
    decisions,
    route,
    totalExposureCents: decisions.reduce((s, d) => s + d.exposureCents, 0),
    autoLimitCents: limit,
    approvalPolicy,
    humanReasons: needHuman ? humanReasons : [],
  };
}
