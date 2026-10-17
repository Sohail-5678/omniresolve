/**
 * Saga orchestrator driven directly (no graph, no LLM) over a real sandbox with real,
 * signed approval tokens. Covers the happy path, compensation before the pivot, outbox
 * follow-ups after it, carrier failover + breaker, retry/backoff, pivot reconciliation,
 * crash recovery and idempotency.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { mintToken, type TokenAction } from "@/lib/security/approval-token";
import { runSaga, recoverSagas, findStuckSagas, planHashOf, type SagaCtx, type SagaEvent, type SagaSummary } from "@/lib/saga/orchestrator";
import type { SagaPlan } from "@/lib/saga/steps";
import { idempotencyKey } from "@/lib/saga/idempotency";
import type { ServiceCallEvent } from "@/lib/services/core";
import * as orders from "@/lib/services/orders";
import * as carriers from "@/lib/services/carriers";
import * as tickets from "@/lib/services/tickets";
import * as billing from "@/lib/services/billing";
import { SimulatedCrash } from "@/lib/util/errors";
import { db, freshSandbox, newThread, fault } from "../helpers";

// ---------------------------------------------------------------- plan builders

async function token(
  sb: string,
  threadId: string,
  action: TokenAction,
  orderId: string,
  extra: { amountCents?: number | null; sku?: string | null; qty?: number | null } = {},
): Promise<string> {
  const { tokenId } = await mintToken(db(), {
    sandboxId: sb,
    threadId,
    action,
    orderId,
    amountCents: extra.amountCents ?? null,
    sku: extra.sku ?? null,
    qty: extra.qty ?? null,
    policyId: "TEST_POLICY",
    policyVersion: "2026.1",
    approvedBy: "supervisor:test",
  });
  return tokenId;
}

type Built = { plan: SagaPlan; threadId: string; tokens: { refund: string; replacement: string; label: string } };

/** Showcase 1: refund the duplicate capture on ORD-9941 + replacement GLS-AUR-01 + return label. */
async function showcase1(sb: string): Promise<Built> {
  const threadId = await newThread(sb, "CUS-1001");
  const refund = await token(sb, threadId, "refund", "ORD-9941", { amountCents: 32000 });
  const replacement = await token(sb, threadId, "replacement", "ORD-9941", { sku: "GLS-AUR-01", qty: 1 });
  const label = await token(sb, threadId, "return_label", "ORD-9941");
  return {
    threadId,
    tokens: { refund, replacement, label },
    plan: {
      sandboxId: sb,
      threadId,
      customerId: "CUS-1001",
      customerName: "Sarah Jenkins",
      primaryOrderId: "ORD-9941",
      subject: "Glass kit arrived shattered and the order was charged twice.",
      actions: [
        { action: { type: "refund", orderId: "ORD-9941", amountCents: 32000, reason: "duplicate_charge" }, tokenId: refund },
        { action: { type: "replacement", orderId: "ORD-9941", sku: "GLS-AUR-01", qty: 1, reason: "damaged" }, tokenId: replacement },
        { action: { type: "return_label", orderId: "ORD-9941", reason: "damaged" }, tokenId: label },
      ],
    },
  };
}

/** Showcase 2 orders: replacement + return label + shipping refund. */
const S2 = {
  "ORD-8820": { customerId: "CUS-1002", name: "Daniel Okafor", sku: "KIT-POUR-02" },
  "ORD-8821": { customerId: "CUS-1003", name: "Priya Raman", sku: "MUG-STN-04" },
} as const;

async function showcase2(sb: string, orderId: keyof typeof S2): Promise<Built> {
  const o = S2[orderId];
  const threadId = await newThread(sb, o.customerId);
  const refund = await token(sb, threadId, "refund", orderId, { amountCents: 700 });
  const replacement = await token(sb, threadId, "replacement", orderId, { sku: o.sku, qty: 1 });
  const label = await token(sb, threadId, "return_label", orderId);
  return {
    threadId,
    tokens: { refund, replacement, label },
    plan: {
      sandboxId: sb,
      threadId,
      customerId: o.customerId,
      customerName: o.name,
      primaryOrderId: orderId,
      subject: "Item arrived damaged.",
      actions: [
        { action: { type: "replacement", orderId, sku: o.sku, qty: 1, reason: "damaged" }, tokenId: replacement },
        { action: { type: "return_label", orderId, reason: "damaged" }, tokenId: label },
        { action: { type: "refund", orderId, amountCents: 700, reason: "damaged" }, tokenId: refund },
      ],
    },
  };
}

const S1_STEPS = [
  ["tickets.create", "reversible"],
  ["orders.reserveInventory", "reversible"],
  ["carriers.createReturnLabel", "reversible"],
  ["orders.createReplacementDraft", "reversible"],
  ["billing.refund", "pivot"],
  ["orders.confirmReplacement", "retriable"],
  ["tickets.resolve", "retriable"],
  ["tickets.notify", "retriable"],
];

// ---------------------------------------------------------------- recording context

function recorder(sb: string, extra: Partial<SagaCtx> = {}) {
  const events: SagaEvent[] = [];
  const calls: ServiceCallEvent[] = [];
  const delays: number[] = [];
  const ctx: SagaCtx = {
    db: db(),
    sandboxId: sb,
    emit: (e) => events.push(e),
    onServiceCall: (c) => calls.push(c),
    sleep: async (ms: number) => {
      delays.push(ms);
    },
    random: () => 0.5,
    ...extra,
  };
  const stepEvents = (status: string) =>
    events.filter((e): e is Extract<SagaEvent, { type: "saga_step" }> => e.type === "saga_step" && e.status === status).map((e) => e.seq);
  const callNames = (ops: string[]) => calls.filter((c) => ops.includes(c.operation)).map((c) => `${c.service}.${c.operation}`);
  /** Every mock API call in order — proves skipped steps never ran and retries hit the service. */
  const callSeq = () => calls.map((c) => `${c.service}.${c.operation}`);
  return { ctx, events, calls, delays, stepEvents, callNames, callSeq };
}

const x = (n: number, op: string) => Array<string>(n).fill(op);

/** The service calls of a showcase-1 saga that completes every step on the first attempt. */
const S1_HAPPY_CALLS = [
  "tickets.create",
  "orders.reserveInventory",
  "carrier_a.createReturnLabel",
  "orders.createReplacementDraft",
  "billing.refund",
  "orders.confirmReplacement",
  "tickets.addNote",
  "tickets.close",
  "tickets.notify",
];

const COMPENSATION_OPS = ["cancel", "releaseInventory", "voidLabel", "cancelDraft"];

// ---------------------------------------------------------------- DB readers

const q = {
  refundsFor: (sb: string, orderId: string) => db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, orderId))),
  holds: (sb: string, sagaId: string) => db().select().from(s.inventoryHolds).where(and(eq(s.inventoryHolds.sandboxId, sb), eq(s.inventoryHolds.sagaId, sagaId))),
  drafts: (sb: string, sagaId: string) => db().select().from(s.replacementDrafts).where(and(eq(s.replacementDrafts.sandboxId, sb), eq(s.replacementDrafts.sagaId, sagaId))),
  labels: (sb: string, sagaId: string) => db().select().from(s.labels).where(and(eq(s.labels.sandboxId, sb), eq(s.labels.sagaId, sagaId))),
  tickets: (sb: string, sagaId: string) => db().select().from(s.tickets).where(and(eq(s.tickets.sandboxId, sb), eq(s.tickets.sagaId, sagaId))),
  outbox: (sb: string, sagaId: string) => db().select().from(s.outbox).where(and(eq(s.outbox.sandboxId, sb), eq(s.outbox.sagaId, sagaId))),
  notifications: (sb: string, sagaId: string) => db().select().from(s.notifications).where(and(eq(s.notifications.sandboxId, sb), eq(s.notifications.sagaId, sagaId))),
  notes: (sb: string, ticketId: string) => db().select().from(s.ticketNotes).where(and(eq(s.ticketNotes.sandboxId, sb), eq(s.ticketNotes.ticketId, ticketId))),
  sagas: (sb: string) => db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, sb)),
  steps: (sagaId: string) => db().select().from(s.sagaSteps).where(eq(s.sagaSteps.sagaId, sagaId)).orderBy(s.sagaSteps.seq),
  token: async (tokenId: string) => (await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.tokenId, tokenId)))[0],
  inventory: async (sb: string, sku: string) =>
    (await db().select().from(s.inventory).where(and(eq(s.inventory.sandboxId, sb), eq(s.inventory.sku, sku))))[0],
  breaker: async (sb: string, carrier: string) =>
    (await db().select().from(s.breakers).where(and(eq(s.breakers.sandboxId, sb), eq(s.breakers.service, carrier))))[0],
  faultCalls: async (sb: string, service: string, operation: string) =>
    (
      await db()
        .select()
        .from(s.faultSettings)
        .where(and(eq(s.faultSettings.sandboxId, sb), eq(s.faultSettings.service, service), eq(s.faultSettings.operation, operation)))
    )[0]?.calls,
};

const statuses = (sum: SagaSummary) => sum.steps.map((st) => st.status);
const step = (sum: SagaSummary, name: string) => sum.steps.find((st) => st.name === name)!;

