/**
 * Runs one conversation turn (or one HITL resume) end to end: firewall → graph → status.
 * Builds a fresh graph per request over the shared Postgres checkpointer, so a resume
 * works on whichever serverless instance receives it. Persists trace events and thread
 * status, and makes duplicate approvals idempotent via hitl_decisions.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { env } from "@/config/env";
import { estimateCostUsd } from "@/config/pricing";
import { runFirewall, type FirewallResult } from "@/lib/security/firewall";
import { getCorpus } from "@/lib/rag/corpus";
import { providerFor, type ProviderKeys } from "@/lib/llm/provider";
import { geminiEmbed } from "@/lib/llm/gemini";
import { embeddingModel } from "@/lib/rag/corpus";
import { EMBEDDING_MODEL } from "@/config/models";
import type { LlmProvider } from "@/lib/llm/types";
import * as billing from "@/lib/services/billing";
import { GuardError } from "@/lib/util/errors";
import { recoverSagas, type SagaSummary } from "@/lib/saga/orchestrator";
import { TurnBudget } from "./budget";
import { buildGraph, getCheckpointer } from "./graph";
import type { AgentEvent, NodeDeps } from "./deps";
import type { ApprovalCard, GraphState, HitlDecision, TurnMessage, VerifiedFacts } from "./state";

export type TurnStatus = "REPLIED" | "ASKED" | "AWAITING_APPROVAL" | "BLOCKED" | "ERROR";

export type TurnResult = {
  status: TurnStatus;
  threadId: string;
  turnId: string;
  reply?: { text: string; verified: boolean; usedTemplate: boolean; attempts: number; problems: string[] };
  approval?: { interruptId: string; card: ApprovalCard };
  facts?: VerifiedFacts | null;
  saga?: SagaSummary | null;
  firewall?: FirewallResult;
  outcome?: string | null;
  usage: { llmCalls: number; inputTokens: number; outputTokens: number; repairs: number; elapsedMs: number; costUsd: number };
  error?: { code: string; message: string };
};

export type RunOptions = {
  db: Db;
  sandboxId: string;
  threadId: string;
  mode: "replay" | "live";
  byok?: ProviderKeys;
  emit?: (e: AgentEvent) => void;
  checkpointer?: BaseCheckpointSaver;
  llm?: LlmProvider;
  sagaHooks?: NodeDeps["sagaHooks"];
  onQuery?: (q: string) => void;
  approver?: string;
  ablation?: NodeDeps["ablation"];
  /** Evals wait out free-tier rate limits, so they get a longer wall-time budget than the web app. */
  budgetLimits?: import("./budget").BudgetLimits;
};

const CLAUSE_IDS = () => new Set(getCorpus().map((c) => c.clauseId));

function makeDeps(opts: RunOptions, budget: TurnBudget, events: AgentEvent[]): NodeDeps {
  const llm = opts.llm ?? providerFor(opts.mode, opts.byok);
  const geminiKey = opts.byok?.gemini ?? env().GEMINI_API_KEY;
  const canEmbed = opts.mode === "live" && !!geminiKey && embeddingModel() === EMBEDDING_MODEL.model;
  return {
    db: opts.db,
    sandboxId: opts.sandboxId,
    llm,
    budget,
    emit: (e) => {
      events.push(e);
      opts.emit?.(e);
    },
    embedQuery: canEmbed ? async (q) => (await geminiEmbed(geminiKey!, [q], "RETRIEVAL_QUERY"))[0] ?? null : undefined,
    onQuery: opts.onQuery,
    sagaHooks: opts.sagaHooks,
    approver: opts.approver ?? "supervisor:demo",
    autoLimitOverrideCents: env().AUTO_REFUND_LIMIT_CENTS_OVERRIDE,
    ablation: opts.ablation,
  };
}

function usageOf(budget: TurnBudget, state: GraphState | null) {
  const calls = state?.llmCalls ?? [];
  return { ...budget.snapshot(), costUsd: Math.round(calls.reduce((sum, c) => sum + estimateCostUsd(c.model, c.inputTokens, c.outputTokens), 0) * 1e6) / 1e6 };
}

