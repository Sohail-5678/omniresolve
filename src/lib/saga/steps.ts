/**
 * Turns an approved plan into ordered saga steps. The irreversible step (the PIVOT) runs
 * only after every reversible step has succeeded: a refund can't truly be undone
 * (reversing it means charging the customer again), so it goes last among the main steps.
 *   reversible:  tickets.create → orders.reserveInventory → carriers.createReturnLabel → orders.createReplacementDraft
 *   pivot:       billing.refund (else billing.issueStoreCredit, else orders.confirmReplacement)
 *   retriable:   later money step → orders.confirmReplacement → tickets.resolve → tickets.notify
 */
import type { Action } from "@/lib/agent/schemas";

export type StepKind = "reversible" | "pivot" | "retriable";

export type StepName =
  | "tickets.create"
  | "orders.reserveInventory"
  | "carriers.createReturnLabel"
  | "orders.createReplacementDraft"
  | "billing.refund"
  | "billing.issueStoreCredit"
  | "orders.confirmReplacement"
  | "tickets.resolve"
  | "tickets.notify";

export type ApprovedAction = { action: Action; tokenId: string | null };

export type SagaPlan = {
  sandboxId: string;
  threadId: string;
  customerId: string;
  customerName: string;
  primaryOrderId: string | null;
  actions: ApprovedAction[];
  subject: string;
};

export type StepDef = {
  seq: number;
  name: StepName;
  kind: StepKind;
  args: Record<string, unknown>;
  tokenId: string | null;
};

export function buildSteps(plan: SagaPlan): StepDef[] {
  const find = <T extends Action["type"]>(type: T) =>
    plan.actions.find((a) => a.action.type === type) as (ApprovedAction & { action: Extract<Action, { type: T }> }) | undefined;
  const repl = find("replacement");
  const label = find("return_label");
  const refund = find("refund");
  const credit = find("store_credit");
  const escalate = find("escalate");

  const steps: Omit<StepDef, "seq">[] = [];
  steps.push({
    name: "tickets.create",
    kind: "reversible",
    args: { customerId: plan.customerId, orderId: plan.primaryOrderId, subject: plan.subject },
    tokenId: null,
  });
  if (repl) {
    steps.push({ name: "orders.reserveInventory", kind: "reversible", args: { orderId: repl.action.orderId, sku: repl.action.sku, qty: repl.action.qty }, tokenId: repl.tokenId });
  }
  if (label) {
    steps.push({ name: "carriers.createReturnLabel", kind: "reversible", args: { orderId: label.action.orderId }, tokenId: label.tokenId });
  }
  if (repl) {
    steps.push({ name: "orders.createReplacementDraft", kind: "reversible", args: { orderId: repl.action.orderId, sku: repl.action.sku, qty: repl.action.qty }, tokenId: repl.tokenId });
  }

  let pivotTaken = false;
  if (refund) {
    steps.push({
      name: "billing.refund",
      kind: "pivot",
      args: { orderId: refund.action.orderId, amountCents: refund.action.amountCents, reason: refund.action.reason },
      tokenId: refund.tokenId,
    });
    pivotTaken = true;
  }
  if (credit) {
    steps.push({
      name: "billing.issueStoreCredit",
      kind: pivotTaken ? "retriable" : "pivot",
      args: { customerId: plan.customerId, orderId: credit.action.orderId ?? null, amountCents: credit.action.amountCents, reason: credit.action.reason },
      tokenId: credit.tokenId,
    });
    pivotTaken = true;
  }
  if (repl) {
    steps.push({ name: "orders.confirmReplacement", kind: pivotTaken ? "retriable" : "pivot", args: { orderId: repl.action.orderId }, tokenId: null });
    pivotTaken = true;
  }
  steps.push({ name: "tickets.resolve", kind: "retriable", args: { escalated: !!escalate, escalationReason: escalate?.action.reason ?? null }, tokenId: null });
  steps.push({ name: "tickets.notify", kind: "retriable", args: {}, tokenId: null });

  return steps.map((s, i) => ({ ...s, seq: i + 1 }));
}

export const COMPENSATION_OF: Partial<Record<StepName, string>> = {
  "tickets.create": "tickets.cancel",
  "orders.reserveInventory": "orders.releaseInventory",
  "carriers.createReturnLabel": "carriers.voidLabel",
  "orders.createReplacementDraft": "orders.cancelDraft",
};

export const STEP_LABEL: Record<StepName, string> = {
  "tickets.create": "Open ticket",
  "orders.reserveInventory": "Reserve inventory",
  "carriers.createReturnLabel": "Create return label",
  "orders.createReplacementDraft": "Draft replacement",
  "billing.refund": "Issue refund",
  "billing.issueStoreCredit": "Issue store credit",
  "orders.confirmReplacement": "Confirm replacement",
  "tickets.resolve": "Close ticket",
  "tickets.notify": "Notification preview",
};
