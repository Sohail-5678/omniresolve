/**
 * Scenario oracle. Instead of hand-typing expected database rows, each eval scenario states
 * its policy-correct reference plan; the oracle runs that plan through the REAL gate, the
 * scenario's supervisor policy and the saga (with the scenario's faults) in a fresh sandbox,
 * and snapshots the resulting state. The agent's run is judged against that snapshot.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { createSandbox } from "@/lib/security/sandbox";
import { applyFixtureOverrides } from "@/lib/seed/template";
import type { FixtureSet } from "@/lib/seed/fixtures";
import { setFault, type FaultMode, type ServiceName } from "@/lib/services/fault-injector";
import { loadContext } from "@/lib/agent/context";
import { runGate, type GateInput, type GateResult } from "@/lib/policy/gate";
import { runFirewall } from "@/lib/security/firewall";
import { mintToken, type TokenAction } from "@/lib/security/approval-token";
import { runSaga } from "@/lib/saga/orchestrator";
import type { Action } from "@/lib/agent/schemas";
import type { CustomerContext } from "@/lib/agent/state";

export type EvalScenario = {
  id: string;
  category: string;
  title: string;
  persona: { style: string; patience: number; honesty: string };
  hiddenGoal: string;
  knownFacts: string[];
  openingMessage: string;
  customerId: string;
  fixtures: FixtureSet;
  faults: { service: ServiceName; operation: string; mode: FaultMode; n?: number }[];
  evidenceAttached: boolean;
  referencePlan: Action[];
  supervisorPolicy: { action: "approve" | "modify" | "reject"; amountCents?: number; removeTypes?: string[] };
  goldClauseIds: string[];
  maxTurns: number;
};

export type FinalState = {
  refunds: { orderId: string; amountCents: number }[];
  credits: { amountCents: number }[];
  replacements: { orderId: string; sku: string; status: string }[];
  labels: { orderId: string }[];
  ticketStatuses: string[];
};

export async function prepareSandbox(db: Db, sc: EvalScenario, opts: { faults: boolean }) {
  const { id: sandboxId } = await createSandbox(db, { ipHash: "eval" });
  if (sc.fixtures.customers?.length || sc.fixtures.orders?.length) await applyFixtureOverrides(db, sandboxId, sc.fixtures);
  if (opts.faults) for (const f of sc.faults) await setFault(db, sandboxId, f.service, f.operation, f.mode, f.n);
  return sandboxId;
}

export async function snapshotFinalState(db: Db, sandboxId: string, customerId: string): Promise<FinalState> {
  const orders = await db.select({ id: s.orders.id }).from(s.orders).where(and(eq(s.orders.sandboxId, sandboxId), eq(s.orders.customerId, customerId)));
  const ids = orders.map((o) => o.id);
  const none = !ids.length;
  const [refunds, credits, drafts, labels, tickets] = await Promise.all([
    none ? [] : db.select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sandboxId), inArray(s.refunds.orderId, ids), isNotNull(s.refunds.sagaId))),
    db.select().from(s.storeCredits).where(and(eq(s.storeCredits.sandboxId, sandboxId), eq(s.storeCredits.customerId, customerId), isNotNull(s.storeCredits.sagaId))),
    none ? [] : db.select().from(s.replacementDrafts).where(and(eq(s.replacementDrafts.sandboxId, sandboxId), inArray(s.replacementDrafts.orderId, ids))),
    none ? [] : db.select().from(s.labels).where(and(eq(s.labels.sandboxId, sandboxId), inArray(s.labels.orderId, ids), eq(s.labels.status, "active"))),
    db.select().from(s.tickets).where(and(eq(s.tickets.sandboxId, sandboxId), eq(s.tickets.customerId, customerId), isNotNull(s.tickets.sagaId))),
  ]);
  return {
    refunds: refunds.map((r) => ({ orderId: r.orderId, amountCents: r.amountCents })).sort((a, b) => a.orderId.localeCompare(b.orderId) || a.amountCents - b.amountCents),
    credits: credits.map((c) => ({ amountCents: c.amountCents })).sort((a, b) => a.amountCents - b.amountCents),
    replacements: drafts.filter((d) => d.status !== "cancelled").map((d) => ({ orderId: d.orderId, sku: d.sku, status: d.status })).sort((a, b) => a.orderId.localeCompare(b.orderId)),
    labels: labels.map((l) => ({ orderId: l.orderId })).sort((a, b) => a.orderId.localeCompare(b.orderId)),
    ticketStatuses: tickets.map((t) => t.status).sort(),
  };
}

/** Money and fulfilment must match exactly; ticket statuses are reported separately. */
export function sameFinalState(a: FinalState, b: FinalState): boolean {
  const k = (x: unknown) => JSON.stringify(x);
  return (
    k(a.refunds) === k(b.refunds) &&
    k(a.credits) === k(b.credits) &&
    k(a.replacements.map((r) => ({ orderId: r.orderId, sku: r.sku, status: r.status }))) === k(b.replacements.map((r) => ({ orderId: r.orderId, sku: r.sku, status: r.status }))) &&
    k(a.labels) === k(b.labels)
  );
}

