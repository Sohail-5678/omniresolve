/**
 * Console state: one reducer fed by the SSE event stream (node starts/ends, LLM calls,
 * mock-service calls, saga steps, interrupts, results). Pure, so the whole UI is a function
 * of the events the server actually emitted.
 */
import type { ApprovalCard, VerifiedFacts } from "@/lib/agent/state";

export type NodeId = "n1_triage" | "ask" | "n2_context" | "n3_retrieve" | "n4a_plan" | "n4b_gate" | "n5_hitl" | "n6_execute" | "n7_respond";
export type NodeStatus = "idle" | "active" | "done" | "waiting" | "error";
export type NodeView = { status: NodeStatus; durationMs?: number; badge?: string; summary?: Record<string, unknown>; at?: string };

export type LlmCallView = { node: string; model: string; badge: string; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number; ok: boolean; attempt: number; issues?: string[] };
export type ServiceCallView = { service: string; operation: string; ok: boolean; status?: number; error?: string; faultInjected: boolean; durationMs: number; replayed?: boolean };
export type SagaStepView = { seq: number; name: string; kind: string; status: string; attempt?: number; message?: string; carrier?: string; faultInjected?: boolean };

export type ChatItem =
  | { kind: "brief"; id: string; scenarioId: string }
  | { kind: "customer"; id: string; text: string; at: string }
  | {
      kind: "agent";
      id: string;
      text: string;
      at: string;
      verified: boolean;
      usedTemplate: boolean;
      attempts: number;
      badge: string;
      outcome: string | null;
      facts: VerifiedFacts | null;
      services: ServiceCallView[];
      llm: LlmCallView[];
      sagaStatus?: string | null;
    }
  | { kind: "system"; id: string; tone: "info" | "warn" | "bad" | "ok"; text: string }
  | { kind: "guard"; id: string; code: string; message: string };

export type Fault = { service: string; operation: string; mode: string; n: number | null; calls: number; expiresAt: string };

export type ConsoleState = {
  threadId: string | null;
  customerId: string;
  scenarioId: string | null;
  chat: ChatItem[];
  nodes: Record<NodeId, NodeView>;
  activeNode: NodeId | null;
  llm: LlmCallView[];
  services: ServiceCallView[];
  turnServices: ServiceCallView[];
  turnLlm: LlmCallView[];
  sagaId: string | null;
  sagaSteps: SagaStepView[];
  sagaStatus: string | null;
  ticketStatus: string | null;
  approval: { interruptId: string; card: ApprovalCard } | null;
  busy: boolean;
  crashed: boolean;
  refreshKey: number;
  modeNote: string | null;
};

export const NODE_IDS: NodeId[] = ["n1_triage", "ask", "n2_context", "n3_retrieve", "n4a_plan", "n4b_gate", "n5_hitl", "n6_execute", "n7_respond"];

const blankNodes = (): Record<NodeId, NodeView> => Object.fromEntries(NODE_IDS.map((n) => [n, { status: "idle" }])) as Record<NodeId, NodeView>;

export function initialState(customerId: string, scenarioId: string | null): ConsoleState {
  return {
    threadId: null,
    customerId,
    scenarioId,
    chat: scenarioId ? [{ kind: "brief", id: `brief-${scenarioId}`, scenarioId }] : [],
    nodes: blankNodes(),
    activeNode: null,
    llm: [],
    services: [],
    turnServices: [],
    turnLlm: [],
    sagaId: null,
    sagaSteps: [],
    sagaStatus: null,
    ticketStatus: null,
    approval: null,
    busy: false,
    crashed: false,
    refreshKey: 0,
    modeNote: null,
  };
}

export type Action =
  | { type: "reset"; customerId: string; scenarioId: string | null }
  | { type: "send"; text: string; resume?: boolean }
  | { type: "event"; event: string; data: unknown }
  | { type: "system"; tone: "info" | "warn" | "bad" | "ok"; text: string }
  | { type: "done" }
  | { type: "refresh" }
  | { type: "approval_cleared" };

let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "reset":
      return initialState(action.customerId, action.scenarioId);
    case "send": {
      const chat = action.resume ? state.chat : [...state.chat, { kind: "customer" as const, id: nid("c"), text: action.text, at: new Date().toISOString() }];
      return {
        ...state,
        chat,
        busy: true,
        crashed: false,
        approval: action.resume ? null : state.approval,
        nodes: action.resume ? state.nodes : blankNodes(),
        activeNode: null,
        turnServices: [],
        turnLlm: [],
        sagaSteps: action.resume ? state.sagaSteps : [],
        sagaId: action.resume ? state.sagaId : null,
        sagaStatus: action.resume ? state.sagaStatus : null,
        ticketStatus: action.resume ? state.ticketStatus : null,
      };
    }
    case "system":
      return { ...state, chat: [...state.chat, { kind: "system", id: nid("s"), tone: action.tone, text: action.text }] };
    case "done":
      return { ...state, busy: false, activeNode: null, refreshKey: state.refreshKey + 1 };
    case "refresh":
      return { ...state, refreshKey: state.refreshKey + 1 };
    case "approval_cleared":
      return { ...state, approval: null };
    case "event":
      return onEvent(state, action.event, action.data as Record<string, unknown>);
  }
}