async function persistTrace(db: Db, sandboxId: string, threadId: string, turnId: string, events: AgentEvent[]) {
  const rows = events
    .filter((e) => e.type !== "node_start")
    .slice(0, 300)
    .map((e) => ({
      sandboxId,
      threadId,
      turnId,
      node: "node" in e ? String(e.node) : e.type === "llm_call" ? e.call.node : e.type === "service_call" ? e.call.service : e.type.startsWith("saga") ? "execute" : "runner",
      kind: e.type,
      data: e as unknown as Record<string, unknown>,
    }));
  if (rows.length) await db.insert(s.traceEvents).values(rows);
}

async function setThread(db: Db, sandboxId: string, threadId: string, patch: Partial<typeof s.threads.$inferInsert>) {
  await db
    .update(s.threads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(s.threads.id, threadId), eq(s.threads.sandboxId, sandboxId)));
}

async function snapshotResult(
  graph: ReturnType<typeof buildGraph>,
  config: { configurable: { thread_id: string } },
  base: { threadId: string; turnId: string; budget: TurnBudget; firewall?: FirewallResult },
): Promise<TurnResult> {
  const snap = await graph.getState(config);
  const state = snap.values as GraphState;
  const interrupts = snap.tasks.flatMap((t) => t.interrupts ?? []);
  if (interrupts.length) {
    const intr = interrupts[0];
    return {
      status: "AWAITING_APPROVAL",
      threadId: base.threadId,
      turnId: base.turnId,
      approval: { interruptId: intr.id ?? "interrupt", card: intr.value as ApprovalCard },
      firewall: base.firewall,
      outcome: "AWAITING_APPROVAL",
      usage: usageOf(base.budget, state),
    };
  }
  return {
    status: state.outcome === "ASKED" ? "ASKED" : "REPLIED",
    threadId: base.threadId,
    turnId: base.turnId,
    reply: state.reply ?? undefined,
    facts: state.facts,
    saga: state.saga,
    firewall: base.firewall,
    outcome: state.facts?.outcome ?? state.outcome,
    usage: usageOf(base.budget, state),
  };
}

function threadStatusFor(r: TurnResult): string {
  if (r.status === "AWAITING_APPROVAL") return "AWAITING_APPROVAL";
  if (r.status === "ASKED") return "ASKED";
  if (r.status === "BLOCKED") return "BLOCKED";
  if (r.status === "ERROR") return "ERROR";
  return r.outcome === "RESOLVED" ? "RESOLVED" : String(r.outcome ?? "REPLIED");
}