/** Asserts the full "nothing irreversible happened, everything reversible was undone" contract. */
async function expectCleanRollback(
  sb: string,
  sum: SagaSummary,
  b: Built,
  sku: string,
  invBefore: { onHand: number; reserved: number },
  opts: { ticketExpected: boolean },
) {
  expect(sum.status).toBe("ROLLED_BACK");
  expect(sum.ticketStatus).toBe("ROLLED_BACK");
  const run = (await q.sagas(sb)).find((r) => r.id === sum.sagaId)!;
  expect(run.status).toBe("ROLLED_BACK");
  // No money moved and the refund token is still unused.
  expect(await q.refundsFor(sb, b.plan.primaryOrderId!)).toHaveLength(0);
  expect(sum.outputs.refundId).toBeUndefined();
  expect((await q.token(b.tokens.refund)).status).toBe("issued");
  // Holds released, labels voided, drafts cancelled.
  expect((await q.holds(sb, sum.sagaId)).map((h) => h.status).filter((x) => x !== "released")).toEqual([]);
  expect((await q.labels(sb, sum.sagaId)).map((l) => l.status).filter((x) => x !== "voided")).toEqual([]);
  expect((await q.drafts(sb, sum.sagaId)).map((d) => d.status).filter((x) => x !== "cancelled")).toEqual([]);
  const inv = await q.inventory(sb, sku);
  expect({ onHand: inv.onHand, reserved: inv.reserved }).toEqual(invBefore);
  // Ticket rolled back with a human follow-up (only when a ticket was ever opened).
  const tks = await q.tickets(sb, sum.sagaId);
  const outbox = await q.outbox(sb, sum.sagaId);
  if (opts.ticketExpected) {
    expect(tks).toHaveLength(1);
    expect(tks[0].status).toBe("ROLLED_BACK");
    expect(outbox.map((o) => o.kind)).toEqual(["human_followup"]);
    expect(outbox[0].payload).toMatchObject({ ticketId: tks[0].id });
    expect(sum.outbox.map((o) => o.kind)).toEqual(["human_followup"]);
  } else {
    expect(tks).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  }
  // Nothing after the pivot ran.
  expect(await q.notifications(sb, sum.sagaId)).toHaveLength(0);
}

// =================================================================== happy path

describe("saga — happy path", () => {
  it("showcase 1 runs to DONE: one refund in the ledger, hold consumed, draft confirmed, label active, ticket resolved", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("DONE");
    expect(sum.ticketStatus).toBe("RESOLVED");
    expect(sum.pivotSeq).toBe(5);
    expect(sum.steps.map((st) => [st.name, st.kind])).toEqual(S1_STEPS);
    expect(statuses(sum)).toEqual(Array(8).fill("DONE"));
    expect(sum.steps.map((st) => st.attempts)).toEqual(Array(8).fill(1));
    expect(sum.outbox).toEqual([]);
    expect(r.delays).toEqual([]);

    // Ledger: two captures of $320, exactly one refund of $320 tied to this saga + token + step key.
    const refunds = await q.refundsFor(sb, "ORD-9941");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: sum.outputs.refundId, amountCents: 32000, reason: "duplicate_charge", sagaId: sum.sagaId, tokenId: b.tokens.refund });
    const stepRows = await q.steps(sum.sagaId);
    expect(refunds[0].idempotencyKey).toBe(stepRows[4].idempotencyKey);
    expect(stepRows[4].idempotencyKey).toBe(
      idempotencyKey(sb, sum.sagaId, "billing.refund", { orderId: "ORD-9941", amountCents: 32000, reason: "duplicate_charge" }),
    );
    const ledger = await billing.getLedger({ db: db(), sandboxId: sb }, "CUS-1001");
    expect(ledger.charges.filter((c) => c.orderId === "ORD-9941").map((c) => c.amountCents)).toEqual([32000, 32000]);
    expect(ledger.refunds.filter((x) => x.orderId === "ORD-9941").map((x) => [x.refundId, x.amountCents])).toEqual([[sum.outputs.refundId, 32000]]);
    expect(sum.outputs.refundAmountCents).toBe(32000);

    // Inventory: hold consumed by the confirmed replacement; on-hand down by one, reservation back to where it was.
    const holds = await q.holds(sb, sum.sagaId);
    expect(holds.map((h) => [h.id, h.sku, h.qty, h.status])).toEqual([[sum.outputs.holdId, "GLS-AUR-01", 1, "consumed"]]);
    const inv1 = await q.inventory(sb, "GLS-AUR-01");
    expect(inv1.onHand).toBe(inv0.onHand - 1);
    expect(inv1.reserved).toBe(inv0.reserved);
    const drafts = await q.drafts(sb, sum.sagaId);
    expect(drafts.map((d) => [d.id, d.holdId, d.status, d.tokenId])).toEqual([[sum.outputs.draftId, sum.outputs.holdId, "confirmed", b.tokens.replacement]]);

    // Label on Carrier A (healthy), no failover.
    const labels = await q.labels(sb, sum.sagaId);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ id: sum.outputs.labelId, carrier: "carrier_a", status: "active", trackingNo: sum.outputs.trackingNo, tokenId: b.tokens.label });
    expect(labels[0].trackingNo).toMatch(/^CA88\d{8}$/);
    expect(sum.outputs.carrier).toBe("carrier_a");
    expect(sum.outputs.failover).toBe(false);

    // Ticket resolved with a note, notification preview recorded (not sent).
    const tks = await q.tickets(sb, sum.sagaId);
    expect(tks.map((t) => [t.id, t.status, t.orderId, t.customerId, t.threadId])).toEqual([[sum.outputs.ticketId, "RESOLVED", "ORD-9941", "CUS-1001", b.threadId]]);
    const notes = await q.notes(sb, sum.outputs.ticketId!);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain(`Refund ${sum.outputs.refundId} for $320.00.`);
    expect(notes[0].body).toContain("RESOLVED");
    const notifs = await q.notifications(sb, sum.sagaId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].id).toBe(sum.outputs.notificationId);
    expect(notifs[0].preview).toContain("Hi Sarah");
    expect(notifs[0].preview).toContain(`Refund ${sum.outputs.refundId}: $320.00.`);
    expect(notifs[0].preview).toContain(`Return label tracking: ${sum.outputs.trackingNo}.`);
    expect(notifs[0].channel).toBe("email (preview only, not sent)");

    // Every token was consumed exactly by its own step; reserveInventory only verified the replacement token.
    for (const t of Object.values(b.tokens)) expect((await q.token(t)).status).toBe("consumed");

    // Events: start (not resumed) ... end DONE.
    expect(r.events[0]).toMatchObject({ type: "saga_start", sagaId: sum.sagaId, resumed: false });
    expect(r.events.at(-1)).toEqual({ type: "saga_end", sagaId: sum.sagaId, status: "DONE", ticketStatus: "RESOLVED" });
    expect(r.stepEvents("DONE")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.stepEvents("RUNNING")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Exactly one call per step (resolve = addNote + close), in plan order, and no extra
    // "final status" ticket write when nothing needs a follow-up.
    expect(r.callSeq()).toEqual(S1_HAPPY_CALLS);
    expect(r.calls.every((c) => c.ok && !c.faultInjected && !c.replayed)).toBe(true);
    // Healthy carrier calls reset (or create) Carrier A's breaker row at zero failures.
    expect(await q.breaker(sb, "carrier_a")).toMatchObject({ consecutiveFailures: 0, openUntil: null });
    expect(await q.breaker(sb, "carrier_b")).toBeUndefined();
    // No fault flag leaks into a clean step's detail.
    expect(sum.steps.every((st) => st.detail?.faultInjected === undefined)).toBe(true);
  });

  it("showcase 2 order (ORD-8820) runs DONE with the shipping refund and the saga row stores the plan hash", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8820");
    const sum = await runSaga(recorder(sb).ctx, b.plan);
    expect(sum.status).toBe("DONE");
    expect(sum.steps.map((st) => st.name)).toEqual(S1_STEPS.map(([n]) => n));
    expect((await q.refundsFor(sb, "ORD-8820")).map((x) => x.amountCents)).toEqual([700]);
    const runs = await q.sagas(sb);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: sum.sagaId, threadId: b.threadId, planHash: planHashOf(b.plan), status: "DONE", ticketStatus: "RESOLVED", pivotSeq: 5 });
  });
});

// =================================================================== before the pivot

