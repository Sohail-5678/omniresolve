/**
 * LangGraph wiring for the resolution agent: a graph-orchestrated agent with three LLM
 * nodes (triage, planner, responder) and deterministic code gates — not a multi-agent swarm.
 *
 *   START → triage ─┬─ ask → END
 *                   ├─ respond (LLM unavailable)
 *                   └─ context → retrieve → plan → gate ─┬─ execute → respond → END
 *                                                         ├─ hitl ─┬─ execute
 *                                                         │        └─ respond (reject)
 *                                                         └─ respond (denied)
 */
import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPool } from "@/db/client";
import { ResolutionState } from "./state";
import type { NodeDeps } from "./deps";
import { afterTriage, makeTriageNode } from "./nodes/triage";
import { makeAskNode } from "./nodes/ask";
import { makeContextNode } from "./nodes/context";
import { makeRetrieveNode } from "./nodes/retrieve";
import { makePlanNode } from "./nodes/plan";
import { afterGate, makeGateNode } from "./nodes/gate";
import { afterHitl, makeHitlNode } from "./nodes/hitl";
import { makeExecuteNode } from "./nodes/execute";
import { makeRespondNode } from "./nodes/respond";

/** Node IDs (distinct from state channel names, which LangGraph requires). */
export const NODE = {
  triage: "n1_triage",
  ask: "ask",
  context: "n2_context",
  retrieve: "n3_retrieve",
  plan: "n4a_plan",
  gate: "n4b_gate",
  hitl: "n5_hitl",
  execute: "n6_execute",
  respond: "n7_respond",
} as const;

export function buildGraph(deps: NodeDeps, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ResolutionState)
    .addNode(NODE.triage, makeTriageNode(deps))
    .addNode(NODE.ask, makeAskNode(deps))
    .addNode(NODE.context, makeContextNode(deps))
    .addNode(NODE.retrieve, makeRetrieveNode(deps))
    .addNode(NODE.plan, makePlanNode(deps))
    .addNode(NODE.gate, makeGateNode(deps))
    .addNode(NODE.hitl, makeHitlNode(deps))
    .addNode(NODE.execute, makeExecuteNode(deps))
    .addNode(NODE.respond, makeRespondNode(deps))
    .addEdge(START, NODE.triage)
    .addConditionalEdges(NODE.triage, afterTriage, { ask: NODE.ask, context: NODE.context, respond: NODE.respond })
    .addEdge(NODE.ask, END)
    .addConditionalEdges(NODE.context, (s) => (s.escalation ? "respond" : "retrieve"), { respond: NODE.respond, retrieve: NODE.retrieve })
    .addEdge(NODE.retrieve, NODE.plan)
    .addConditionalEdges(NODE.plan, (s) => (s.escalation ? "respond" : "gate"), { respond: NODE.respond, gate: NODE.gate })
    .addConditionalEdges(NODE.gate, afterGate, { hitl: NODE.hitl, execute: NODE.execute, respond: NODE.respond })
    .addConditionalEdges(NODE.hitl, afterHitl, { execute: NODE.execute, respond: NODE.respond })
    .addEdge(NODE.execute, NODE.respond)
    .addEdge(NODE.respond, END)
    .compile({ checkpointer });
}

export type ResolutionGraph = ReturnType<typeof buildGraph>;

const globalForSaver = globalThis as unknown as { __omniSaver?: PostgresSaver };

/** One PostgresSaver per instance, sharing the app's pg pool. Tables are created by migrate.ts. */
export function getCheckpointer(): PostgresSaver {
  if (!globalForSaver.__omniSaver) globalForSaver.__omniSaver = new PostgresSaver(getPool());
  return globalForSaver.__omniSaver;
}

export const GRAPH_NODES = Object.values(NODE);
