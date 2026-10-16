/**
 * Saga integrity under faults (spec 9.3). No LLM: a fixed approved plan (refund + replacement
 * + return label, the full 8-step saga) runs through the real orchestrator in a fresh sandbox
 * per cell of a fault matrix — every operation × {503, 429, timeout, commit-then-timeout,
 * schema drift, fail-twice}, compensation failures, and crashes between steps (then recovery).
 * After each run the invariants are checked; any violation is reported, never hidden.
 * Usage: npx tsx scripts/eval-chaos.ts
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { and, eq } from "drizzle-orm";
import { getDb, getPool, type Db } from "@/db/client";
import * as s from "@/db/schema";
import { createSandbox } from "@/lib/security/sandbox";
import { mintToken } from "@/lib/security/approval-token";
import { setFault, type FaultMode, type ServiceName } from "@/lib/services/fault-injector";
import { runSaga, recoverSagas, type SagaSummary } from "@/lib/saga/orchestrator";
import type { SagaPlan } from "@/lib/saga/steps";
import type { Action } from "@/lib/agent/schemas";
import { SimulatedCrash } from "@/lib/util/errors";
import { rate, round, mean } from "@/lib/evals/stats";
import { writeResult } from "./lib/results";

type Cell = {
  id: string;
  faults: { service: ServiceName; operation: string; mode: FaultMode; n?: number }[];
  crashAfterSeq?: number;
  expected: string;
  group: string;
};

const PRE = [
  ["tickets", "create"],
  ["orders", "reserveInventory"],
  ["orders", "createReplacementDraft"],
] as const;
const POST = [
  ["orders", "confirmReplacement"],
  ["tickets", "addNote"],
  ["tickets", "close"],
  ["tickets", "notify"],
] as const;
const MODES: { mode: FaultMode; n?: number }[] = [{ mode: "fail_503" }, { mode: "rate_limit_429" }, { mode: "timeout" }, { mode: "commit_then_timeout" }, { mode: "schema_drift" }, { mode: "fail_n_times", n: 2 }];

function cells(): Cell[] {
  const out: Cell[] = [];
  for (const [service, operation] of PRE) {
    for (const m of MODES) {
      const ok = m.mode === "commit_then_timeout" || m.mode === "fail_n_times";
      out.push({ id: `${service}.${operation}:${m.mode}`, group: "pre-pivot", faults: [{ service, operation, ...m }], expected: ok ? "DONE" : "ROLLED_BACK" });
    }
  }
  for (const m of MODES) {
    out.push({ id: `carrier_a.createReturnLabel:${m.mode}`, group: "carrier", faults: [{ service: "carrier_a", operation: "createReturnLabel", ...m }], expected: "DONE" });
  }
  out.push({ id: "carrier_a+carrier_b.createReturnLabel:fail_503", group: "carrier", faults: [{ service: "carrier_a", operation: "createReturnLabel", mode: "fail_503" }, { service: "carrier_b", operation: "createReturnLabel", mode: "fail_503" }], expected: "ROLLED_BACK" });
  for (const m of MODES) {
    const expected = m.mode === "fail_503" || m.mode === "rate_limit_429" || m.mode === "timeout" ? "ROLLED_BACK" : "DONE";
    out.push({ id: `billing.refund:${m.mode}`, group: "pivot", faults: [{ service: "billing", operation: "refund", ...m }], expected });
  }
  for (const [service, operation] of POST) {
    for (const m of MODES) {
      const ok = m.mode === "commit_then_timeout" || m.mode === "fail_n_times";
      out.push({ id: `${service}.${operation}:${m.mode}`, group: "post-pivot", faults: [{ service, operation, ...m }], expected: ok ? "DONE" : "REFUNDED_PENDING_FULFILLMENT" });
    }
  }
  for (const [service, operation] of [["orders", "releaseInventory"], ["carrier_a", "voidLabel"], ["tickets", "cancel"], ["orders", "cancelDraft"]] as const) {
    out.push({
      id: `compensation:${service}.${operation}:fail_503`,
      group: "compensation",
      faults: [{ service: "orders", operation: "createReplacementDraft", mode: "fail_503" }, { service, operation, mode: "fail_503" }],
      expected: operation === "cancelDraft" ? "ROLLED_BACK" : "COMPENSATION_FAILED",
    });
  }
  for (let seq = 1; seq <= 7; seq++) out.push({ id: `crash-after-step-${seq}`, group: "crash", faults: [], crashAfterSeq: seq, expected: "DONE" });
  for (const [service, operation] of [...PRE, ["carrier_a", "createReturnLabel"], ["billing", "refund"], ...POST] as const) {
    out.push({ id: `crash_after:${service}.${operation}`, group: "crash", faults: [{ service: service as ServiceName, operation, mode: "crash_after" }], expected: "DONE" });
  }
  return out;
}

const ACTIONS: Action[] = [
  { type: "refund", orderId: "ORD-9941", amountCents: 32000, reason: "duplicate_charge" },
  { type: "replacement", orderId: "ORD-9941", sku: "GLS-AUR-01", qty: 1, reason: "damaged" },
  { type: "return_label", orderId: "ORD-9941", reason: "damaged" },
];

async function planFor(db: Db, sandboxId: string, threadId: string): Promise<SagaPlan> {
  const actions = [];
  for (const a of ACTIONS) {
    const { tokenId } = await mintToken(db, {
      sandboxId,
      threadId,
      action: a.type === "refund" ? "refund" : a.type === "replacement" ? "replacement" : "return_label",
      orderId: "ORD-9941",
      amountCents: a.type === "refund" ? a.amountCents : null,
      sku: a.type === "replacement" ? a.sku : null,
      qty: a.type === "replacement" ? a.qty : null,
      policyId: "DAMAGE_TRANSIT",
      policyVersion: "2026.1",
      approvedBy: "AUTO_GATE",
    });
    actions.push({ action: a, tokenId });
  }
  return { sandboxId, threadId, customerId: "CUS-1001", customerName: "Sarah Jenkins", primaryOrderId: "ORD-9941", actions, subject: "chaos eval" };
}

async function invariants(db: Db, sandboxId: string, saga: SagaSummary) {
  const v: string[] = [];
  const refunds = await db.select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sandboxId), eq(s.refunds.orderId, "ORD-9941")));
  const charges = await db.select().from(s.charges).where(and(eq(s.charges.sandboxId, sandboxId), eq(s.charges.orderId, "ORD-9941")));
  const sagaRefunds = refunds.filter((r) => r.sagaId === saga.sagaId);
  if (sagaRefunds.length > 1) v.push(`(a) ${sagaRefunds.length} refunds in one saga`);
  const paid = charges.reduce((x, c) => x + c.amountCents, 0);
  const refunded = refunds.reduce((x, r) => x + r.amountCents, 0);
  if (refunded > paid) v.push(`(b) refunded ${refunded} > paid ${paid}`);
  const holds = await db.select().from(s.inventoryHolds).where(and(eq(s.inventoryHolds.sandboxId, sandboxId), eq(s.inventoryHolds.sagaId, saga.sagaId)));
  const labels = await db.select().from(s.labels).where(and(eq(s.labels.sandboxId, sandboxId), eq(s.labels.sagaId, saga.sagaId)));
  const drafts = await db.select().from(s.replacementDrafts).where(and(eq(s.replacementDrafts.sandboxId, sandboxId), eq(s.replacementDrafts.sagaId, saga.sagaId)));
  const outbox = await db.select().from(s.outbox).where(and(eq(s.outbox.sandboxId, sandboxId), eq(s.outbox.sagaId, saga.sagaId)));
  const tickets = await db.select().from(s.tickets).where(and(eq(s.tickets.sandboxId, sandboxId), eq(s.tickets.sagaId, saga.sagaId)));
  if (saga.status === "ROLLED_BACK") {
    if (sagaRefunds.length) v.push("(c) refund exists after rollback");
    if (holds.some((h) => h.status === "held")) v.push("(c) inventory hold left after rollback");
    if (labels.some((l) => l.status === "active")) v.push("(c) active label left after rollback");
    if (drafts.some((d) => d.status === "draft" || d.status === "confirmed")) v.push("(c) replacement draft left after rollback");
    if (tickets.some((t) => t.status !== "ROLLED_BACK")) v.push(`(d) ticket ${tickets.map((t) => t.status).join(",")} after rollback`);
  }
  if (saga.status === "DONE") {
    if (sagaRefunds.length !== 1) v.push(`(a) DONE saga has ${sagaRefunds.length} refunds`);
    if (holds.some((h) => h.status === "held")) v.push("(c) hold still held after DONE");
    if (labels.filter((l) => l.status === "active").length !== 1) v.push(`(c) DONE saga has ${labels.filter((l) => l.status === "active").length} active labels`);
    if (!drafts.some((d) => d.status === "confirmed")) v.push("(c) DONE saga without a confirmed replacement");
    if (tickets.some((t) => t.status !== "RESOLVED")) v.push(`(d) ticket ${tickets.map((t) => t.status).join(",")} after DONE`);
  }
  if (saga.status === "REFUNDED_PENDING_FULFILLMENT") {
    if (sagaRefunds.length !== 1) v.push(`(a) pending-fulfilment saga has ${sagaRefunds.length} refunds`);
    if (!outbox.some((o) => o.kind === "needs_ops_followup")) v.push("(e) pending-fulfilment saga without a needs_ops_followup outbox row");
  }
  if (saga.status === "COMPENSATION_FAILED") {
    if (sagaRefunds.length) v.push("(c) refund exists after failed compensation (pivot should not have run)");
    if (!outbox.some((o) => o.kind === "compensation_failed")) v.push("(e) compensation failure without an outbox row");
  }
  if (["RUNNING", "COMPENSATING"].includes(saga.status)) v.push(`(e) saga left non-final: ${saga.status}`);
  const tokens = await db.select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sandboxId));
  for (const r of sagaRefunds) {
    const t = tokens.find((x) => x.tokenId === r.tokenId);
    if (!t || t.status !== "consumed") v.push("(f) refund without a consumed token");
  }
  return v;
}

async function main() {
  const db = getDb();
  const all = cells();
  const items: { id: string; group: string; expected: string; status: string; ticketStatus: string | null; asDesigned: boolean; crashed: boolean; recovered: boolean | null; retries: number; violations: string[]; ms: number }[] = [];
  for (const cell of all) {
    const t0 = Date.now();
    const { id: sandboxId } = await createSandbox(db, { ipHash: "eval-chaos" });
    const threadId = `thr_chaos_${Math.random().toString(36).slice(2, 10)}`;
    for (const f of cell.faults) await setFault(db, sandboxId, f.service, f.operation, f.mode, f.n);
    const plan = await planFor(db, sandboxId, threadId);
    const ctx = { db, sandboxId, sleep: async () => undefined, random: () => 0.5, crashAfterSeq: cell.crashAfterSeq };
    let summary: SagaSummary | null = null;
    let crashed = false;
    try {
      summary = await runSaga(ctx, plan);
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
      crashed = true;
    }
    let recovered: boolean | null = null;
    if (crashed) {
      const rec = await recoverSagas({ db, sandboxId, sleep: async () => undefined, random: () => 0.5 }, 0);
      summary = rec[0] ?? null;
      recovered = !!summary && !["RUNNING", "COMPENSATING"].includes(summary.status);
    }
    if (!summary) throw new Error(`no saga summary for ${cell.id}`);
    const violations = await invariants(db, sandboxId, summary);
    const retries = summary.steps.reduce((x, st) => x + Math.max(0, st.attempts - 1), 0);
    items.push({ id: cell.id, group: cell.group, expected: cell.expected, status: summary.status, ticketStatus: summary.ticketStatus, asDesigned: summary.status === cell.expected, crashed, recovered, retries, violations, ms: Date.now() - t0 });
    console.log(`${violations.length ? "✗" : summary.status === cell.expected ? "✓" : "≠"} ${cell.id.padEnd(52)} ${summary.status.padEnd(30)} retries=${retries}${violations.length ? `  VIOLATIONS: ${violations.join("; ")}` : ""}`);
  }
  const violationsTotal = items.reduce((x, i) => x + i.violations.length, 0);
  const crashes = items.filter((i) => i.crashed);
  const groups = [...new Set(items.map((i) => i.group))];
  writeResult({
    name: "chaos",
    title: "Saga integrity under faults",
    dataset: "fault matrix over the 8-step saga (refund + replacement + return label)",
    n: items.length,
    models: [],
    config: { retry: "3 attempts, base 100 ms, cap 2 s, jitter (sleeps stubbed in eval)", pivot: "billing.refund", modes: MODES.map((m) => m.mode) },
    metrics: {
      runs: items.length,
      integrityViolations: violationsTotal,
      runsWithViolations: items.filter((i) => i.violations.length).length,
      behavedAsDesigned: rate(items.filter((i) => i.asDesigned).length, items.length),
      crashRuns: crashes.length,
      recoveryRate: rate(crashes.filter((i) => i.recovered).length, crashes.length),
      avgRetriesPerRun: round(mean(items.map((i) => i.retries)), 2),
      rolledBack: items.filter((i) => i.status === "ROLLED_BACK").length,
      pendingFulfillment: items.filter((i) => i.status === "REFUNDED_PENDING_FULFILLMENT").length,
      compensationFailed: items.filter((i) => i.status === "COMPENSATION_FAILED").length,
      done: items.filter((i) => i.status === "DONE").length,
    },
    tables: [
      {
        title: "By fault group",
        columns: ["group", "runs", "as designed", "violations", "avg retries"],
        rows: groups.map((g) => {
          const xs = items.filter((i) => i.group === g);
          return [g, xs.length, `${xs.filter((i) => i.asDesigned).length}/${xs.length}`, xs.reduce((x, i) => x + i.violations.length, 0), round(mean(xs.map((i) => i.retries)), 2)];
        }),
      },
    ],
    notes: [
      "History: the first run (75 runs) had 0 violations but 74/75 cells as designed — when a pre-pivot step failed with a definite 503 and its compensation was also faulted, the saga was marked COMPENSATION_FAILED even though the failed call never committed. Fixed by compensating a failed step only when its outcome is unknown (timeout / schema drift); re-run recorded here.",
      "Invariants: (a) ≤1 refund per saga, (b) refunded ≤ paid, (c) no hold/label/draft left behind unless the saga completed, (d) ticket status matches the saga result, (e) every non-final outcome has an outbox record and no saga is left RUNNING, (f) every refund consumed a token.",
      "Mocks run in-process against Postgres; network partitions and real provider semantics are out of scope.",
    ],
    items,
  });
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