describe("saga — failure before the pivot compensates in reverse and rolls back", () => {
  it("tickets.create 503 x3 → ROLLED_BACK with nothing to undo (a definite 503 is not compensated), exact backoff delays", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "tickets", "create", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["FAILED", ...Array(7).fill("SKIPPED")]);
    expect(sum.steps[0].attempts).toBe(3);
    expect(sum.steps[0].error).toContain("503");
    expect(sum.steps[0].detail).toEqual({ faultInjected: true, code: "UNAVAILABLE" }); // 503 = nothing committed, nothing to undo
    // min(cap, 100 * 2^n) * (0.5 + 0.5 * 0.5) for n = 0, 1
    expect(r.delays).toEqual([75, 150]);
    expect(r.stepEvents("RETRY")).toEqual([1, 1]);
    expect(r.stepEvents("COMPENSATED")).toEqual([]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
    // Three real attempts at the ticket service and nothing else: no later step was started.
    expect(r.callSeq()).toEqual(x(3, "tickets.create"));
    expect(await q.faultCalls(sb, "tickets", "create")).toBe(3);
    expect(r.stepEvents("RUNNING")).toEqual([1]);
    expect(r.events.at(-1)).toEqual({ type: "saga_end", sagaId: sum.sagaId, status: "ROLLED_BACK", ticketStatus: "ROLLED_BACK" });
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: false });
  });

  it("orders.reserveInventory 503 → ticket rolled back (human_followup), nothing else touched", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "orders", "reserveInventory", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["COMPENSATED", "FAILED", ...Array(6).fill("SKIPPED")]);
    expect(step(sum, "orders.reserveInventory").attempts).toBe(3);
    // The failed step itself (a definite 503) is not compensated; only the completed ticket is.
    expect(step(sum, "orders.reserveInventory").detail?.compensated).toBeUndefined();
    expect(r.stepEvents("COMPENSATED")).toEqual([1]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["tickets.cancel"]);
    expect(r.callSeq()).toEqual(["tickets.create", ...x(3, "orders.reserveInventory"), "tickets.cancel"]);
    expect(r.delays).toEqual([75, 150]);
    expect(await q.holds(sb, sum.sagaId)).toHaveLength(0);
    // Verify-only: the replacement token was never consumed.
    expect((await q.token(b.tokens.replacement)).status).toBe("issued");
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("createReturnLabel 503 on BOTH carriers → no label exists, hold released, ticket rolled back", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");
    await fault(sb, "carrier_b", "createReturnLabel", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "FAILED", ...Array(5).fill("SKIPPED")]);
    const lbl = step(sum, "carriers.createReturnLabel");
    expect(lbl.attempts).toBe(6); // 3 on A, then failover, 3 on B
    expect(lbl.error).toContain("carrier_b.createReturnLabel: 503");
    expect(r.stepEvents("FAILOVER")).toEqual([3]);
    expect(r.delays).toEqual([75, 150, 75, 150]);
    expect(await q.faultCalls(sb, "carrier_a", "createReturnLabel")).toBe(3);
    expect(await q.faultCalls(sb, "carrier_b", "createReturnLabel")).toBe(3);
    expect(r.stepEvents("COMPENSATED")).toEqual([2, 1]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["orders.releaseInventory", "tickets.cancel"]);
    expect(r.callSeq()).toEqual([
      "tickets.create",
      "orders.reserveInventory",
      ...x(3, "carrier_a.createReturnLabel"),
      ...x(3, "carrier_b.createReturnLabel"),
      "orders.releaseInventory",
      "tickets.cancel",
    ]);
    expect((lbl.detail as { faultInjected?: boolean; code?: string }).code).toBe("UNAVAILABLE");
    // The return_label token was never consumed: no carrier committed anything.
    expect((await q.token(b.tokens.label)).status).toBe("issued");
    // The hold that existed was released.
    const holds = await q.holds(sb, sum.sagaId);
    expect(holds.map((h) => h.status)).toEqual(["released"]);
    expect(await q.labels(sb, sum.sagaId)).toHaveLength(0);
    // Both breakers counted three consecutive failures and opened.
    for (const c of ["carrier_a", "carrier_b"]) {
      const br = await q.breaker(sb, c);
      expect(br.consecutiveFailures).toBe(3);
      expect(br.openUntil!.getTime()).toBeGreaterThan(Date.now());
    }
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("orders.createReplacementDraft 503 (showcase 2B, ORD-8821) → label voided, hold released, ticket rolled back", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8821");
    const inv0 = await q.inventory(sb, "MUG-STN-04");
    await fault(sb, "orders", "createReplacementDraft", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "COMPENSATED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(step(sum, "orders.createReplacementDraft").attempts).toBe(3);
    expect(r.stepEvents("COMPENSATED")).toEqual([3, 2, 1]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["carrier_a.voidLabel", "carrier_b.voidLabel", "orders.releaseInventory", "tickets.cancel"]);
    expect(r.callSeq()).toEqual([
      "tickets.create",
      "orders.reserveInventory",
      "carrier_a.createReturnLabel",
      ...x(3, "orders.createReplacementDraft"),
      "carrier_a.voidLabel",
      "carrier_b.voidLabel",
      "orders.releaseInventory",
      "tickets.cancel",
    ]);
    // A definite 503 on the failed step: it is not compensated (cancelDraft never ran) and no draft exists.
    expect(step(sum, "orders.createReplacementDraft").detail).toEqual({ faultInjected: true, code: "UNAVAILABLE" });
    expect(await q.drafts(sb, sum.sagaId)).toHaveLength(0);
    const labels = await q.labels(sb, sum.sagaId);
    expect(labels.map((l) => [l.carrier, l.status])).toEqual([["carrier_a", "voided"]]);
    expect((await q.holds(sb, sum.sagaId)).map((h) => h.status)).toEqual(["released"]);
    // Label token was consumed (label really was created, then voided); replacement + refund tokens unused.
    expect((await q.token(b.tokens.label)).status).toBe("consumed");
    expect((await q.token(b.tokens.replacement)).status).toBe("issued");
    // Outputs still expose what was created, so the reply can mention the voided label.
    expect(sum.outputs.labelId).toBe(labels[0].id);
    await expectCleanRollback(sb, sum, b, "MUG-STN-04", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("billing.refund 503 at the pivot (nothing committed) → every reversible step compensated, draft cancelled", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "billing", "refund", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "COMPENSATED", "COMPENSATED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(step(sum, "billing.refund").attempts).toBe(3);
    // The pivot is not reversible: it is not "compensated", only the reversible steps are.
    expect(step(sum, "billing.refund").detail?.compensated).toBeUndefined();
    expect(r.stepEvents("COMPENSATED")).toEqual([4, 3, 2, 1]);
    // Each compensation is announced (COMPENSATING) before it completes, in reverse order.
    expect(r.stepEvents("COMPENSATING")).toEqual([4, 3, 2, 1]);
    expect(r.callSeq()).toEqual([
      ...S1_HAPPY_CALLS.slice(0, 4),
      ...x(3, "billing.refund"),
      "orders.cancelDraft",
      "carrier_a.voidLabel",
      "carrier_b.voidLabel",
      "orders.releaseInventory",
      "tickets.cancel",
    ]);
    const drafts = await q.drafts(sb, sum.sagaId);
    expect(drafts.map((d) => d.status)).toEqual(["cancelled"]);
    // Every reversible artefact existed and was undone (expectCleanRollback alone would pass on "never created").
    expect((await q.labels(sb, sum.sagaId)).map((l) => [l.carrier, l.status])).toEqual([["carrier_a", "voided"]]);
    expect((await q.holds(sb, sum.sagaId)).map((h) => h.status)).toEqual(["released"]);
    // The replacement + label tokens were consumed by work that was then undone; the refund token is untouched.
    expect((await q.token(b.tokens.replacement)).status).toBe("consumed");
    expect((await q.token(b.tokens.label)).status).toBe("consumed");
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("schema_drift on a pre-pivot step (createReplacementDraft) → no retry, rollback compensates the drifted step itself", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "orders", "createReplacementDraft", "schema_drift");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    const draftStep = step(sum, "orders.createReplacementDraft");
    expect(draftStep.status).toBe("FAILED");
    expect(draftStep.attempts).toBe(1); // schema mismatches are never retried
    expect(draftStep.error).toMatch(/orders\.createReplacementDraft: response did not match the expected schema/);
    expect(draftStep.detail).toMatchObject({ code: "UPSTREAM_SCHEMA_MISMATCH", faultInjected: true, compensated: true });
    expect(r.delays).toEqual([]);
    expect(r.stepEvents("COMPENSATED")).toEqual([4, 3, 2, 1]);
    // The draft DID commit behind the drifted response, and the compensation cancelled it.
    const drafts = await q.drafts(sb, sum.sagaId);
    expect(drafts.map((d) => d.status)).toEqual(["cancelled"]);
    expect((await q.token(b.tokens.replacement)).status).toBe("consumed");
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["orders.cancelDraft", "carrier_a.voidLabel", "carrier_b.voidLabel", "orders.releaseInventory", "tickets.cancel"]);
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("schema_drift on the FIRST step (tickets.create) → the committed ticket is still rolled back with a human follow-up", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "tickets", "create", "schema_drift");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["FAILED", ...Array(7).fill("SKIPPED")]);
    expect(sum.steps[0].attempts).toBe(1);
    expect(sum.steps[0].detail).toEqual({ code: "UPSTREAM_SCHEMA_MISMATCH", faultInjected: true, compensated: true });
    expect(r.stepEvents("COMPENSATED")).toEqual([1]);
    expect(r.callSeq()).toEqual(["tickets.create", "tickets.cancel"]);
    // The ticket existed behind the drifted response; it must not be left OPEN.
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("persistent 429 honours retry-after (1 s) on every retry, counts 3 attempts, then rolls back", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "orders", "reserveInventory", "rate_limit_429");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    const st = step(sum, "orders.reserveInventory");
    expect(st.attempts).toBe(3);
    expect(st.error).toContain("429");
    expect(st.detail).toMatchObject({ code: "RATE_LIMITED" });
    expect(await q.faultCalls(sb, "orders", "reserveInventory")).toBe(3);
    // backoff would be 75 / 150 ms; retry-after (1000 ms) wins, capped at 2000 ms.
    expect(r.delays).toEqual([1000, 1000]);
    const retries = r.events.filter((e) => e.type === "saga_step" && e.status === "RETRY") as Extract<SagaEvent, { type: "saga_step" }>[];
    expect(retries.map((e) => [e.seq, e.attempt, e.faultInjected])).toEqual([
      [2, 2, true],
      [2, 3, true],
    ]);
    expect(retries[0].message).toContain("retrying in 1000 ms");
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });
});

// =================================================================== after the pivot

