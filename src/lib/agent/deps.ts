/**
 * Dependencies every graph node closes over (built per request, so tests can inject a
 * scripted LLM and a fresh graph instance can resume any checkpoint), plus the event
 * stream the UI renders and the instrumentation wrapper that times each node.
 */
import { isGraphInterrupt } from "@langchain/langgraph";
import type { Db } from "@/db/client";
import type { LlmProvider } from "@/lib/llm/types";
import type { ServiceCallEvent } from "@/lib/services/core";
import type { SagaEvent } from "@/lib/saga/orchestrator";
import type { TurnBudget } from "./budget";
import type { LlmCallTrace } from "./structured";
import type { ApprovalCard, GraphState, GraphUpdate, TraceEvent } from "./state";

export type AgentEvent =
  | { type: "turn_start"; turnId: string; threadId: string; mode: "replay" | "live"; resumed: boolean }
  | { type: "node_start"; node: string; at: string }
  | { type: "node_end"; node: string; at: string; durationMs: number; badge: TraceEvent["badge"]; summary: Record<string, unknown> }
  | { type: "llm_call"; call: LlmCallTrace }
  | { type: "service_call"; call: ServiceCallEvent }
  | SagaEvent
  | { type: "interrupt"; interruptId: string; card: ApprovalCard }
  | { type: "guard"; ok: boolean; code: string; message: string }
  | { type: "final"; result: Record<string, unknown> }
  | { type: "error"; message: string; code?: string };

export type NodeDeps = {
  db: Db;
  sandboxId: string;
  llm: LlmProvider;
  budget: TurnBudget;
  emit: (e: AgentEvent) => void;
  /** Live-mode query embedder (Gemini); absent in replay mode. */
  embedQuery?: (query: string) => Promise<number[] | null>;
  /** Lets record-replays collect every retrieval query so their embeddings can be cached. */
  onQuery?: (query: string) => void;
  sagaHooks?: { sleep?: (ms: number) => Promise<void>; random?: () => number; crashAfterSeq?: number };
  approver: string;
  autoLimitOverrideCents?: number;
  /** Eval-only switches (spec 9.1 ablations). Never set by the web app. */
  ablation?: Ablation;
};

export type Ablation = {
  /** The LLM plan executes directly: every executable action is auto-approved and tokenised. */
  noGate?: boolean;
  /** Retrieval without the temporal filter (and without pinned rule clauses). */
  noTemporal?: boolean;
  /** The first model reply is sent unverified (the verifier still scores it post hoc). */
  noVerifier?: boolean;
  /** Skip the responder model and send the verified template (saves quota in action-only evals). */
  templateResponder?: boolean;
};

type NodeFn = (state: GraphState) => Promise<GraphUpdate>;

/** Emits node_start/node_end, records a trace event, and lets LangGraph interrupts pass through. */
export function instrument(
  name: string,
  deps: NodeDeps,
  fn: NodeFn,
  badgeOf: (update: GraphUpdate, state: GraphState) => TraceEvent["badge"] = () => "CODE",
  summarize: (update: GraphUpdate, state: GraphState) => Record<string, unknown> = () => ({}),
): NodeFn {
  return async (state) => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    deps.emit({ type: "node_start", node: name, at: startedAt });
    try {
      const update = await fn(state);
      const durationMs = Math.round((performance.now() - t0) * 100) / 100;
      const badge = badgeOf(update, state);
      const summary = summarize(update, state);
      deps.emit({ type: "node_end", node: name, at: new Date().toISOString(), durationMs, badge, summary });
      const ev: TraceEvent = { node: name, kind: "node", at: startedAt, durationMs, badge, data: summary };
      return { ...update, trace: [...(update.trace ?? state.trace), ev] };
    } catch (err) {
      if (isGraphInterrupt(err)) {
        deps.emit({ type: "node_end", node: name, at: new Date().toISOString(), durationMs: Math.round(performance.now() - t0), badge: "CODE", summary: { waiting: true } });
        throw err;
      }
      deps.emit({ type: "error", message: `${name}: ${err instanceof Error ? err.message : String(err)}` });
      throw err;
    }
  };
}

export function llmBadge(calls: LlmCallTrace[] | undefined): TraceEvent["badge"] {
  if (!calls?.length) return "CODE";
  return calls.some((c) => c.badge === "LIVE") ? "LIVE" : "REPLAY";
}
