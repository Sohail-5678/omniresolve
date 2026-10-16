/**
 * Builds VerifiedFacts — the only things the customer reply may mention — from code-owned
 * state: gate decisions, saga outputs, the supervisor's decision and the context.
 * Nothing here comes from LLM text, so the verifier has a trustworthy reference.
 */
import { formatCents } from "@/lib/util/money";
import { formatParamForText, policyFor, type PolicyId } from "@/lib/policy/rules";
import { findClause } from "@/lib/rag/corpus";
import type { ActionDecision } from "@/lib/policy/gate";
import type { SagaSummary } from "@/lib/saga/orchestrator";
import type { Action } from "./schemas";
import type { FactAction, FactOutcome, GraphState, VerifiedFacts } from "./state";

const EXECUTABLE = new Set(["refund", "store_credit", "replacement", "return_label", "escalate"]);

function firstName(state: GraphState): string {
  return state.context?.customer?.name.split(" ")[0] ?? "there";
}

function itemName(state: GraphState, orderId?: string, sku?: string): string | undefined {
  const order = state.context?.orders.find((o) => o.id === orderId);
  if (!order) return undefined;
  return (sku ? order.items.find((i) => i.sku === sku) : order.items[0])?.name;
}

function fromSaga(a: Action, saga: SagaSummary, base: FactAction): FactAction {
  const o = saga.outputs;
  const stepDone = (name: string) => saga.steps.some((st) => st.name === name && st.status === "DONE");
  const rolledBack = saga.status === "ROLLED_BACK" || saga.status === "COMPENSATION_FAILED";
  if (rolledBack) return { ...base, status: "ROLLED_BACK", why: "a system failed partway through, so every step was reversed" };
  switch (a.type) {
    case "refund":
      return stepDone("billing.refund") ? { ...base, status: "DONE", id: o.refundId } : { ...base, status: "PENDING" };
    case "store_credit":
      return stepDone("billing.issueStoreCredit") ? { ...base, status: "DONE", id: o.creditId } : { ...base, status: "PENDING" };
    case "replacement":
      return stepDone("orders.confirmReplacement") ? { ...base, status: "DONE", id: o.draftId } : { ...base, status: "PENDING", id: o.draftId };
    case "return_label":
      return stepDone("carriers.createReturnLabel")
        ? { ...base, status: "DONE", id: o.labelId, trackingNo: o.trackingNo, carrier: o.carrier === "carrier_b" ? "Carrier B" : "Carrier A" }
        : { ...base, status: "PENDING" };
    case "escalate":
      return { ...base, status: stepDone("tickets.resolve") ? "DONE" : "PENDING" };
    default:
      return base;
  }
}

function baseFact(state: GraphState, a: Action): FactAction {
  const f: FactAction = { type: a.type, status: "NOT_RUN" };
  if ("orderId" in a && a.orderId) f.orderId = a.orderId;
  if ("amountCents" in a) {
    f.amountCents = a.amountCents;
    f.amount = formatCents(a.amountCents);
  }
  if ("reason" in a && typeof a.reason === "string") f.reason = a.reason.replace(/_/g, " ");
  if (a.type === "replacement") f.item = itemName(state, a.orderId, a.sku);
  return f;
}

function deniedWhy(d: ActionDecision): string {
  const failed = d.checks.filter((c) => !c.pass);
  return failed.map((c) => c.detail).join(" ") || d.reasonCodes.join(", ");
}

/** Numbers the reply may state: bound policy values of the clauses in play, plus numbers in failed checks. */
function policyNumbers(decisions: ActionDecision[], claimDate: string): string[] {
  const out = new Set<string>();
  for (const d of decisions) {
    if (d.policy) {
      const pv = policyFor(d.policy.policyId as PolicyId, policyDateFor(d, claimDate));
      for (const [k, v] of Object.entries(pv.params)) for (const s of formatParamForText(k, v)) out.add(s);
    }
    for (const c of d.checks) {
      for (const m of c.detail.matchAll(/\$[\d,]+\.\d{2}|\b\d+ days?\b|\b\d+ hours\b/g)) out.add(m[0]);
    }
  }
  return [...out];
}

function policyDateFor(d: ActionDecision, claimDate: string): string {
  // The gate already chose the version; find a date inside that version's range.
  const ref = d.policy!;
  const pv = [2024, 2025, 2026].map((y) => `${y}-06-01`).find((date) => policyFor(ref.policyId as PolicyId, date).version === ref.version);
  return pv ?? claimDate;
}