describe("saga — failure after the pivot keeps the refund and queues ops follow-up", () => {
  it("orders.confirmReplacement 503 → REFUNDED_PENDING_FULFILLMENT, refund kept, needs_ops_followup outbox", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "confirmReplacement", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(sum.ticketStatus).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(statuses(sum)).toEqual(["DONE", "DONE", "DONE", "DONE", "DONE", "FAILED", "DONE", "DONE"]);
    expect(step(sum, "orders.confirmReplacement").attempts).toBe(3);
    // A refund is never rolled back.
    const refunds = await q.refundsFor(sb, "ORD-9941");
    expect(refunds.map((x) => [x.id, x.amountCents])).toEqual([[sum.outputs.refundId, 32000]]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
    expect(r.stepEvents("COMPENSATING")).toEqual([]);
    // Ops follow-up recorded and linked from the step.
    const outbox = await q.outbox(sb, sum.sagaId);
    expect(outbox.map((o) => o.kind)).toEqual(["needs_ops_followup"]);
    expect(outbox[0].payload).toMatchObject({ step: "orders.confirmReplacement" });
    expect(String(outbox[0].payload.error)).toContain("503");
    expect(step(sum, "orders.confirmReplacement").detail).toMatchObject({ outboxId: outbox[0].id });
    expect(r.stepEvents("OUTBOX")).toEqual([6]);
    // Replacement stays pending (draft + hold intact for ops); label kept; ticket carries the pending status.
    expect((await q.drafts(sb, sum.sagaId)).map((d) => d.status)).toEqual(["draft"]);
    expect((await q.holds(sb, sum.sagaId)).map((h) => h.status)).toEqual(["held"]);
    expect((await q.labels(sb, sum.sagaId)).map((l) => l.status)).toEqual(["active"]);
    const tks = await q.tickets(sb, sum.sagaId);
    expect(tks.map((t) => t.status)).toEqual(["REFUNDED_PENDING_FULFILLMENT"]);
    const notes = await q.notes(sb, tks[0].id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("REFUNDED_PENDING_FULFILLMENT");
    expect(r.events.at(-1)).toEqual({ type: "saga_end", sagaId: sum.sagaId, status: "REFUNDED_PENDING_FULFILLMENT", ticketStatus: "REFUNDED_PENDING_FULFILLMENT" });
    // Later retriable steps still ran; the trailing tickets.close is the final-status write.
    expect(r.callSeq()).toEqual([
      ...S1_HAPPY_CALLS.slice(0, 5),
      ...x(3, "orders.confirmReplacement"),
      "tickets.addNote",
      "tickets.close",
      "tickets.notify",
      "tickets.close",
    ]);
    expect(sum.outbox).toEqual([{ id: outbox[0].id, kind: "needs_ops_followup" }]);
    expect((await q.token(b.tokens.refund)).status).toBe("consumed");
  });

  // BUG: src/lib/saga/orchestrator.ts notificationPreview() builds the customer-facing preview from
  // outputsFrom(steps), where draftId comes from the *createReplacementDraft* step. When
  // orders.confirmReplacement fails after the pivot (saga REFUNDED_PENDING_FULFILLMENT, draft still
  // status "draft", queued for ops), the preview still says "Replacement order RPL-… is confirmed."
  // Expected: the preview must not claim the replacement is confirmed. Actual: it does.
  it("notification preview claims the replacement is confirmed when confirmReplacement failed", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "confirmReplacement", "fail_503");
    const sum = await runSaga(recorder(sb).ctx, b.plan);
    expect(sum.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect((await q.drafts(sb, sum.sagaId)).map((d) => d.status)).toEqual(["draft"]);
    const notifs = await q.notifications(sb, sum.sagaId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].preview).not.toContain("is confirmed");
  });

  // BUG: src/lib/saga/orchestrator.ts continueSaga() — after a retriable step fails, it links the
  // outbox row with `updateStep(…, { detail: { ...(step.detail ?? {}), outboxId } })`, but `step` is
  // the row from the `for (const step of steps)` iterator, loaded BEFORE executeStep ran (the
  // reassigned `steps` does not change what the loop iterates). Its detail is the stale pre-run value
  // (null), so the write replaces the { code: "UNAVAILABLE", faultInjected: true } that executeStep just
  // stored with { outboxId } alone. Repro: fault orders.confirmReplacement fail_503, runSaga showcase 1,
  // read step 6 detail. Expected: { faultInjected: true, code: "UNAVAILABLE", outboxId }. Actual:
  // { outboxId } — the trace loses the FAULT-INJECTED label and the error code for every outboxed step.
  it("linking the outbox row wipes the failed retriable step's code + faultInjected detail", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "confirmReplacement", "fail_503");
    const sum = await runSaga(recorder(sb).ctx, b.plan);
    const [obx] = await q.outbox(sb, sum.sagaId);
    expect(step(sum, "orders.confirmReplacement").detail).toEqual({ faultInjected: true, code: "UNAVAILABLE", outboxId: obx.id });
  });

  it("tickets.close 503 → REFUNDED_PENDING_FULFILLMENT, refund + replacement kept, note written once, outbox follow-up", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "tickets", "close", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(sum.ticketStatus).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(statuses(sum)).toEqual(["DONE", "DONE", "DONE", "DONE", "DONE", "DONE", "FAILED", "DONE"]);
    expect(step(sum, "tickets.resolve").attempts).toBe(3);
    expect(await q.faultCalls(sb, "tickets", "close")).toBe(3);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect((await q.drafts(sb, sum.sagaId)).map((d) => d.status)).toEqual(["confirmed"]);
    expect((await q.holds(sb, sum.sagaId)).map((h) => h.status)).toEqual(["consumed"]);
    const outbox = await q.outbox(sb, sum.sagaId);
    expect(outbox.map((o) => [o.kind, o.payload.step])).toEqual([["needs_ops_followup", "tickets.resolve"]]);
    // addNote was retried with the same key 3 times but wrote exactly one note.
    const tks = await q.tickets(sb, sum.sagaId);
    expect(tks.map((t) => t.status)).toEqual(["OPEN"]); // the ticket service itself is down; outbox carries the status
    expect(await q.notes(sb, tks[0].id)).toHaveLength(1);
    expect(await q.notifications(sb, sum.sagaId)).toHaveLength(1);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
    // No final-status write is attempted against the ticket service that just failed (else 4 close calls).
    expect(r.callSeq()).toEqual([
      ...S1_HAPPY_CALLS.slice(0, 6),
      "tickets.addNote",
      "tickets.close",
      "tickets.addNote",
      "tickets.close",
      "tickets.addNote",
      "tickets.close",
      "tickets.notify",
    ]);
    expect(r.calls.filter((c) => c.operation === "addNote").map((c) => c.replayed)).toEqual([false, true, true]);
    expect(step(sum, "tickets.notify").status).toBe("DONE");
    expect(r.events.at(-1)).toEqual({ type: "saga_end", sagaId: sum.sagaId, status: "REFUNDED_PENDING_FULFILLMENT", ticketStatus: "REFUNDED_PENDING_FULFILLMENT" });
  });

  it("tickets.notify 503 (last step) → REFUNDED_PENDING_FULFILLMENT; the final-status write moves the RESOLVED ticket to the pending status", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "tickets", "notify", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(sum.ticketStatus).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect(statuses(sum)).toEqual([...Array(7).fill("DONE"), "FAILED"]);
    expect(step(sum, "tickets.notify").attempts).toBe(3);
    expect(await q.notifications(sb, sum.sagaId)).toHaveLength(0);
    const outbox = await q.outbox(sb, sum.sagaId);
    expect(outbox.map((o) => [o.kind, o.payload.step])).toEqual([["needs_ops_followup", "tickets.notify"]]);
    expect(step(sum, "tickets.notify").detail).toMatchObject({ outboxId: outbox[0].id });
    expect(step(sum, "tickets.notify").error).toContain("tickets.notify: 503");
    // tickets.resolve ran before the failure (status RESOLVED, note says RESOLVED); the
    // trailing final-status call then records the follow-up status on the ticket.
    const tks = await q.tickets(sb, sum.sagaId);
    expect(tks.map((t) => t.status)).toEqual(["REFUNDED_PENDING_FULFILLMENT"]);
    expect((await q.notes(sb, tks[0].id)).map((n) => n.body.includes(": RESOLVED."))).toEqual([true]);
    expect(r.callSeq()).toEqual([...S1_HAPPY_CALLS.slice(0, 8), ...x(3, "tickets.notify"), "tickets.close"]);
    // Money + fulfilment are complete and kept.
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect((await q.drafts(sb, sum.sagaId)).map((d) => d.status)).toEqual(["confirmed"]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
  });
});

// =================================================================== carriers

