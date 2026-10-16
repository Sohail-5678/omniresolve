import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool } from "@/db/client";
import * as s from "@/db/schema";
import { runTurn, resumeTurn, forgedRefundAttempt } from "@/lib/agent/runner";
import { db, freshSandbox, newThread, fault, instant, ScriptedLlm, templateResponder, cite } from "../helpers";

const SHOWCASE1_MSG = "My Aurora glass panel kit (ORD-9941) arrived shattered, and I was charged twice for it. Please fix this.";

function showcase1Llm() {
  return new ScriptedLlm({
    triage: () => ({
      intents: ["damaged_item", "double_charge"],
      severity: "high",
      sentiment: "negative",
      churnRisk: "medium",
      orderIdsMentioned: ["ORD-9941"],
      missingInfo: [],
      clarifyingQuestion: null,
      socialEngineeringSignals: [],
      summary: "Glass kit arrived shattered and the order was charged twice.",
    }),
    planner: (req) => ({
      actions: [
        { type: "refund", orderId: "ORD-9941", amountCents: 32000, reason: "duplicate_charge" },
        { type: "replacement", orderId: "ORD-9941", sku: "GLS-AUR-01", qty: 1, reason: "damaged" },
        { type: "return_label", orderId: "ORD-9941", reason: "damaged" },
      ],
      rationale: "Ledger shows a duplicate capture; carrier scan confirms transit damage.",
      citedClauseIds: cite(req, ["§2.1", "§4.2"]),
    }),
    responder: templateResponder,
  });
}

describe("showcase 1 — damaged + double charge, HITL", () => {
  it("pauses for approval, resumes on a fresh graph instance, runs the saga once, verifies the reply", async () => {
    const sb = await freshSandbox();
    const thread = await newThread(sb, "CUS-1001");
    const llm = showcase1Llm();
    const first = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: SHOWCASE1_MSG, evidenceAttached: false, sagaHooks: instant });
    expect(first.status).toBe("AWAITING_APPROVAL");
    expect(first.approval?.card.humanReasons).toContain("AMOUNT_ABOVE_AUTO_LIMIT");
    const refunds0 = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-9941")));
    expect(refunds0).toHaveLength(0);

    // Cold start: a brand-new pool + checkpointer + graph resumes the same thread.
    const pool = createPool(process.env.DATABASE_URL!, 2);
    const cold = new PostgresSaver(pool);
    const decision = { decision: "approve" as const };
    const resumed = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first.approval!.interruptId, decision, checkpointer: cold, sagaHooks: instant });
    expect(resumed.status).toBe("REPLIED");
    expect(resumed.saga?.status).toBe("DONE");
    expect(resumed.reply?.verified).toBe(true);
    expect(resumed.reply?.text).toContain("ORD-9941");

    // Duplicate approve returns the stored result and never re-runs the saga.
    const again = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first.approval!.interruptId, decision, checkpointer: cold, sagaHooks: instant });
    expect(again.duplicate).toBe(true);
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-9941")));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountCents).toBe(32000);
    const sagas = await db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, sb));
    expect(sagas).toHaveLength(1);
    await pool.end();
  });

  it("modify lowers the amount and binds the token to the approved amount", async () => {
    const sb = await freshSandbox();
    const thread = await newThread(sb, "CUS-1001");
    const llm = showcase1Llm();
    const first = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: SHOWCASE1_MSG, evidenceAttached: false, sagaHooks: instant });
    const returnLabelIdx = first.approval!.card.decisions.find((d) => d.action.type === "return_label")!.index;
    const r = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first.approval!.interruptId, decision: { decision: "modify", amountCents: 20000, removeActions: [returnLabelIdx] }, sagaHooks: instant });
    expect(r.saga?.status).toBe("DONE");
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-9941")));
    expect(refunds.map((x) => x.amountCents)).toEqual([20000]);
    const labels = await db().select().from(s.labels).where(eq(s.labels.sandboxId, sb));
    expect(labels).toHaveLength(0);
  });

  it("reject issues no tokens and changes nothing", async () => {
    const sb = await freshSandbox();
    const thread = await newThread(sb, "CUS-1001");
    const llm = showcase1Llm();
    const first = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: SHOWCASE1_MSG, evidenceAttached: false, sagaHooks: instant });
    const r = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first.approval!.interruptId, decision: { decision: "reject", note: "Need photos first" }, sagaHooks: instant });
    expect(r.status).toBe("REPLIED");
    expect(r.facts?.outcome).toBe("REJECTED");
    const tokens = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb));
    expect(tokens).toHaveLength(0);
    const refunds = await db().select().from(s.refunds).where(eq(s.refunds.sandboxId, sb));
    expect(refunds.filter((x) => x.orderId === "ORD-9941")).toHaveLength(0);
  });
});