export async function runTurn(opts: RunOptions & { customerId: string; message: string; evidenceAttached: boolean }): Promise<TurnResult> {
  const turnId = `turn_${randomUUID().slice(0, 8)}`;
  const budget = new TurnBudget(opts.budgetLimits);
  const events: AgentEvent[] = [];
  const deps = makeDeps(opts, budget, events);
  const checkpointer = opts.checkpointer ?? getCheckpointer();
  const graph = buildGraph(deps, checkpointer);
  const config = { configurable: { thread_id: opts.threadId }, recursionLimit: 30 };
  deps.emit({ type: "turn_start", turnId, threadId: opts.threadId, mode: opts.mode, resumed: false });

  const prior = await graph.getState(config);
  const pending = prior.tasks.flatMap((t) => t.interrupts ?? []);
  if (pending.length) {
    return {
      status: "AWAITING_APPROVAL",
      threadId: opts.threadId,
      turnId,
      approval: { interruptId: pending[0].id ?? "interrupt", card: pending[0].value as ApprovalCard },
      usage: usageOf(budget, null),
      error: { code: "AWAITING_APPROVAL", message: "This case is waiting for a supervisor decision." },
    };
  }
  const priorMessages = ((prior.values as GraphState | undefined)?.messages ?? []) as TurnMessage[];
  const firewall = runFirewall(opts.message, { turnCount: priorMessages.filter((m) => m.role === "customer").length + 1, knownClauseIds: CLAUSE_IDS() });

  if (firewall.outcome === "block") {
    const text = "I can't process that message. If you have a question about an order, please describe it in your own words and include the order number.";
    await opts.db.insert(s.redteamEvents).values({ sandboxId: opts.sandboxId, threadId: opts.threadId, kind: "firewall_block", data: { score: firewall.score, signals: firewall.signals } });
    await persistTrace(opts.db, opts.sandboxId, opts.threadId, turnId, [...events, { type: "final", result: { status: "BLOCKED", firewall } }]);
    await setThread(opts.db, opts.sandboxId, opts.threadId, { status: "BLOCKED" });
    return { status: "BLOCKED", threadId: opts.threadId, turnId, reply: { text, verified: true, usedTemplate: true, attempts: 0, problems: [] }, firewall, usage: usageOf(budget, null) };
  }
  if (firewall.outcome === "flag") {
    await opts.db.insert(s.redteamEvents).values({ sandboxId: opts.sandboxId, threadId: opts.threadId, kind: "firewall_flag", data: { score: firewall.score, signals: firewall.signals } });
  }

  const customerMsg: TurnMessage = { role: "customer", text: firewall.sanitizedText, at: new Date().toISOString(), turnId };
  let result: TurnResult;
  try {
    await graph.invoke(
      {
        sandboxId: opts.sandboxId,
        threadId: opts.threadId,
        customerId: opts.customerId,
        mode: opts.mode,
        turnId,
        evidenceAttached: opts.evidenceAttached,
        messages: [customerMsg],
        firewall,
        triage: null,
        context: null,
        policies: null,
        retrievalMeta: null,
        plan: null,
        gate: null,
        approval: null,
        tokens: [],
        saga: null,
        facts: null,
        reply: null,
        outcome: null,
        escalation: null,
        llmCalls: [],
        trace: [],
      },
      config,
    );
    result = await snapshotResult(graph, config, { threadId: opts.threadId, turnId, budget, firewall });
  } catch (err) {
    const crashed = err instanceof Error && err.name === "SimulatedCrash";
    result = {
      status: "ERROR",
      threadId: opts.threadId,
      turnId,
      firewall,
      usage: usageOf(budget, null),
      error: { code: crashed ? "SAGA_CRASHED" : "TURN_FAILED", message: crashed ? `${(err as Error).message}. The saga log is intact — use Recover to finish it.` : "The turn failed. Details are in the server log." },
    };
    if (!crashed) console.error("[runTurn]", err);
  }
  if (result.approval) deps.emit({ type: "interrupt", interruptId: result.approval.interruptId, card: result.approval.card });
  deps.emit({ type: "final", result: { status: result.status, outcome: result.outcome, usage: result.usage, error: result.error } });
  await persistTrace(opts.db, opts.sandboxId, opts.threadId, turnId, events);
  await setThread(opts.db, opts.sandboxId, opts.threadId, { status: threadStatusFor(result), interruptId: result.approval?.interruptId ?? null });
  return result;
}

export async function resumeTurn(opts: RunOptions & { interruptId: string; decision: HitlDecision }): Promise<TurnResult & { duplicate?: boolean }> {
  const turnId = `turn_${randomUUID().slice(0, 8)}`;
  const budget = new TurnBudget(opts.budgetLimits);

  // Idempotency: the first request for (thread, interrupt) wins; repeats get its stored result.
  const inserted = await opts.db
    .insert(s.hitlDecisions)
    .values({ sandboxId: opts.sandboxId, threadId: opts.threadId, interruptId: opts.interruptId, decision: opts.decision as Record<string, unknown>, status: "processing" })
    .onConflictDoNothing()
    .returning({ threadId: s.hitlDecisions.threadId });
  if (!inserted.length) {
    const prior = await opts.db
      .select()
      .from(s.hitlDecisions)
      .where(and(eq(s.hitlDecisions.threadId, opts.threadId), eq(s.hitlDecisions.interruptId, opts.interruptId), eq(s.hitlDecisions.sandboxId, opts.sandboxId)));
    const row = prior[0];
    if (row?.status === "done" && row.result) return { ...(row.result as unknown as TurnResult), duplicate: true };
    return {
      status: "ERROR",
      threadId: opts.threadId,
      turnId,
      usage: usageOf(budget, null),
      duplicate: true,
      error: { code: row?.status === "failed" ? "RESUME_FAILED" : "ALREADY_PROCESSING", message: "This approval is already being processed." },
    };
  }

  const events: AgentEvent[] = [];
  const deps = makeDeps(opts, budget, events);
  const graph = buildGraph(deps, opts.checkpointer ?? getCheckpointer());
  const config = { configurable: { thread_id: opts.threadId }, recursionLimit: 30 };
  deps.emit({ type: "turn_start", turnId, threadId: opts.threadId, mode: opts.mode, resumed: true });

  const snap = await graph.getState(config);
  const pending = snap.tasks.flatMap((t) => t.interrupts ?? []);
  if (!pending.some((p) => p.id === opts.interruptId)) {
    await opts.db
      .update(s.hitlDecisions)
      .set({ status: "failed", result: { error: "NO_SUCH_INTERRUPT" } })
      .where(and(eq(s.hitlDecisions.threadId, opts.threadId), eq(s.hitlDecisions.interruptId, opts.interruptId)));
    return { status: "ERROR", threadId: opts.threadId, turnId, usage: usageOf(budget, null), error: { code: "NO_SUCH_INTERRUPT", message: "There is no pending approval with that ID." } };
  }

  let result: TurnResult;
  try {
    await graph.invoke(new Command({ resume: opts.decision }), config);
    result = await snapshotResult(graph, config, { threadId: opts.threadId, turnId, budget });
  } catch (err) {
    const crashed = err instanceof Error && err.name === "SimulatedCrash";
    result = {
      status: "ERROR",
      threadId: opts.threadId,
      turnId,
      usage: usageOf(budget, null),
      error: { code: crashed ? "SAGA_CRASHED" : "RESUME_FAILED", message: crashed ? `${(err as Error).message}. Use Recover to finish the saga.` : "Resuming the run failed." },
    };
    if (!crashed) console.error("[resumeTurn]", err);
  }
  deps.emit({ type: "final", result: { status: result.status, outcome: result.outcome, usage: result.usage, error: result.error } });
  await persistTrace(opts.db, opts.sandboxId, opts.threadId, turnId, events);
  await opts.db
    .update(s.hitlDecisions)
    .set({ status: result.status === "ERROR" && result.error?.code !== "SAGA_CRASHED" ? "failed" : "done", result: result as unknown as Record<string, unknown> })
    .where(and(eq(s.hitlDecisions.threadId, opts.threadId), eq(s.hitlDecisions.interruptId, opts.interruptId)));
  await setThread(opts.db, opts.sandboxId, opts.threadId, { status: threadStatusFor(result), interruptId: null });
  return result;
}