function onEvent(state: ConsoleState, event: string, d: Record<string, unknown>): ConsoleState {
  switch (event) {
    case "meta":
      return { ...state, threadId: (d.threadId as string) ?? state.threadId, modeNote: (d.modeNote as string | null) ?? null };
    case "node_start": {
      const node = d.node as NodeId;
      if (!(node in state.nodes)) return state;
      return { ...state, activeNode: node, nodes: { ...state.nodes, [node]: { ...state.nodes[node], status: "active", at: d.at as string } } };
    }
    case "node_end": {
      const node = d.node as NodeId;
      if (!(node in state.nodes)) return state;
      const summary = (d.summary ?? {}) as Record<string, unknown>;
      const waiting = summary.waiting === true;
      return {
        ...state,
        activeNode: waiting ? node : state.activeNode === node ? null : state.activeNode,
        nodes: { ...state.nodes, [node]: { status: waiting ? "waiting" : "done", durationMs: d.durationMs as number, badge: d.badge as string, summary: waiting ? state.nodes[node].summary : summary } },
      };
    }
    case "llm_call": {
      const call = d.call as LlmCallView;
      return { ...state, llm: [...state.llm, call].slice(-200), turnLlm: [...state.turnLlm, call] };
    }
    case "service_call": {
      const call = d.call as ServiceCallView;
      return { ...state, services: [...state.services, call].slice(-400), turnServices: [...state.turnServices, call] };
    }
    case "saga_start": {
      const steps = (d.steps as SagaStepView[]) ?? [];
      return { ...state, sagaId: d.sagaId as string, sagaSteps: steps.map((s) => ({ ...s })), sagaStatus: "RUNNING" };
    }
    case "saga_step": {
      const seqN = d.seq as number;
      const exists = state.sagaSteps.some((s) => s.seq === seqN);
      const update = (s: SagaStepView): SagaStepView => {
        const status = d.status as string;
        if (status === "RETRY" || status === "FAILOVER") {
          return { ...s, status, attempt: (d.attempt as number) ?? s.attempt, message: d.message as string, carrier: (d.carrier as string) ?? s.carrier, faultInjected: (d.faultInjected as boolean) || s.faultInjected };
        }
        return { ...s, status, attempt: (d.attempt as number) ?? s.attempt, message: (d.message as string) ?? (status === "RUNNING" ? undefined : s.message), carrier: (d.carrier as string) ?? s.carrier, faultInjected: (d.faultInjected as boolean) || s.faultInjected };
      };
      const steps = exists
        ? state.sagaSteps.map((s) => (s.seq === seqN ? update(s) : s))
        : [...state.sagaSteps, update({ seq: seqN, name: d.name as string, kind: d.kind as string, status: "PENDING" })].sort((a, b) => a.seq - b.seq);
      return { ...state, sagaSteps: steps };
    }
    case "saga_end":
      return { ...state, sagaStatus: d.status as string, ticketStatus: (d.ticketStatus as string | null) ?? null };
    case "interrupt":
      return { ...state, approval: { interruptId: d.interruptId as string, card: d.card as ApprovalCard }, nodes: { ...state.nodes, n5_hitl: { ...state.nodes.n5_hitl, status: "waiting" } }, activeNode: "n5_hitl" };
    case "guard":
      return { ...state, chat: [...state.chat, { kind: "guard", id: nid("g"), code: d.code as string, message: d.message as string }] };
    case "error":
      return { ...state, chat: [...state.chat, { kind: "system", id: nid("e"), tone: "bad", text: (d.message as string) ?? "Something went wrong." }] };
    case "result":
      return onResult(state, d);
    default:
      return state;
  }
}

function onResult(state: ConsoleState, r: Record<string, unknown>): ConsoleState {
  const status = r.status as string;
  const next: ConsoleState = { ...state, threadId: (r.threadId as string) ?? state.threadId };
  if (status === "AWAITING_APPROVAL") {
    const approval = r.approval as { interruptId: string; card: ApprovalCard } | undefined;
    return { ...next, approval: approval ?? state.approval, chat: [...state.chat, { kind: "system", id: nid("s"), tone: "warn", text: "Paused for a supervisor. The run is checkpointed in Postgres — it will resume exactly here." }] };
  }
  if (status === "ERROR") {
    const err = r.error as { code: string; message: string } | undefined;
    return { ...next, crashed: err?.code === "SAGA_CRASHED", chat: [...state.chat, { kind: "system", id: nid("s"), tone: "bad", text: err?.message ?? "The turn failed." }] };
  }
  if (status === "GUARD_BLOCKED") return next;
  const reply = r.reply as { text: string; verified: boolean; usedTemplate: boolean; attempts: number } | undefined;
  if (!reply) return next;
  const facts = (r.facts as VerifiedFacts | null) ?? null;
  const saga = r.saga as { status?: string } | null;
  const item: ChatItem = {
    kind: "agent",
    id: nid("a"),
    text: reply.text,
    at: new Date().toISOString(),
    verified: reply.verified,
    usedTemplate: reply.usedTemplate,
    attempts: reply.attempts,
    badge: status === "BLOCKED" ? "FIREWALL" : state.turnLlm.some((c) => c.badge === "LIVE") ? "LIVE" : state.turnLlm.length ? "REPLAY" : "CODE",
    outcome: status === "BLOCKED" ? "BLOCKED" : status === "ASKED" ? "NEEDS_INFO" : (facts?.outcome ?? (r.outcome as string | null) ?? null),
    facts,
    services: state.turnServices,
    llm: state.turnLlm,
    sagaStatus: saga?.status ?? null,
  };
  return { ...next, approval: null, chat: [...state.chat, item] };
}