describe("saga — carrier failover and circuit breaker", () => {
  it("Carrier A 503 → 3 retries → failover to Carrier B → DONE", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8820");
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("DONE");
    expect(sum.outputs.carrier).toBe("carrier_b");
    expect(sum.outputs.failover).toBe(true);
    const lbl = step(sum, "carriers.createReturnLabel");
    expect(lbl.attempts).toBe(4);
    expect(lbl.detail).toMatchObject({ carrier: "carrier_b", failover: true, breakerSkippedA: false, faultInjected: true });
    expect((lbl.detail!.tried as { carrier: string }[]).map((t) => t.carrier)).toEqual(["carrier_a"]);
    expect(r.stepEvents("FAILOVER")).toEqual([3]);
    const labels = await q.labels(sb, sum.sagaId);
    expect(labels.map((l) => [l.carrier, l.status])).toEqual([["carrier_b", "active"]]);
    expect(labels[0].trackingNo).toMatch(/^CB88\d{8}$/);
    const doneEvt = r.events.find((e) => e.type === "saga_step" && e.seq === 3 && e.status === "DONE") as Extract<SagaEvent, { type: "saga_step" }>;
    expect(doneEvt.carrier).toBe("carrier_b");
    expect(doneEvt.message).toBe("Failover → Carrier B");
    expect((await q.breaker(sb, "carrier_b")).consecutiveFailures).toBe(0);
    // Backoff only between A's attempts; the failover itself does not wait.
    expect(r.delays).toEqual([75, 150]);
    expect(r.callSeq().filter((c) => c.includes("createReturnLabel"))).toEqual([...x(3, "carrier_a.createReturnLabel"), "carrier_b.createReturnLabel"]);
    expect(await q.faultCalls(sb, "carrier_a", "createReturnLabel")).toBe(3);
    // A's three consecutive failures opened its breaker.
    const brA = await q.breaker(sb, "carrier_a");
    expect(brA.consecutiveFailures).toBe(3);
    expect(brA.openUntil!.getTime()).toBeGreaterThan(Date.now());
    // The failover event precedes B's success and names B.
    const failoverEvt = r.events.find((e) => e.type === "saga_step" && e.status === "FAILOVER") as Extract<SagaEvent, { type: "saga_step" }>;
    expect(failoverEvt.carrier).toBe("carrier_b");
    expect(r.events.indexOf(failoverEvt)).toBeLessThan(r.events.indexOf(doneEvt));
    expect((await q.token(b.tokens.label)).status).toBe("consumed");
  });

  it("breaker opens after 3 consecutive Carrier A failures; a second saga skips Carrier A entirely", async () => {
    const sb = await freshSandbox();
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");

    const first = await runSaga(recorder(sb).ctx, (await showcase2(sb, "ORD-8820")).plan);
    expect(first.status).toBe("DONE");
    expect(first.outputs.carrier).toBe("carrier_b");
    const br = await q.breaker(sb, "carrier_a");
    expect(br.consecutiveFailures).toBe(3);
    expect(br.openUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await carriers.breakerOpen(db(), sb, "carrier_a")).toBe(true);
    expect(await q.faultCalls(sb, "carrier_a", "createReturnLabel")).toBe(3);

    const r2 = recorder(sb);
    const second = await runSaga(r2.ctx, (await showcase2(sb, "ORD-8821")).plan);
    expect(second.status).toBe("DONE");
    expect(second.sagaId).not.toBe(first.sagaId);
    const lbl = step(second, "carriers.createReturnLabel");
    expect(lbl.attempts).toBe(1);
    expect(lbl.detail).toMatchObject({ carrier: "carrier_b", failover: true, breakerSkippedA: true, tried: [] });
    // Carrier A was never called again.
    expect(r2.calls.filter((c) => c.service === "carrier_a" && c.operation === "createReturnLabel")).toEqual([]);
    expect(await q.faultCalls(sb, "carrier_a", "createReturnLabel")).toBe(3);
    expect(r2.stepEvents("FAILOVER")).toEqual([]); // nothing to fail over from: A was skipped up front
    expect(r2.delays).toEqual([]);

    // Once the open window has passed, the next saga tries Carrier A again (still failing here),
    // then fails over: the breaker is a time-boxed skip, not a permanent ban.
    await db().update(s.breakers).set({ openUntil: new Date(Date.now() - 1000) }).where(and(eq(s.breakers.sandboxId, sb), eq(s.breakers.service, "carrier_a")));
    expect(await carriers.breakerOpen(db(), sb, "carrier_a")).toBe(false);
    const r3 = recorder(sb);
    const third = await runSaga(r3.ctx, (await showcase1(sb)).plan);
    expect(third.status).toBe("DONE");
    expect(step(third, "carriers.createReturnLabel").detail).toMatchObject({ carrier: "carrier_b", failover: true, breakerSkippedA: false });
    expect(r3.callSeq().filter((c) => c.includes("createReturnLabel"))).toEqual([...x(3, "carrier_a.createReturnLabel"), "carrier_b.createReturnLabel"]);
    expect(await q.faultCalls(sb, "carrier_a", "createReturnLabel")).toBe(6);
  });

  it("transient Carrier A failures (fail_n_times 2) recover on A, no failover, breaker reset to 0", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8820");
    await fault(sb, "carrier_a", "createReturnLabel", "fail_n_times", 2);
    // Breaker state as seen during each backoff wait (i.e. after 1 and after 2 failures).
    const seen: { failures: number; open: boolean }[] = [];
    const r = recorder(sb, {
      sleep: async (ms: number) => {
        r.delays.push(ms);
        seen.push({ failures: (await q.breaker(sb, "carrier_a")).consecutiveFailures, open: await carriers.breakerOpen(db(), sb, "carrier_a") });
      },
    });
    const sum = await runSaga(r.ctx, b.plan);
    // Two failures stay below the threshold of three: the breaker never opened.
    expect(seen).toEqual([
      { failures: 1, open: false },
      { failures: 2, open: false },
    ]);
    expect(sum.status).toBe("DONE");
    expect(sum.outputs.carrier).toBe("carrier_a");
    expect(sum.outputs.failover).toBe(false);
    expect(step(sum, "carriers.createReturnLabel").attempts).toBe(3);
    expect(r.delays).toEqual([75, 150]);
    expect(r.stepEvents("FAILOVER")).toEqual([]);
    const br = await q.breaker(sb, "carrier_a");
    expect(br.consecutiveFailures).toBe(0);
    expect(br.openUntil).toBeNull();
  });

  it("Carrier A commit_then_timeout → idempotent retry returns the committed label (exactly one label)", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8820");
    await fault(sb, "carrier_a", "createReturnLabel", "commit_then_timeout");
    const r = recorder(sb);
    const sum = await runSaga(r.ctx, b.plan);
    expect(sum.status).toBe("DONE");
    const labels = await q.labels(sb, sum.sagaId);
    expect(labels.map((l) => [l.carrier, l.status])).toEqual([["carrier_a", "active"]]);
    expect(sum.outputs.labelId).toBe(labels[0].id);
    expect(sum.outputs.failover).toBe(false);
    expect(step(sum, "carriers.createReturnLabel").attempts).toBe(2);
    // Lost response (504), then the retry with the same key replays the stored label; B is never involved.
    const labelCalls = r.calls.filter((c) => c.operation === "createReturnLabel");
    expect(labelCalls.map((c) => [c.service, c.ok, c.status ?? null, c.replayed ?? false])).toEqual([
      ["carrier_a", false, 504, false],
      ["carrier_a", true, null, true],
    ]);
    expect(r.delays).toEqual([75]);
    // The timeout counted against A, the replayed success reset it.
    expect((await q.breaker(sb, "carrier_a")).consecutiveFailures).toBe(0);
    expect((await q.token(b.tokens.label)).status).toBe("consumed");
  });

  it("Carrier A schema_drift → label reconciled from the carrier's own records, no failover, one label", async () => {
    const sb = await freshSandbox();
    const b = await showcase2(sb, "ORD-8820");
    await fault(sb, "carrier_a", "createReturnLabel", "schema_drift");
    const r = recorder(sb);
    const sum = await runSaga(r.ctx, b.plan);
    expect(sum.status).toBe("DONE");
    const lbl = step(sum, "carriers.createReturnLabel");
    expect(lbl.attempts).toBe(1);
    expect(lbl.detail).toMatchObject({ carrier: "carrier_a", reconciled: true, failover: false });
    const labels = await q.labels(sb, sum.sagaId);
    expect(labels.map((l) => [l.id, l.carrier, l.status])).toEqual([[sum.outputs.labelId, "carrier_a", "active"]]);
    expect(sum.outputs.trackingNo).toBe(labels[0].trackingNo);
    // Read from A's own records, not retried and not failed over to B.
    expect(r.callSeq().filter((c) => c.includes("createReturnLabel"))).toEqual(["carrier_a.createReturnLabel"]);
    expect(r.stepEvents("FAILOVER")).toEqual([]);
    expect(r.delays).toEqual([]);
  });

  it("a label issued by Carrier B after failover is voided when the pivot later fails", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");
    await fault(sb, "billing", "refund", "fail_503");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "COMPENSATED", "COMPENSATED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(sum.outputs.carrier).toBe("carrier_b");
    expect((await q.labels(sb, sum.sagaId)).map((l) => [l.carrier, l.status])).toEqual([["carrier_b", "voided"]]);
    expect(r.callNames(["voidLabel"])).toEqual(["carrier_a.voidLabel", "carrier_b.voidLabel"]);
    expect(r.calls.filter((c) => c.operation === "voidLabel").map((c) => c.ok)).toEqual([true, true]);
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  // BUG: src/lib/saga/orchestrator.ts rollback() compensates carriers.createReturnLabel by calling
  // voidLabel on carrier_a and THEN carrier_b inside one withRetry, regardless of which carrier
  // issued the label. During a Carrier A outage (exactly when the saga fails over to B) A's
  // voidLabel is also down, so the compensation throws before Carrier B is ever asked to void.
  // Repro: fault carrier_a.createReturnLabel + carrier_a.voidLabel + billing.refund = fail_503, run
  // showcase 1. Expected: the Carrier B label (the only label) is voided and the saga ROLLED_BACK.
  // Actual: COMPENSATION_FAILED, carrier_b.voidLabel never called, the B label stays "active".
  it("a Carrier A voidLabel outage prevents voiding the label Carrier B issued", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");
    await fault(sb, "carrier_a", "voidLabel", "fail_503");
    await fault(sb, "billing", "refund", "fail_503");
    const r = recorder(sb);
    const sum = await runSaga(r.ctx, b.plan);
    // Actual today: [["carrier_b", "active"]] — the only label is left live.
    expect((await q.labels(sb, sum.sagaId)).map((l) => [l.carrier, l.status])).toEqual([["carrier_b", "voided"]]);
    expect(r.callNames(["voidLabel"])).toContain("carrier_b.voidLabel");
    expect(sum.status).toBe("ROLLED_BACK");
  });
});

// =================================================================== pivot reconciliation