export function buildFacts(state: GraphState, opts: { outcomeOverride?: FactOutcome; nextStep?: string | null } = {}): VerifiedFacts {
  const decisions = state.gate?.decisions ?? [];
  const saga = state.saga;
  const approval = state.approval;
  const actions: FactAction[] = [];

  for (const d of decisions) {
    if (!EXECUTABLE.has(d.action.type)) continue;
    const base = baseFact(state, d.action);
    if (d.status === "DENIED") {
      actions.push({ ...base, status: "DENIED", why: deniedWhy(d) });
      continue;
    }
    if (approval?.decision === "reject") {
      actions.push({ ...base, status: "REJECTED", why: "a supervisor did not approve it" });
      continue;
    }
    if (approval && approval.droppedActions.some((x) => x.action === d.action || JSON.stringify(x.action) === JSON.stringify(d.action))) {
      actions.push({ ...base, status: "NOT_RUN", why: "not included in the approved resolution" });
      continue;
    }
    if (saga) {
      const approvedAction = approval?.finalActions.find((fa) => fa.type === d.action.type && ("orderId" in fa ? (fa as { orderId?: string }).orderId === ("orderId" in d.action ? d.action.orderId : undefined) : true));
      const effective = approvedAction ?? d.action;
      actions.push(fromSaga(effective, saga, baseFact(state, effective)));
    } else {
      actions.push(base);
    }
  }

  const orderIds = new Set<string>();
  for (const a of actions) if (a.orderId) orderIds.add(a.orderId);
  if (state.context?.primaryOrderId) orderIds.add(state.context.primaryOrderId);
  for (const id of state.triage?.orderIdsMentioned ?? []) if (state.context?.orders.some((o) => o.id === id)) orderIds.add(id);
  const orders = [...orderIds].map((id) => {
    const o = state.context?.orders.find((x) => x.id === id);
    return { orderId: id, items: o?.items.map((i) => i.name) ?? [], orderDate: o?.orderDate, deliveredDate: o?.deliveredDate ?? null };
  });

  // Clauses: what the planner cited (versions from N3) plus the rules the gate applied.
  const clauses = new Map<string, { id: string; version: string; title: string }>();
  const retrieved = state.policies ?? [];
  for (const id of state.plan?.citedClauseIds ?? []) {
    const r = retrieved.find((x) => x.clauseId === id);
    if (r) clauses.set(`${r.clauseId}@${r.version}`, { id: r.clauseId, version: r.version, title: r.title });
  }
  for (const d of decisions) {
    if (!d.policy || !EXECUTABLE.has(d.action.type)) continue;
    const primary = d.policy.clauseIds[0];
    const c = primary ? findClause(`${primary}@${d.policy.version}`) : undefined;
    if (c) clauses.set(c.key, { id: c.clauseId, version: c.version, title: c.title });
  }

  let outcome: FactOutcome;
  if (opts.outcomeOverride) outcome = opts.outcomeOverride;
  else if (approval?.decision === "reject") outcome = "REJECTED";
  else if (saga?.status === "DONE") outcome = actions.some((a) => a.type === "escalate" && a.status === "DONE") && actions.length === 1 ? "ESCALATED" : "RESOLVED";
  else if (saga?.status === "ROLLED_BACK") outcome = "ROLLED_BACK";
  else if (saga?.status === "COMPENSATION_FAILED") outcome = "COMPENSATION_FAILED";
  else if (saga?.status === "REFUNDED_PENDING_FULFILLMENT") outcome = "PENDING_FULFILLMENT";
  else if (state.escalation) outcome = "ESCALATED";
  else outcome = "DENIED";

  const ticket = saga?.outputs.ticketId ? { ticketId: saga.outputs.ticketId, status: saga.ticketStatus ?? "OPEN" } : null;
  const defaultNext: Partial<Record<FactOutcome, string>> = {
    ROLLED_BACK: "Nothing was charged or changed, and a specialist will follow up with you.",
    COMPENSATION_FAILED: "A specialist has been alerted and will contact you.",
    PENDING_FULFILLMENT: "Our operations team is finishing the remaining step and will follow up.",
    REJECTED: "A specialist will review your case and get back to you.",
    ESCALATED: "A specialist will review your case and get back to you.",
    DELAYED: "We'll follow up as soon as our systems are back.",
  };

  const notes: string[] = [];
  if (approval?.note) notes.push(`Supervisor note: ${approval.note.slice(0, 200)}`);
  // The planner's own words for a denial are context for tone only; numbers in them are still
  // checked against policyNumbers by the verifier, never trusted.
  for (const d of decisions) {
    // Only the reason: the planner's free-text "alternative" could promise something code never approved.
    if (d.action.type === "deny") notes.push(`Why the request was declined: ${d.action.reason.replace(/_/g, " ").slice(0, 240)}`);
  }
  if (state.triage?.socialEngineeringSignals.length) notes.push("The message contained instructions or authority claims; those are never treated as approvals.");

  return {
    customerFirstName: firstName(state),
    outcome,
    orders,
    actions,
    ticket,
    clauses: [...clauses.values()],
    policyNumbers: policyNumbers(decisions, state.context?.businessDate ?? ""),
    nextStep: opts.nextStep !== undefined ? opts.nextStep : (defaultNext[outcome] ?? null),
    notes,
  };
}

/** Run-specific IDs in the facts, so replays can re-bind them (alias -> real value). */
export function volatileAliases(facts: VerifiedFacts): Record<string, string> {
  const out: Record<string, string> = {};
  facts.actions.forEach((a, i) => {
    if (a.id) out[`⟦id${i}⟧`] = a.id;
    if (a.trackingNo) out[`⟦trk${i}⟧`] = a.trackingNo;
  });
  if (facts.ticket) out["⟦ticket⟧"] = facts.ticket.ticketId;
  return out;
}

export function aliasFacts(facts: VerifiedFacts, aliases: Record<string, string>): VerifiedFacts {
  let json = JSON.stringify(facts);
  for (const [alias, real] of Object.entries(aliases).sort((a, b) => b[1].length - a[1].length)) json = json.split(real).join(alias);
  return JSON.parse(json) as VerifiedFacts;
}