/** Finishes crashed sagas in the sandbox, then lets each affected thread's graph complete its turn. */
export async function recoverThreads(opts: Omit<RunOptions, "threadId">, olderThanMs?: number) {
  const events: AgentEvent[] = [];
  const sagas = await recoverSagas(
    { db: opts.db, sandboxId: opts.sandboxId, emit: (e) => { events.push(e); opts.emit?.(e); }, ...opts.sagaHooks },
    olderThanMs,
  );
  const results: TurnResult[] = [];
  for (const saga of sagas) {
    const run = await opts.db.select({ threadId: s.sagaRuns.threadId }).from(s.sagaRuns).where(eq(s.sagaRuns.id, saga.sagaId));
    const threadId = run[0]?.threadId;
    if (!threadId) continue;
    const budget = new TurnBudget();
    const deps = makeDeps({ ...opts, threadId }, budget, events);
    const graph = buildGraph(deps, opts.checkpointer ?? getCheckpointer());
    const config = { configurable: { thread_id: threadId }, recursionLimit: 30 };
    const snap = await graph.getState(config);
    if (snap.next.length) {
      try {
        await graph.invoke(null, config);
      } catch (err) {
        console.error("[recover] graph resume failed", err);
      }
    }
    const r = await snapshotResult(graph, config, { threadId, turnId: `recover_${saga.sagaId}`, budget });
    await setThread(opts.db, opts.sandboxId, threadId, { status: threadStatusFor(r) });
    results.push(r);
  }
  return { sagas, threads: results };
}

/** Red-team demo: a refund call with no approval token, straight at the tool boundary. */
export async function forgedRefundAttempt(db: Db, sandboxId: string, threadId: string, orderId: string, amountCents: number) {
  let code = "UNEXPECTED_SUCCESS";
  let message = "";
  try {
    await billing.refund(
      { db, sandboxId },
      { threadId, sagaId: "forged", orderId, amountCents, reason: "other", tokenId: null, idempotencyKey: `forged-${randomUUID()}` },
    );
    message = "The refund went through — this would be a critical bug.";
  } catch (err) {
    if (err instanceof GuardError) {
      code = err.code;
      message = err.message;
    } else {
      code = "ERROR";
      message = err instanceof Error ? err.message : String(err);
    }
  }
  await db.insert(s.redteamEvents).values({ sandboxId, threadId, kind: "forged_tool_call", data: { orderId, amountCents, code, message } });
  return { blocked: code !== "UNEXPECTED_SUCCESS", code, message, orderId, amountCents };
}