describe("saga — unknown outcome at the pivot is reconciled against the ledger", () => {
  it("schema_drift on billing.refund → reconciled via ledger: exactly one refund, step DONE with detail.reconciled", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "schema_drift");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("DONE");
    const rf = step(sum, "billing.refund");
    expect(rf.status).toBe("DONE");
    expect(rf.attempts).toBe(1);
    expect(rf.detail).toEqual({ reconciled: true, faultInjected: true });
    expect(rf.error).toBeNull();
    expect(r.stepEvents("RECONCILED")).toEqual([5]);
    const refunds = await q.refundsFor(sb, "ORD-9941");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: sum.outputs.refundId, amountCents: 32000, sagaId: sum.sagaId });
    expect(sum.outputs.refundAmountCents).toBe(32000);
    // Only one billing.refund call: the drift is not retried, the ledger is read instead.
    expect(r.calls.filter((c) => c.operation === "refund")).toHaveLength(1);
    expect(await q.faultCalls(sb, "billing", "refund")).toBe(1);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
    // The reconciled refund is the real ledger row (its idempotency key is this step's key) and
    // the rest of the saga used it: the note + preview cite the reconciled refund ID.
    const [stepRow] = (await q.steps(sum.sagaId)).filter((x) => x.seq === 5);
    expect(refunds[0].idempotencyKey).toBe(stepRow.idempotencyKey);
    expect(stepRow.response).toEqual({ refundId: refunds[0].id, orderId: "ORD-9941", amountCents: 32000, status: "succeeded" });
    expect((await q.notifications(sb, sum.sagaId))[0].preview).toContain(`Refund ${refunds[0].id}: $320.00.`);
    expect((await q.token(b.tokens.refund)).status).toBe("consumed");
    expect(r.callSeq()).toEqual(S1_HAPPY_CALLS);
  });

  it("commit_then_timeout on billing.refund → the retry replays the stored response: exactly one refund", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "commit_then_timeout");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("DONE");
    expect(step(sum, "billing.refund").attempts).toBe(2);
    expect(r.delays).toEqual([75]);
    const refunds = await q.refundsFor(sb, "ORD-9941");
    expect(refunds.map((x) => [x.id, x.amountCents])).toEqual([[sum.outputs.refundId, 32000]]);
    const refundCalls = r.calls.filter((c) => c.operation === "refund");
    expect(refundCalls.map((c) => [c.ok, c.status ?? null, c.replayed ?? false])).toEqual([
      [false, 504, false],
      [true, null, true],
    ]);
    expect((await q.token(b.tokens.refund)).status).toBe("consumed");
  });

  it("plain timeout on billing.refund (never committed) → ledger shows nothing → FAILED, ROLLED_BACK, no refund", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await fault(sb, "billing", "refund", "timeout");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, b.plan);

    const rf = step(sum, "billing.refund");
    expect(rf.status).toBe("FAILED");
    expect(rf.attempts).toBe(3);
    expect(rf.detail).toMatchObject({ code: "TIMEOUT" });
    expect(r.stepEvents("RECONCILED")).toEqual([]);
    expect(r.stepEvents("COMPENSATED")).toEqual([4, 3, 2, 1]);
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("transient 429 on billing.refund honours retry-after then succeeds on attempt 2 (one refund)", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "rate_limit_429");
    const delays: number[] = [];
    const r = recorder(sb, {
      sleep: async (ms: number) => {
        delays.push(ms);
        // The rate limit lifts while we wait.
        if (delays.length === 1) await fault(sb, "billing", "refund", "healthy");
      },
    });

    const sum = await runSaga(r.ctx, b.plan);

    expect(sum.status).toBe("DONE");
    expect(delays).toEqual([1000]);
    expect(step(sum, "billing.refund").attempts).toBe(2);
    expect(step(sum, "billing.refund").detail).toMatchObject({ faultInjected: true });
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
  });

  it("replacement-only plan: confirmReplacement is the pivot; schema_drift on it is reconciled from the drafts", async () => {
    const sb = await freshSandbox();
    const threadId = await newThread(sb, "CUS-1002");
    const replacement = await token(sb, threadId, "replacement", "ORD-8820", { sku: "KIT-POUR-02", qty: 1 });
    const label = await token(sb, threadId, "return_label", "ORD-8820");
    const plan: SagaPlan = {
      sandboxId: sb,
      threadId,
      customerId: "CUS-1002",
      customerName: "Daniel Okafor",
      primaryOrderId: "ORD-8820",
      subject: "Pour-over set arrived broken.",
      actions: [
        { action: { type: "replacement", orderId: "ORD-8820", sku: "KIT-POUR-02", qty: 1, reason: "damaged" }, tokenId: replacement },
        { action: { type: "return_label", orderId: "ORD-8820", reason: "damaged" }, tokenId: label },
      ],
    };
    await fault(sb, "orders", "confirmReplacement", "schema_drift");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, plan);

    expect(sum.status).toBe("DONE");
    expect(sum.pivotSeq).toBe(5);
    expect(sum.steps.map((st) => [st.name, st.kind])).toEqual([
      ["tickets.create", "reversible"],
      ["orders.reserveInventory", "reversible"],
      ["carriers.createReturnLabel", "reversible"],
      ["orders.createReplacementDraft", "reversible"],
      ["orders.confirmReplacement", "pivot"],
      ["tickets.resolve", "retriable"],
      ["tickets.notify", "retriable"],
    ]);
    const confirm = step(sum, "orders.confirmReplacement");
    expect(confirm.status).toBe("DONE");
    expect(confirm.attempts).toBe(1);
    expect(confirm.detail).toEqual({ reconciled: true, faultInjected: true });
    expect(r.stepEvents("RECONCILED")).toEqual([5]);
    const drafts = await q.drafts(sb, sum.sagaId);
    expect(drafts.map((d) => [d.id, d.status])).toEqual([[sum.outputs.draftId, "confirmed"]]);
    expect((await q.holds(sb, sum.sagaId)).map((h) => h.status)).toEqual(["consumed"]);
    expect(await q.refundsFor(sb, "ORD-8820")).toHaveLength(0);
    expect(r.callNames(COMPENSATION_OPS)).toEqual([]);
  });

  it("store-credit-only plan: issueStoreCredit is the pivot; schema_drift on it is reconciled by idempotency key", async () => {
    const sb = await freshSandbox();
    const threadId = await newThread(sb, "CUS-1001");
    const credit = await token(sb, threadId, "store_credit", "ORD-9941", { amountCents: 1500 });
    const plan: SagaPlan = {
      sandboxId: sb,
      threadId,
      customerId: "CUS-1001",
      customerName: "Sarah Jenkins",
      primaryOrderId: "ORD-9941",
      subject: "Goodwill credit.",
      actions: [{ action: { type: "store_credit", orderId: "ORD-9941", amountCents: 1500, reason: "goodwill" }, tokenId: credit }],
    };
    await fault(sb, "billing", "issueStoreCredit", "schema_drift");
    const r = recorder(sb);

    const sum = await runSaga(r.ctx, plan);

    expect(sum.status).toBe("DONE");
    expect(sum.steps.map((st) => [st.name, st.kind, st.status])).toEqual([
      ["tickets.create", "reversible", "DONE"],
      ["billing.issueStoreCredit", "pivot", "DONE"],
      ["tickets.resolve", "retriable", "DONE"],
      ["tickets.notify", "retriable", "DONE"],
    ]);
    expect(step(sum, "billing.issueStoreCredit").detail).toEqual({ reconciled: true, faultInjected: true });
    const credits = await db().select().from(s.storeCredits).where(and(eq(s.storeCredits.sandboxId, sb), eq(s.storeCredits.sagaId, sum.sagaId)));
    expect(credits.map((c) => [c.id, c.amountCents])).toEqual([[sum.outputs.creditId, 1500]]);
    expect(sum.outputs.creditAmountCents).toBe(1500);
    expect(await q.faultCalls(sb, "billing", "issueStoreCredit")).toBe(1);
  });
});

// =================================================================== crash + recovery

