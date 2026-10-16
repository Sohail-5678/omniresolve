/**
 * Graph state for one conversation thread (checkpointed in Postgres after every node).
 * Approval tokens appear here only as IDs; token payloads and signatures live in the
 * approval_tokens table and never enter an LLM prompt.
 */
import { Annotation } from "@langchain/langgraph";
import type { FirewallResult } from "@/lib/security/firewall";
import type { GateOrder, GateResult } from "@/lib/policy/gate";
import type { RetrievedClause } from "@/lib/rag/retriever";
import type { SagaSummary } from "@/lib/saga/orchestrator";
import type { Action, ResolutionPlan, Triage } from "./schemas";
import type { LlmCallTrace } from "./structured";

export type TurnMessage = {
  role: "customer" | "agent";
  text: string;
  at: string;
  turnId: string;
  meta?: { verified?: boolean; usedTemplate?: boolean; attempts?: number; badge?: string; outcome?: string };
};

export type SourceStatus = "ok" | "retried" | "failed";

export type ContextOrder = GateOrder & {
  subtotalCents: number;
  daysSinceOrder: number;
  daysSinceDelivery: number | null;
  lateByDays: number | null;
  carrier: string | null;
  trackingNo: string | null;
  trackingStatus: string | null;
  trackingEvents: { at: string; code: string; description: string }[];
  daysSinceLastTrackingEvent: number | null;
};

export type CustomerContext = {
  businessDate: string;
  customer: {
    id: string;
    name: string;
    tier: "standard" | "gold" | "platinum";
    lifetimeValueCents: number;
    churnFlags: string[];
    openTickets: number;
    since: string;
  } | null;
  orders: ContextOrder[];
  storeCredits: { creditId: string; orderId: string | null; amountCents: number; reason: string; createdAt: string }[];
  inventory: Record<string, number>;
  sources: Record<"crm" | "orders" | "billing" | "carriers", SourceStatus>;
  sourceErrors: Record<string, string>;
  primaryOrderId: string | null;
};

export type FactActionStatus = "DONE" | "PENDING" | "DENIED" | "ROLLED_BACK" | "REJECTED" | "NOT_RUN" | "FAILED";

export type FactAction = {
  type: Action["type"];
  status: FactActionStatus;
  orderId?: string;
  amount?: string;
  amountCents?: number;
  id?: string;
  trackingNo?: string;
  carrier?: string;
  item?: string;
  reason?: string;
  why?: string;
};

export type FactOutcome =
  | "RESOLVED"
  | "ROLLED_BACK"
  | "PENDING_FULFILLMENT"
  | "COMPENSATION_FAILED"
  | "DENIED"
  | "REJECTED"
  | "ESCALATED"
  | "DELAYED"
  | "NEEDS_INFO"
  | "UNAVAILABLE"
  | "BLOCKED";

export type VerifiedFacts = {
  customerFirstName: string;
  outcome: FactOutcome;
  orders: { orderId: string; items: string[]; orderDate?: string; deliveredDate?: string | null }[];
  actions: FactAction[];
  ticket: { ticketId: string; status: string } | null;
  clauses: { id: string; version: string; title: string }[];
  policyNumbers: string[];
  nextStep: string | null;
  notes: string[];
};

export type ApprovalCard = {
  threadId: string;
  customer: { name: string; tier: string; lifetimeValueCents: number; openTickets: number; churnFlags: string[] };
  complaint: string;
  decisions: GateResult["decisions"];
  diff: { system: string; change: string; amountCents?: number; reversible: boolean }[];
  clauses: { citation: string; text: string }[];
  riskSignals: string[];
  humanReasons: string[];
  totalExposureCents: number;
  autoLimitCents: number;
  maxRefundableCents: Record<string, number>;
  rationale: string;
};

export type HitlDecision = {
  decision: "approve" | "modify" | "reject";
  amountCents?: number;
  removeActions?: number[];
  note?: string;
};

export type ApprovalRecord = HitlDecision & {
  by: string;
  at: string;
  finalActions: Action[];
  droppedActions: { action: Action; reasonCodes: string[] }[];
};

export type ApprovalTokenRef = { tokenId: string; decisionIndex: number; action: Action["type"]; approvedBy: string };

export type TraceEvent = {
  node: string;
  kind: "node" | "llm" | "service" | "gate" | "saga" | "guard" | "info";
  at: string;
  durationMs?: number;
  badge?: "LIVE" | "REPLAY" | "MOCK SERVICE" | "FAULT-INJECTED" | "CODE";
  data: Record<string, unknown>;
};

export type ReplyRecord = { text: string; verified: boolean; attempts: number; usedTemplate: boolean; problems: string[] };

export type TurnOutcome = "REPLIED" | "ASKED" | "AWAITING_APPROVAL" | "BLOCKED";

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_prev: T, next: T) => next, default: init });

export const ResolutionState = Annotation.Root({
  sandboxId: last<string>(() => ""),
  threadId: last<string>(() => ""),
  customerId: last<string>(() => ""),
  mode: last<"replay" | "live">(() => "replay"),
  turnId: last<string>(() => ""),
  evidenceAttached: last<boolean>(() => false),
  messages: Annotation<TurnMessage[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  firewall: last<FirewallResult | null>(() => null),
  triage: last<Triage | null>(() => null),
  context: last<CustomerContext | null>(() => null),
  policies: last<RetrievedClause[] | null>(() => null),
  retrievalMeta: last<{ queries: string[]; denseMode: string; timingMs: number; removedCount: number } | null>(() => null),
  plan: last<ResolutionPlan | null>(() => null),
  gate: last<GateResult | null>(() => null),
  approval: last<ApprovalRecord | null>(() => null),
  tokens: last<ApprovalTokenRef[]>(() => []),
  saga: last<SagaSummary | null>(() => null),
  facts: last<VerifiedFacts | null>(() => null),
  reply: last<ReplyRecord | null>(() => null),
  outcome: last<TurnOutcome | null>(() => null),
  escalation: last<{ reason: string; code: string; ticketId?: string } | null>(() => null),
  llmCalls: last<LlmCallTrace[]>(() => []),
  trace: last<TraceEvent[]>(() => []),
});

export type GraphState = typeof ResolutionState.State;
/** What a node returns: any subset of the state (LangGraph applies each field's reducer). */
export type GraphUpdate = Partial<GraphState>;
