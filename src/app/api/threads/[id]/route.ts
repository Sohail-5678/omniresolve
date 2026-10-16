/**
 * GET /api/threads/:id — the thread's current graph state (no token payloads), its
 * checkpoint history from LangGraph, trace events and saga logs. Sandbox-scoped: a thread
 * from another sandbox is a 404.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { buildGraph, getCheckpointer } from "@/lib/agent/graph";
import { TurnBudget } from "@/lib/agent/budget";
import { ReplayProvider } from "@/lib/llm/replay";
import type { GraphState } from "@/lib/agent/state";
import { json, requireSandbox, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const sandboxId = await requireSandbox(req);
  const { id } = await ctx.params;
  const db = getDb();
  const rows = await db.select().from(s.threads).where(and(eq(s.threads.id, id), eq(s.threads.sandboxId, sandboxId)));
  const thread = rows[0];
  if (!thread) throw new HttpError(404, "Thread not found.");

  const graph = buildGraph(
    { db, sandboxId, llm: new ReplayProvider(), budget: new TurnBudget(), emit: () => undefined, approver: "supervisor:demo" },
    getCheckpointer(),
  );
  const config = { configurable: { thread_id: id } };
  const snap = await graph.getState(config);
  const state = (snap.values ?? {}) as Partial<GraphState>;
  const history: { checkpointId: string; step: number; source: string; next: string[]; createdAt: string | undefined; writes: string[] }[] = [];
  for await (const h of graph.getStateHistory(config, { limit: 40 })) {
    const meta = (h.metadata ?? {}) as { step?: number; source?: string; writes?: Record<string, unknown> | null };
    history.push({
      checkpointId: String(h.config.configurable?.checkpoint_id ?? ""),
      step: meta.step ?? -1,
      source: meta.source ?? "",
      next: [...h.next],
      createdAt: h.createdAt,
      writes: meta.writes ? Object.keys(meta.writes) : [],
    });
  }

  const trace = await db
    .select()
    .from(s.traceEvents)
    .where(and(eq(s.traceEvents.sandboxId, sandboxId), eq(s.traceEvents.threadId, id)))
    .orderBy(asc(s.traceEvents.id))
    .limit(600);
  const sagas = await db.select().from(s.sagaRuns).where(and(eq(s.sagaRuns.sandboxId, sandboxId), eq(s.sagaRuns.threadId, id)));
  const steps = sagas.length
    ? await db.select().from(s.sagaSteps).where(inArray(s.sagaSteps.sagaId, sagas.map((x) => x.id))).orderBy(asc(s.sagaSteps.seq))
    : [];

  const { tokens, ...rest } = state;
  return json({
    thread,
    state: { ...rest, tokens: (tokens ?? []).map((t) => ({ decisionIndex: t.decisionIndex, action: t.action, approvedBy: t.approvedBy, tokenId: `${t.tokenId.slice(0, 8)}…` })) },
    next: snap.next,
    interrupts: snap.tasks.flatMap((t) => t.interrupts ?? []).map((i) => ({ id: i.id })),
    history,
    trace: trace.map((t) => ({ id: t.id, turnId: t.turnId, node: t.node, kind: t.kind, data: t.data, at: t.createdAt })),
    sagas: sagas.map((r) => ({ ...r, plan: undefined, steps: steps.filter((x) => x.sagaId === r.id).map((x) => ({ ...x, request: { ...(x.request ?? {}), tokenId: undefined } })) })),
  });
});