export function gateInputFor(ctx: CustomerContext, sc: EvalScenario, signals: { churnRisk: "low" | "medium" | "high"; socialSignals: string[]; firewallFlagged: boolean }, supervisorApproved = false): GateInput {
  return {
    claimDate: AGENT.businessDate,
    customer: { id: sc.customerId, tier: ctx.customer?.tier ?? "standard" },
    churnRisk: signals.churnRisk,
    orders: ctx.orders,
    storeCredits: ctx.storeCredits.map((c) => ({ amountCents: c.amountCents, reason: c.reason, createdAt: c.createdAt })),
    inventory: ctx.inventory,
    evidenceAttached: sc.evidenceAttached,
    firewallFlagged: signals.firewallFlagged,
    socialSignals: signals.socialSignals,
    supervisorApproved,
  };
}

export function supervisorDecisionFor(sc: EvalScenario, gate: GateResult) {
  const live = gate.decisions.filter((d) => d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED");
  const removeActions = (sc.supervisorPolicy.removeTypes ?? []).flatMap((t) => live.filter((d) => d.action.type === t).map((d) => d.index));
  return { decision: sc.supervisorPolicy.action, amountCents: sc.supervisorPolicy.action === "modify" ? sc.supervisorPolicy.amountCents : undefined, removeActions: removeActions.length ? removeActions : undefined };
}

const TOKEN_ACTION: Partial<Record<Action["type"], TokenAction>> = { refund: "refund", store_credit: "store_credit", replacement: "replacement", return_label: "return_label" };

export type OracleResult = {
  route: GateResult["route"];
  needsHuman: boolean;
  decisions: { type: string; status: string; reasonCodes: string[] }[];
  finalState: FinalState;
  sagaStatus: string | null;
  sagaSteps: string[];
};

export async function runOracle(db: Db, sc: EvalScenario): Promise<OracleResult> {
  const sandboxId = await prepareSandbox(db, sc, { faults: false });
  const ctx = await loadContext({ db, sandboxId }, sc.customerId, AGENT.businessDate, []);
  const fw = runFirewall(sc.openingMessage);
  const signals = {
    churnRisk: sc.category === "vip_churn" ? ("high" as const) : ("low" as const),
    socialSignals: sc.category === "social_engineering" ? ["authority_claim"] : [],
    firewallFlagged: fw.outcome === "flag",
  };
  let gate = runGate(sc.referencePlan, gateInputFor(ctx, sc, signals));
  const route = gate.route;
  const needsHuman = route === "human";
  let approved: Action[] = [];
  if (route === "auto") {
    approved = gate.decisions.filter((d) => d.status === "AUTO_APPROVED").map((d) => d.action);
  } else if (route === "human" && sc.supervisorPolicy.action !== "reject") {
    const decision = supervisorDecisionFor(sc, gate);
    const live = gate.decisions.filter((d) => (d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED") && !(decision.removeActions ?? []).includes(d.index));
    let amountApplied = false;
    const actions = live.map((d) => {
      if (decision.amountCents !== undefined && !amountApplied && (d.action.type === "refund" || d.action.type === "store_credit")) {
        amountApplied = true;
        return { ...d.action, amountCents: decision.amountCents } as Action;
      }
      return d.action;
    });
    gate = runGate(actions, gateInputFor(ctx, sc, signals, true));
    approved = gate.decisions.filter((d) => d.status === "AUTO_APPROVED").map((d) => d.action);
  }
  const executable = approved.filter((a) => ["refund", "store_credit", "replacement", "return_label", "escalate"].includes(a.type));
  let sagaStatus: string | null = null;
  let sagaSteps: string[] = [];
  if (executable.length) {
    for (const f of sc.faults) await setFault(db, sandboxId, f.service, f.operation, f.mode, f.n);
    const threadId = `thr_oracle_${sc.id}`;
    const actions = [];
    for (const a of executable) {
      const ta = TOKEN_ACTION[a.type];
      let tokenId: string | null = null;
      if (ta) {
        tokenId = (
          await mintToken(db, {
            sandboxId,
            threadId,
            action: ta,
            orderId: "orderId" in a && a.orderId ? a.orderId : null,
            amountCents: "amountCents" in a ? a.amountCents : null,
            sku: a.type === "replacement" ? a.sku : null,
            qty: a.type === "replacement" ? a.qty : null,
            policyId: "ORACLE",
            policyVersion: "oracle",
            approvedBy: "ORACLE",
          })
        ).tokenId;
      }
      actions.push({ action: a, tokenId });
    }
    const primary = executable.map((a) => ("orderId" in a ? a.orderId : undefined)).find(Boolean) ?? null;
    const saga = await runSaga(
      { db, sandboxId, sleep: async () => undefined, random: () => 0.5 },
      { sandboxId, threadId, customerId: sc.customerId, customerName: ctx.customer?.name ?? "Customer", primaryOrderId: primary ?? null, actions, subject: `oracle ${sc.id}` },
    );
    sagaStatus = saga.status;
    sagaSteps = saga.steps.filter((st) => st.status === "DONE").map((st) => st.name);
  }
  return {
    route,
    needsHuman,
    decisions: gate.decisions.map((d) => ({ type: d.action.type, status: d.status, reasonCodes: d.reasonCodes })),
    finalState: await snapshotFinalState(db, sandboxId, sc.customerId),
    sagaStatus,
    sagaSteps,
  };
}