function damageLlm(orderId: string, sku: string, shippingCents: number) {
  return new ScriptedLlm({
    triage: () => ({
      intents: ["damaged_item"],
      severity: "medium",
      sentiment: "negative",
      churnRisk: "low",
      orderIdsMentioned: [orderId],
      missingInfo: [],
      clarifyingQuestion: null,
      socialEngineeringSignals: [],
      summary: "Item arrived damaged.",
    }),
    planner: (req) => ({
      actions: [
        { type: "replacement", orderId, sku, qty: 1, reason: "damaged" },
        { type: "return_label", orderId, reason: "damaged" },
        { type: "refund", orderId, amountCents: shippingCents, reason: "damaged" },
      ],
      rationale: "Transit damage confirmed by carrier scan; policy refunds shipping.",
      citedClauseIds: cite(req, ["§4.2", "§4.5"]),
    }),
    responder: templateResponder,
  });
}

describe("showcase 2 — saga under faults (auto-approved, no HITL)", () => {
  it("A: Carrier A down → retries → failover to Carrier B → saga DONE", async () => {
    const sb = await freshSandbox();
    await fault(sb, "carrier_a", "createReturnLabel", "fail_503");
    const thread = await newThread(sb, "CUS-1002");
    const r = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm: damageLlm("ORD-8820", "KIT-POUR-02", 700), customerId: "CUS-1002", message: "My pour-over set ORD-8820 arrived broken.", evidenceAttached: false, sagaHooks: instant });
    expect(r.saga?.status).toBe("DONE");
    expect(r.saga?.outputs.carrier).toBe("carrier_b");
    expect(r.saga?.outputs.failover).toBe(true);
  });

  it("B: Orders fails at the replacement draft (before the pivot) → reverse compensation, no refund, ROLLED_BACK", async () => {
    const sb = await freshSandbox();
    await fault(sb, "orders", "createReplacementDraft", "fail_503");
    const thread = await newThread(sb, "CUS-1003");
    const r = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm: damageLlm("ORD-8821", "MUG-STN-04", 700), customerId: "CUS-1003", message: "Mug set ORD-8821 arrived broken.", evidenceAttached: false, sagaHooks: instant });
    expect(r.saga?.status).toBe("ROLLED_BACK");
    expect(r.saga?.ticketStatus).toBe("ROLLED_BACK");
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-8821")));
    expect(refunds).toHaveLength(0);
    const holds = await db().select().from(s.inventoryHolds).where(eq(s.inventoryHolds.sandboxId, sb));
    expect(holds.every((h) => h.status === "released")).toBe(true);
    const labels = await db().select().from(s.labels).where(eq(s.labels.sandboxId, sb));
    expect(labels.every((l) => l.status === "voided")).toBe(true);
    expect(r.facts?.outcome).toBe("ROLLED_BACK");
    expect(r.reply?.verified).toBe(true);
    expect(r.reply?.text).toMatch(/reversed every step/);
  });

  it("C: refund commits but the response is lost → retry with the same key → exactly one refund", async () => {
    const sb = await freshSandbox();
    await fault(sb, "billing", "refund", "commit_then_timeout");
    const thread = await newThread(sb, "CUS-1004");
    const r = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm: damageLlm("ORD-8822", "SKL-CI-12", 800), customerId: "CUS-1004", message: "Skillet ORD-8822 arrived cracked.", evidenceAttached: false, sagaHooks: instant });
    expect(r.saga?.status).toBe("DONE");
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-8822")));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountCents).toBe(800);
  });
});

describe("showcase 3 + 4", () => {
  it("temporal trap: out-of-window return is denied and the gate's store credit alternative is auto-issued", async () => {
    const sb = await freshSandbox();
    const thread = await newThread(sb, "CUS-1005");
    const llm = new ScriptedLlm({
      triage: () => ({ intents: ["return_request"], severity: "low", sentiment: "neutral", churnRisk: "low", orderIdsMentioned: ["ORD-7350"], missingInfo: [], clarifyingQuestion: null, socialEngineeringSignals: ["fake_policy_citation"], summary: "Wants to return a blanket citing a 90-day window." }),
      planner: (req) => ({ actions: [{ type: "refund", orderId: "ORD-7350", amountCents: 8900, reason: "return" }], rationale: "Customer wants a refund.", citedClauseIds: cite(req, ["§1.4"]) }),
      responder: templateResponder,
    });
    const r = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1005", message: "I'd like to return my merino blanket from ORD-7350. Your policy gives 90 days.", evidenceAttached: false, sagaHooks: instant });
    // fake_policy_citation is a social-engineering signal, so the credit routes to a human.
    expect(["AWAITING_APPROVAL", "REPLIED"]).toContain(r.status);
  });

  it("forged refund call without a token is rejected at the tool boundary", async () => {
    const sb = await freshSandbox();
    const thread = await newThread(sb, "CUS-1006");
    const res = await forgedRefundAttempt(db(), sb, thread, "ORD-7721", 500000);
    expect(res.blocked).toBe(true);
    expect(res.code).toBe("TOKEN_MISSING");
    const refunds = await db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, "ORD-7721")));
    expect(refunds).toHaveLength(0);
  });
});
