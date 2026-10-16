/**
 * N4b gate node: runs the deterministic policy gate and — only when every executable action
 * is AUTO_APPROVED — mints single-use approval tokens bound to each exact action.
 * Tokens go into state as IDs; the planner never sees them.
 */
import { AGENT } from "@/config/agent";
import { runGate, type GateInput, type GateResult } from "@/lib/policy/gate";
import { mintToken, type TokenAction } from "@/lib/security/approval-token";
import type { Action } from "../schemas";
import { instrument, type NodeDeps } from "../deps";
import type { ApprovalTokenRef, GraphState } from "../state";

export function gateInputFrom(state: GraphState, deps: Pick<NodeDeps, "autoLimitOverrideCents">, supervisorApproved = false): GateInput {
  const ctx = state.context!;
  return {
    claimDate: AGENT.businessDate,
    customer: { id: state.customerId, tier: ctx.customer?.tier ?? "standard" },
    churnRisk: state.triage?.churnRisk ?? "low",
    orders: ctx.orders,
    storeCredits: ctx.storeCredits.map((c) => ({ amountCents: c.amountCents, reason: c.reason, createdAt: c.createdAt })),
    inventory: ctx.inventory,
    evidenceAttached: state.evidenceAttached,
    firewallFlagged: state.firewall?.outcome === "flag",
    socialSignals: state.triage?.socialEngineeringSignals ?? [],
    supervisorApproved,
    autoLimitOverrideCents: deps.autoLimitOverrideCents,
  };
}

const TOKEN_ACTION: Partial<Record<Action["type"], TokenAction>> = {
  refund: "refund",
  store_credit: "store_credit",
  replacement: "replacement",
  return_label: "return_label",
};

/** Mints one token per AUTO_APPROVED, token-guarded action. */
export async function mintTokensFor(state: GraphState, deps: NodeDeps, gate: GateResult, approvedBy: string): Promise<ApprovalTokenRef[]> {
  const refs: ApprovalTokenRef[] = [];
  for (const d of gate.decisions) {
    if (d.status !== "AUTO_APPROVED") continue;
    const tokenAction = TOKEN_ACTION[d.action.type];
    if (!tokenAction) continue;
    const a = d.action;
    const { tokenId } = await mintToken(deps.db, {
      sandboxId: deps.sandboxId,
      threadId: state.threadId,
      action: tokenAction,
      orderId: "orderId" in a && a.orderId ? a.orderId : null,
      amountCents: "amountCents" in a ? a.amountCents : null,
      sku: a.type === "replacement" ? a.sku : null,
      qty: a.type === "replacement" ? a.qty : null,
      policyId: d.policy?.policyId ?? gate.approvalPolicy.policyId,
      policyVersion: d.policy?.version ?? gate.approvalPolicy.version,
      approvedBy,
    });
    refs.push({ tokenId, decisionIndex: d.index, action: d.action.type, approvedBy });
  }
  return refs;
}

export function makeGateNode(deps: NodeDeps) {
  return instrument(
    "n4b_gate",
    deps,
    async (state: GraphState) => {
      let gate = runGate(state.plan?.actions ?? [], gateInputFrom(state, deps));
      if (deps.ablation?.noGate) {
        // Ablation: the plan executes as proposed. Only for measuring what the gate prevents.
        const decisions = gate.decisions
          .filter((d) => !d.addedByGate)
          .map((d) => (["refund", "store_credit", "replacement", "return_label", "escalate"].includes(d.action.type) ? { ...d, status: "AUTO_APPROVED" as const, reasonCodes: ["ABLATION_NO_GATE"] } : d));
        gate = { ...gate, decisions, route: decisions.some((d) => d.status === "AUTO_APPROVED") ? "auto" : "deny", humanReasons: [] };
      }
      const tokens = gate.route === "auto" ? await mintTokensFor(state, deps, gate, "AUTO_GATE") : [];
      return { gate, tokens };
    },
    () => "CODE",
    (u) => ({
      route: u.gate?.route,
      decisions: u.gate?.decisions.map((d) => ({ action: d.action.type, status: d.status, reasons: d.reasonCodes })),
      exposureCents: u.gate?.totalExposureCents,
      limitCents: u.gate?.autoLimitCents,
      tokensMinted: u.tokens?.length,
    }),
  );
}

export function afterGate(state: GraphState): "hitl" | "execute" | "respond" {
  if (state.escalation) return "respond";
  if (state.gate?.route === "human") return "hitl";
  if (state.gate?.route === "auto") return "execute";
  return "respond";
}
