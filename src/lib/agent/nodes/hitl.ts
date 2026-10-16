/**
 * N5 human-in-the-loop. `interrupt(card)` checkpoints the run in Postgres and ends the
 * request; a later request resumes it with the supervisor's decision via
 * Command({ resume }) — on any instance, after any delay. On resume LangGraph re-runs this
 * node from the top, so nothing with side effects happens before `interrupt` returns.
 * approve → tokens for the proposed amounts; modify → the gate re-checks the modified plan
 * (a supervisor can lower amounts or drop actions, never exceed what was paid);
 * reject → no tokens, the customer is told a specialist will follow up.
 */
import { interrupt } from "@langchain/langgraph";
import { runGate, type ActionDecision } from "@/lib/policy/gate";
import { formatCents } from "@/lib/util/money";
import type { Action } from "../schemas";
import { instrument, type NodeDeps } from "../deps";
import { gateInputFrom, mintTokensFor } from "./gate";
import type { ApprovalCard, ApprovalRecord, GraphState, HitlDecision } from "../state";

const EXECUTABLE = new Set(["refund", "store_credit", "replacement", "return_label", "escalate"]);

export function buildApprovalCard(state: GraphState): ApprovalCard {
  const gate = state.gate!;
  const ctx = state.context!;
  // Saga order: reversible changes first, the irreversible money movement last.
  const ORDER = ["escalate", "replacement", "return_label", "refund", "store_credit"];
  const live = gate.decisions
    .filter((d) => d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED")
    .sort((a, b) => ORDER.indexOf(a.action.type) - ORDER.indexOf(b.action.type));
  const diff: ApprovalCard["diff"] = [{ system: "Tickets", change: "Open a resolution ticket", reversible: true }];
  for (const d of live) {
    const a = d.action;
    if (a.type === "replacement") {
      const item = ctx.orders.find((o) => o.id === a.orderId)?.items.find((i) => i.sku === a.sku);
      diff.push({ system: "Orders", change: `Reserve and ship ${a.qty} × ${item?.name ?? a.sku} (${a.sku}) for ${a.orderId}`, amountCents: d.exposureCents, reversible: true });
    }
    if (a.type === "return_label") diff.push({ system: "Carrier A → B", change: `Create prepaid return label for ${a.orderId}`, reversible: true });
    if (a.type === "refund") diff.push({ system: "Billing", change: `Refund ${formatCents(a.amountCents)} to the original card for ${a.orderId} (${a.reason.replace(/_/g, " ")}) — PIVOT, cannot be undone`, amountCents: a.amountCents, reversible: false });
    if (a.type === "store_credit") diff.push({ system: "Billing", change: `Issue ${formatCents(a.amountCents)} store credit (${a.reason.replace(/_/g, " ")})`, amountCents: a.amountCents, reversible: false });
    if (a.type === "escalate") diff.push({ system: "Tickets", change: `Escalate to a specialist: ${a.reason}`, reversible: true });
  }
  const maxRefundableCents: Record<string, number> = {};
  for (const o of ctx.orders) maxRefundableCents[o.id] = o.paidCents - o.refundedCents;
  const cited = new Set(state.plan?.citedClauseIds ?? []);
  return {
    threadId: state.threadId,
    customer: {
      name: ctx.customer?.name ?? "Unknown",
      tier: ctx.customer?.tier ?? "standard",
      lifetimeValueCents: ctx.customer?.lifetimeValueCents ?? 0,
      openTickets: ctx.customer?.openTickets ?? 0,
      churnFlags: ctx.customer?.churnFlags ?? [],
    },
    complaint: state.triage?.summary ?? "",
    decisions: gate.decisions,
    diff,
    clauses: (state.policies ?? []).filter((p) => cited.has(p.clauseId)).map((p) => ({ citation: p.citation, text: p.text })),
    riskSignals: [
      ...(state.triage?.socialEngineeringSignals ?? []),
      ...(state.firewall?.outcome === "flag" ? [`firewall:${state.firewall.signals.map((x) => x.rule).join("+")}`] : []),
      ...(state.triage?.churnRisk === "high" ? ["churn_risk_high"] : []),
    ],
    humanReasons: gate.humanReasons,
    totalExposureCents: gate.totalExposureCents,
    autoLimitCents: gate.autoLimitCents,
    maxRefundableCents,
    rationale: state.plan?.rationale ?? "",
  };
}

/** Applies a supervisor's modification to the live (approvable) actions. */
export function applyModification(live: ActionDecision[], decision: HitlDecision): { actions: Action[]; dropped: Action[] } {
  const remove = new Set(decision.removeActions ?? []);
  const dropped: Action[] = [];
  const actions: Action[] = [];
  let amountApplied = false;
  for (const d of live) {
    if (remove.has(d.index)) {
      dropped.push(d.action);
      continue;
    }
    let a = d.action;
    if (decision.decision === "modify" && decision.amountCents !== undefined && !amountApplied && (a.type === "refund" || a.type === "store_credit")) {
      a = { ...a, amountCents: decision.amountCents };
      amountApplied = true;
    }
    actions.push(a);
  }
  return { actions, dropped };
}

export function makeHitlNode(deps: NodeDeps) {
  return instrument(
    "n5_hitl",
    deps,
    async (state: GraphState) => {
      const card = buildApprovalCard(state);
      const decision = interrupt<ApprovalCard, HitlDecision>(card);
      const at = new Date().toISOString();
      const original = state.gate!;
      const live = original.decisions.filter((d) => (d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED") && EXECUTABLE.has(d.action.type));

      if (decision.decision === "reject") {
        const approval: ApprovalRecord = { ...decision, by: deps.approver, at, finalActions: [], droppedActions: live.map((d) => ({ action: d.action, reasonCodes: ["REJECTED_BY_SUPERVISOR"] })) };
        return { approval, tokens: [] };
      }

      const { actions, dropped } = applyModification(live, decision);
      const regate = runGate(actions, gateInputFrom(state, deps, true));
      const approvedNow = regate.decisions.filter((d) => d.status === "AUTO_APPROVED" && EXECUTABLE.has(d.action.type));
      const deniedNow = regate.decisions.filter((d) => d.status === "DENIED");
      const merged = {
        ...regate,
        decisions: [...regate.decisions, ...original.decisions.filter((d) => d.status === "DENIED").map((d, i) => ({ ...d, index: 1_000 + i }))],
      };
      const tokens = await mintTokensFor(state, deps, { ...regate, decisions: approvedNow }, deps.approver);
      const approval: ApprovalRecord = {
        ...decision,
        by: deps.approver,
        at,
        finalActions: approvedNow.map((d) => d.action),
        droppedActions: [
          ...dropped.map((action) => ({ action, reasonCodes: ["REMOVED_BY_SUPERVISOR"] })),
          ...deniedNow.map((d) => ({ action: d.action, reasonCodes: d.reasonCodes })),
        ],
      };
      return { approval, gate: merged, tokens };
    },
    () => "CODE",
    (u) => ({ decision: u.approval?.decision, finalActions: u.approval?.finalActions.map((a) => a.type), tokens: u.tokens?.length }),
  );
}

export function afterHitl(state: GraphState): "execute" | "respond" {
  if (state.approval?.decision === "reject") return "respond";
  if (!state.approval?.finalActions.length) return "respond";
  return "execute";
}