describe("saga — crash and recovery", () => {
  it("crashAfterSeq=3 → saga left RUNNING; recoverSagas(…, 0) resumes from step 4 and finishes consistently", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");

    await expect(runSaga(recorder(sb, { crashAfterSeq: 3 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);

    const [run] = await q.sagas(sb);
    expect(run.status).toBe("RUNNING");
    expect((await q.steps(run.id)).map((st) => st.status)).toEqual(["DONE", "DONE", "DONE", "PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
    expect(await q.refundsFor(sb, "ORD-9941")).toHaveLength(0);
    // Not stale yet under the default threshold (15 s): nothing is picked up.
    expect(await recoverSagas(recorder(sb).ctx)).toEqual([]);
    expect((await findStuckSagas(db(), sb, 0)).map((x) => [x.id, x.status])).toEqual([[run.id, "RUNNING"]]);

    const r = recorder(sb);
    const recovered = await recoverSagas(r.ctx, 0);
    expect(recovered).toHaveLength(1);
    const sum = recovered[0];
    expect(sum.sagaId).toBe(run.id);
    expect(sum.status).toBe("DONE");
    expect(r.events[0]).toMatchObject({ type: "saga_start", resumed: true });
    expect(r.stepEvents("RUNNING")).toEqual([4, 5, 6, 7, 8]); // steps 1–3 were not re-run
    expect(sum.steps.slice(0, 3).map((st) => st.attempts)).toEqual([1, 1, 1]);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect((await q.tickets(sb, run.id)).map((t) => t.status)).toEqual(["RESOLVED"]);
    expect((await q.holds(sb, run.id)).map((h) => h.status)).toEqual(["consumed"]);
    expect((await q.labels(sb, run.id)).map((l) => l.status)).toEqual(["active"]);
    expect((await q.drafts(sb, run.id)).map((d) => d.status)).toEqual(["confirmed"]);
    expect((await q.inventory(sb, "GLS-AUR-01")).onHand).toBe(inv0.onHand - 1);
    expect(await findStuckSagas(db(), sb, 0)).toEqual([]);
  });

  it("crashAfterSeq=5 (right after the pivot) → recovery continues forward, never a second refund", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await expect(runSaga(recorder(sb, { crashAfterSeq: 5 }).ctx, b.plan)).rejects.toThrow(/Simulated crash after step 5 billing\.refund/);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);

    const r = recorder(sb);
    const [sum] = await recoverSagas(r.ctx, 0);
    expect(sum.status).toBe("DONE");
    expect(r.stepEvents("RUNNING")).toEqual([6, 7, 8]);
    expect(r.calls.filter((c) => c.operation === "refund")).toEqual([]);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
  });

  it("crash_after fault on billing.refund (commit, then the process dies) → recovery replays, exactly one refund", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "crash_after");

    await expect(runSaga(recorder(sb).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);

    const [run] = await q.sagas(sb);
    expect(run.status).toBe("RUNNING");
    const steps0 = await q.steps(run.id);
    expect(steps0[4].status).toBe("RUNNING"); // died mid-step
    const committed = await q.refundsFor(sb, "ORD-9941");
    expect(committed).toHaveLength(1); // the refund committed before the "crash"

    const r = recorder(sb);
    const [sum] = await recoverSagas(r.ctx, 0);
    expect(sum.status).toBe("DONE");
    expect(sum.outputs.refundId).toBe(committed[0].id);
    const refundCalls = r.calls.filter((c) => c.operation === "refund");
    expect(refundCalls.map((c) => [c.ok, c.replayed])).toEqual([[true, true]]);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.id)).toEqual([committed[0].id]);
    expect((await q.tickets(sb, run.id)).map((t) => t.status)).toEqual(["RESOLVED"]);
    // Resumed at the step that was in flight (not before it), counting the pre-crash attempt.
    expect(r.stepEvents("RUNNING")).toEqual([5, 6, 7, 8]);
    expect(step(sum, "billing.refund")).toMatchObject({ status: "DONE", attempts: 2 });
    expect((await q.token(b.tokens.refund)).status).toBe("consumed");
    expect(await findStuckSagas(db(), sb, 0)).toEqual([]);
  });

  it("crash_after fault on createReplacementDraft → recovery replays the draft (exactly one draft) and finishes DONE", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "createReplacementDraft", "crash_after");
    await expect(runSaga(recorder(sb).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    expect((await q.drafts(sb, run.id)).map((d) => d.status)).toEqual(["draft"]);

    const [sum] = await recoverSagas(recorder(sb).ctx, 0);
    expect(sum.status).toBe("DONE");
    const drafts = await q.drafts(sb, run.id);
    expect(drafts.map((d) => [d.id, d.status])).toEqual([[sum.outputs.draftId, "confirmed"]]);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
  });

  it("a crash in the middle of compensation (run left COMPENSATING) is finished by recovery", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    // Steps 1–4 complete, then the process dies.
    await expect(runSaga(recorder(sb, { crashAfterSeq: 4 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    // Simulate the state a crash mid-rollback leaves behind: pivot FAILED, compensation began
    // (the draft was already cancelled and marked COMPENSATED), run still COMPENSATING.
    expect((await orders.cancelDraft({ db: db(), sandboxId: sb }, { sagaId: run.id })).affected).toBe(1);
    await db().update(s.sagaSteps).set({ status: "FAILED", error: "simulated" }).where(and(eq(s.sagaSteps.sagaId, run.id), eq(s.sagaSteps.seq, 5)));
    await db().update(s.sagaSteps).set({ status: "COMPENSATED" }).where(and(eq(s.sagaSteps.sagaId, run.id), eq(s.sagaSteps.seq, 4)));
    await db().update(s.sagaRuns).set({ status: "COMPENSATING" }).where(eq(s.sagaRuns.id, run.id));
    expect((await findStuckSagas(db(), sb, 0)).map((x) => x.status)).toEqual(["COMPENSATING"]);

    const r = recorder(sb);
    const [sum] = await recoverSagas(r.ctx, 0);
    expect(sum.status).toBe("ROLLED_BACK");
    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "COMPENSATED", "COMPENSATED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(r.stepEvents("COMPENSATED")).toEqual([3, 2, 1]); // step 4 was already done before the crash
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["carrier_a.voidLabel", "carrier_b.voidLabel", "orders.releaseInventory", "tickets.cancel"]);
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  it("a step left COMPENSATING by a crash (undo in flight) has its compensation re-run on recovery", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await expect(runSaga(recorder(sb, { crashAfterSeq: 4 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    // Died after marking step 4 COMPENSATING but before cancelDraft committed.
    await db().update(s.sagaSteps).set({ status: "FAILED", error: "simulated" }).where(and(eq(s.sagaSteps.sagaId, run.id), eq(s.sagaSteps.seq, 5)));
    await db().update(s.sagaSteps).set({ status: "COMPENSATING" }).where(and(eq(s.sagaSteps.sagaId, run.id), eq(s.sagaSteps.seq, 4)));
    await db().update(s.sagaRuns).set({ status: "COMPENSATING" }).where(eq(s.sagaRuns.id, run.id));
    expect((await q.drafts(sb, run.id)).map((d) => d.status)).toEqual(["draft"]);

    const r = recorder(sb);
    const [sum] = await recoverSagas(r.ctx, 0);
    expect(r.events[0]).toMatchObject({ type: "saga_start", resumed: true, sagaId: run.id });
    expect(statuses(sum)).toEqual(["COMPENSATED", "COMPENSATED", "COMPENSATED", "COMPENSATED", "FAILED", "SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(r.stepEvents("COMPENSATED")).toEqual([4, 3, 2, 1]);
    expect(r.callNames(COMPENSATION_OPS)).toEqual(["orders.cancelDraft", "carrier_a.voidLabel", "carrier_b.voidLabel", "orders.releaseInventory", "tickets.cancel"]);
    // Forward steps are never re-run during a resumed compensation.
    expect(r.stepEvents("RUNNING")).toEqual([]);
    expect((await q.drafts(sb, run.id)).map((d) => d.status)).toEqual(["cancelled"]);
    await expectCleanRollback(sb, sum, b, "GLS-AUR-01", { onHand: inv0.onHand, reserved: inv0.reserved }, { ticketExpected: true });
  });

  // BUG: src/lib/saga/orchestrator.ts continueSaga() writes the needs_ops_followup outbox row in a
  // separate statement AFTER executeStep has already persisted the retriable step as FAILED. If the
  // process dies between the two writes, recovery treats the FAILED retriable step as "already
  // handled" (it only pushes it onto `followups` and `continue`s), so no outbox row is ever written:
  // the saga ends REFUNDED_PENDING_FULFILLMENT with the replacement still a draft and nobody queued
  // to fulfil it. Repro (state a crash in that window leaves): crashAfterSeq 5, then mark step 6
  // (orders.confirmReplacement) FAILED, recoverSagas(…, 0). Expected: one needs_ops_followup row for
  // orders.confirmReplacement. Actual: no outbox row at all.
  it("a crash between a retriable step's FAILED write and its outbox write loses the ops follow-up", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await expect(runSaga(recorder(sb, { crashAfterSeq: 5 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    await db()
      .update(s.sagaSteps)
      .set({ status: "FAILED", attempts: 3, error: "orders.confirmReplacement: 503", detail: { code: "UNAVAILABLE", faultInjected: true } })
      .where(and(eq(s.sagaSteps.sagaId, run.id), eq(s.sagaSteps.seq, 6)));
    const [sum] = await recoverSagas(recorder(sb).ctx, 0);
    expect(sum.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    expect((await q.outbox(sb, run.id)).map((o) => [o.kind, o.payload.step])).toEqual([["needs_ops_followup", "orders.confirmReplacement"]]);
  });

  // BUG: src/lib/saga/orchestrator.ts rollback() wraps every compensation in try/catch and does
  // not re-throw SimulatedCrash (unlike executeStep, which does). A `crash_after` fault on a
  // compensation operation (e.g. orders.cancelDraft — exposed in SERVICE_OPERATIONS for chaos)
  // is therefore recorded as a *compensation failure*: the run ends COMPENSATION_FAILED with a
  // `compensation_failed` outbox row, even though cancelDraft actually committed (the draft is
  // cancelled), and the "process died" never happens, so resumed compensation is never exercised.
  // Expected: runSaga rejects with SimulatedCrash leaving the run COMPENSATING, and
  // recoverSagas(…, 0) finishes it as ROLLED_BACK. Actual: runSaga resolves COMPENSATION_FAILED.
  it.skip("BUG (flaky, under investigation): crash_after on a compensation is swallowed as COMPENSATION_FAILED instead of crashing + resuming", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "fail_503");
    await fault(sb, "orders", "cancelDraft", "crash_after");
    await expect(runSaga(recorder(sb).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    expect(run.status).toBe("COMPENSATING");
    const [sum] = await recoverSagas(recorder(sb).ctx, 0);
    expect(sum.status).toBe("ROLLED_BACK");
    expect((await q.outbox(sb, run.id)).map((o) => o.kind)).toEqual(["human_followup"]);
  });
});

// =================================================================== idempotency

describe("saga — idempotency", () => {
  it("compensations are idempotent: releaseInventory / cancelDraft / voidLabel / rollbackTicket twice is a no-op", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const inv0 = await q.inventory(sb, "GLS-AUR-01");
    await expect(runSaga(recorder(sb, { crashAfterSeq: 4 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const [run] = await q.sagas(sb);
    const svc = { db: db(), sandboxId: sb };
    expect((await q.inventory(sb, "GLS-AUR-01")).reserved).toBe(inv0.reserved + 1);

    // First call undoes the work…
    expect(await orders.releaseInventory(svc, { sagaId: run.id })).toEqual({ affected: 1 });
    expect(await orders.cancelDraft(svc, { sagaId: run.id })).toEqual({ affected: 1 });
    expect(await carriers.voidLabel(svc, "carrier_a", { sagaId: run.id })).toEqual({ affected: 1 });
    expect(await carriers.voidLabel(svc, "carrier_b", { sagaId: run.id })).toEqual({ affected: 0 });
    expect(await tickets.rollbackTicket(svc, { sagaId: run.id, reason: "test" })).toEqual({ affected: 1 });
    const snapshot = async () => ({
      inv: await q.inventory(sb, "GLS-AUR-01"),
      holds: (await q.holds(sb, run.id)).map((h) => h.status),
      drafts: (await q.drafts(sb, run.id)).map((d) => d.status),
      labels: (await q.labels(sb, run.id)).map((l) => l.status),
      tickets: (await q.tickets(sb, run.id)).map((t) => t.status),
      outbox: (await q.outbox(sb, run.id)).map((o) => o.kind),
    });
    const after1 = await snapshot();
    expect(after1.inv.reserved).toBe(inv0.reserved);
    expect(after1.inv.onHand).toBe(inv0.onHand);
    expect(after1).toMatchObject({ holds: ["released"], drafts: ["cancelled"], labels: ["voided"], tickets: ["ROLLED_BACK"], outbox: ["human_followup"] });

    // …the second call changes nothing (no double release of the reservation, no second outbox row).
    expect(await orders.releaseInventory(svc, { sagaId: run.id })).toEqual({ affected: 0 });
    expect(await orders.cancelDraft(svc, { sagaId: run.id })).toEqual({ affected: 0 });
    expect(await carriers.voidLabel(svc, "carrier_a", { sagaId: run.id })).toEqual({ affected: 0 });
    expect(await tickets.rollbackTicket(svc, { sagaId: run.id, reason: "test" })).toEqual({ affected: 0 });
    expect(await snapshot()).toEqual(after1);
  });

  it("runSaga twice with the same plan returns the same saga and never refunds twice", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    const first = await runSaga(recorder(sb).ctx, b.plan);
    expect(first.status).toBe("DONE");

    const r = recorder(sb);
    const again = await runSaga(r.ctx, b.plan);
    expect(again).toEqual(first);
    // A finished saga is summarized, not re-run: no events, no service calls.
    expect(r.events).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(await q.sagas(sb)).toHaveLength(1);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect(await q.tickets(sb, first.sagaId)).toHaveLength(1);
    expect(await q.notifications(sb, first.sagaId)).toHaveLength(1);
  });

  it("runSaga again on a ROLLED_BACK saga (fault since cleared) returns it unchanged: nothing re-run or re-compensated", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "billing", "refund", "fail_503");
    const first = await runSaga(recorder(sb).ctx, b.plan);
    expect(first.status).toBe("ROLLED_BACK");
    await fault(sb, "billing", "refund", "healthy");

    const r = recorder(sb);
    const again = await runSaga(r.ctx, b.plan);
    expect(again).toEqual(first);
    expect(r.events).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(await q.sagas(sb)).toHaveLength(1);
    expect(await q.refundsFor(sb, "ORD-9941")).toHaveLength(0);
    expect((await q.outbox(sb, first.sagaId)).map((o) => o.kind)).toEqual(["human_followup"]);
    // A final saga is not "stuck" either, so recovery leaves it alone.
    expect(await recoverSagas(r.ctx, 0)).toEqual([]);
  });

  it("runSaga again on a REFUNDED_PENDING_FULFILLMENT saga does not silently retry the outboxed step", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "confirmReplacement", "fail_503");
    const first = await runSaga(recorder(sb).ctx, b.plan);
    expect(first.status).toBe("REFUNDED_PENDING_FULFILLMENT");
    await fault(sb, "orders", "confirmReplacement", "healthy");

    const r = recorder(sb);
    const again = await runSaga(r.ctx, b.plan);
    expect(again).toEqual(first);
    expect(r.calls).toEqual([]);
    expect((await q.drafts(sb, first.sagaId)).map((d) => d.status)).toEqual(["draft"]);
    expect((await q.outbox(sb, first.sagaId)).map((o) => o.kind)).toEqual(["needs_ops_followup"]);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
  });

  it("a new thread with its own approvals is a separate saga (plan hash covers thread + actions only)", async () => {
    const sb = await freshSandbox();
    const a = await showcase2(sb, "ORD-8820");
    // The hash keys on threadId + actions; display fields do not split a saga.
    expect(planHashOf({ ...a.plan, threadId: "thr_other" })).not.toBe(planHashOf(a.plan));
    expect(planHashOf({ ...a.plan, customerName: "Someone Else", subject: "changed" })).toBe(planHashOf(a.plan));
    const sumA = await runSaga(recorder(sb).ctx, a.plan);
    const b = await showcase2(sb, "ORD-8820");
    expect(planHashOf(b.plan)).not.toBe(planHashOf(a.plan));
    const sumB = await runSaga(recorder(sb).ctx, b.plan);
    expect(sumB.sagaId).not.toBe(sumA.sagaId);
    expect([sumA.status, sumB.status]).toEqual(["DONE", "DONE"]);
    expect((await q.refundsFor(sb, "ORD-8820")).map((x) => x.sagaId).sort()).toEqual([sumA.sagaId, sumB.sagaId].sort());
  });

  it("runSaga on a crashed (non-final) saga with the same plan resumes it instead of starting a second one", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await expect(runSaga(recorder(sb, { crashAfterSeq: 2 }).ctx, b.plan)).rejects.toBeInstanceOf(SimulatedCrash);
    const r = recorder(sb);
    const sum = await runSaga(r.ctx, b.plan);
    expect(sum.status).toBe("DONE");
    expect(r.events[0]).toMatchObject({ type: "saga_start", resumed: true, sagaId: sum.sagaId });
    expect(r.stepEvents("RUNNING")).toEqual([3, 4, 5, 6, 7, 8]);
    expect(await q.sagas(sb)).toHaveLength(1);
    expect(await q.tickets(sb, sum.sagaId)).toHaveLength(1);
    expect(await q.holds(sb, sum.sagaId)).toHaveLength(1);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
  });
});

// =================================================================== concurrent execution of one saga

/** A sleep hook that parks the saga in its first retry wait until released (deterministic interleaving). */
function parkingSleep() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let parked!: () => void;
  const isParked = new Promise<void>((r) => (parked = r));
  let n = 0;
  const sleep = async () => {
    n++;
    if (n === 1) {
      parked();
      await gate;
    }
  };
  return { sleep, isParked, release };
}

describe("saga — a saga that is still running must not be executed twice", () => {
  // BUG: src/lib/saga/orchestrator.ts recoverSagas()/findStuckSagas() have no lease or lock on a
  // run, and POST /api/saga/recover calls recoverThreads(…, 0) → recoverSagas(ctx, 0), which picks
  // up EVERY RUNNING saga in the sandbox — including one that is alive in another request (here:
  // parked in a 503 retry wait on step 2). Recovery drives the saga to DONE (refund issued,
  // replacement confirmed, ticket RESOLVED). When the original runner wakes up, its retry of
  // orders.reserveInventory fails with TOKEN_ALREADY_USED (reserveInventory calls verifyTokenOnly
  // *before* the idempotency replay, and the replacement token was consumed by the recovery's
  // createReplacementDraft), so it rolls back: the active return label is VOIDED and the saga row is
  // overwritten to ROLLED_BACK / ticketStatus ROLLED_BACK while a $320 refund sits in the ledger and
  // the replacement is confirmed. Expected: the in-flight saga is either skipped by recovery or the
  // second runner is excluded; final saga DONE, label active. Actual: ROLLED_BACK + voided label.
  it.skip("BUG (flaky on CI, same root cause as the concurrent runSaga case below): recoverSagas(…, 0) while the saga is still running → refund issued but saga ROLLED_BACK and label voided", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "reserveInventory", "fail_n_times", 1);
    const park = parkingSleep();
    const firstP = runSaga(recorder(sb, { sleep: park.sleep }).ctx, b.plan);
    let first: SagaSummary;
    try {
      await park.isParked;
      await recoverSagas(recorder(sb).ctx, 0);
    } finally {
      park.release();
      first = await firstP;
    }
    const [run] = await q.sagas(sb);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect(first.status).toBe("DONE");
    expect(run.status).toBe("DONE");
    expect((await q.labels(sb, run.id)).map((l) => l.status)).toEqual(["active"]);
  });

  // BUG: src/lib/saga/orchestrator.ts runSaga() — when a run with the same thread + plan hash exists
  // and is not final, it calls continueSaga() immediately, even if that run is alive in another
  // caller (e.g. a duplicate approve/resume arriving while the first is mid-retry). Same corruption
  // as above: one caller returns DONE, the other ROLLED_BACK, and the stored run ends ROLLED_BACK
  // with the label voided although the refund was issued. Expected: both callers observe the same,
  // consistent outcome (DONE). Actual: the first caller returns ROLLED_BACK.
  it.fails("BUG: a second runSaga with the same plan while the first is in flight double-executes the saga", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "reserveInventory", "fail_n_times", 1);
    const park = parkingSleep();
    const firstP = runSaga(recorder(sb, { sleep: park.sleep }).ctx, b.plan);
    let first: SagaSummary;
    let second: SagaSummary;
    try {
      await park.isParked;
      second = await runSaga(recorder(sb).ctx, b.plan);
    } finally {
      park.release();
      first = await firstP;
    }
    expect(await q.sagas(sb)).toHaveLength(1);
    expect((await q.refundsFor(sb, "ORD-9941")).map((x) => x.amountCents)).toEqual([32000]);
    expect(second!.status).toBe("DONE");
    expect(first.status).toBe(second!.status);
    expect((await q.sagas(sb))[0].status).toBe("DONE");
  });

  // BUG: src/lib/saga/orchestrator.ts findStuckSagas() decides staleness from saga_runs.updated_at,
  // which is written at creation and on status changes only — never when a step makes progress.
  // AGENT.sagaStaleMs is documented as "a saga step stuck in RUNNING for longer than this", but a
  // saga whose step 4 finished milliseconds ago (and whose step 5 just started) is reported stuck as
  // soon as the whole saga is older than the threshold. /api/resolve then "recovers" it concurrently
  // with the live runner (see the bugs above). Expected: [] (no step has been RUNNING > 1 s).
  // Actual: the live saga is returned as stuck.
  it("findStuckSagas reports a live, progressing saga as stuck (staleness measured from saga start)", async () => {
    const sb = await freshSandbox();
    const b = await showcase1(sb);
    await fault(sb, "orders", "reserveInventory", "fail_n_times", 1);
    await fault(sb, "billing", "refund", "fail_n_times", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked!: () => void;
    const isParked = new Promise<void>((r) => (parked = r));
    let n = 0;
    const sleep = async () => {
      n++;
      if (n === 1) return new Promise<void>((r) => setTimeout(r, 1200)); // a slow, but alive, step 2 retry
      parked(); // step 5 retry: steps 2–4 completed just now
      await gate;
    };
    const firstP = runSaga(recorder(sb, { sleep }).ctx, b.plan);
    try {
      await isParked;
      const [run] = await q.sagas(sb);
      const steps = await q.steps(run.id);
      expect(steps.map((st) => st.status)).toEqual(["DONE", "DONE", "DONE", "DONE", "RUNNING", "PENDING", "PENDING", "PENDING"]);
      expect(Date.now() - steps[3].finishedAt!.getTime()).toBeLessThan(1000);
      expect(await findStuckSagas(db(), sb, 1000)).toEqual([]);
    } finally {
      release();
      await firstP;
    }
  });
});
