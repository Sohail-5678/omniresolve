/**
 * POST /api/resolve — one conversation turn, streamed as Server-Sent Events (node starts and
 * ends, LLM calls, mock-service calls, saga steps), ending with a `result` event whose status
 * is REPLIED | ASKED | AWAITING_APPROVAL | BLOCKED. The special scenario
 * "redteam-forged-call" sends a token-less refund straight at the tool guard.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { env } from "@/config/env";
import { runTurn, forgedRefundAttempt, recoverThreads } from "@/lib/agent/runner";
import { findStuckSagas } from "@/lib/saga/orchestrator";
import { hasServerKeys } from "@/lib/llm/provider";
import { setFault } from "@/lib/services/fault-injector";
import { rateLimit, incrementDaily, dailyCount } from "@/lib/security/rate-limiter";
import { scenarioById } from "@/lib/scenarios";
import { assertSameOrigin, clientIp, parseBody, requireSandbox, route, sse } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  threadId: z.string().regex(/^thr_[A-Za-z0-9_-]{6,40}$/).optional(),
  message: z.string().min(1).max(AGENT.firewall.maxMessageChars * 2),
  scenarioId: z.string().max(60).optional(),
  customerId: z.string().regex(/^CUS-\d{4}$/).optional(),
  mode: z.enum(["replay", "live"]).optional(),
  evidenceAttached: z.boolean().optional(),
  forgedCall: z.boolean().optional(),
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const sandboxId = await requireSandbox(req);
  const body = await parseBody(req, Body);
  const db = getDb();
  const ip = clientIp(req);
  if (!rateLimit(`resolve:sb:${sandboxId}`, AGENT.rateLimits.resolvePerMinuteSandbox, 60_000).ok || !rateLimit(`resolve:ip:${ip}`, AGENT.rateLimits.resolvePerMinuteIp, 60_000).ok) {
    throw new HttpError(429, "Slow down a little — too many turns this minute.");
  }

  const scenario = scenarioById(body.scenarioId);
  const byok = { groq: req.headers.get("x-byok-groq") || undefined, gemini: req.headers.get("x-byok-gemini") || undefined };
  const usingByok = !!(byok.groq || byok.gemini);

  // Mode: live needs a key (server or the visitor's own) and quota; otherwise replay, with a reason.
  let mode: "replay" | "live" = body.mode ?? env().DEFAULT_MODE;
  let modeNote: string | null = null;
  if (mode === "live" && !usingByok) {
    if (!hasServerKeys()) {
      mode = "replay";
      modeNote = "No server LLM key is configured, so this turn ran in replay mode. Add your own key to use Live mode.";
    } else {
      const [global, mine] = await Promise.all([dailyCount(db, "llm:global"), dailyCount(db, `llm:sb:${sandboxId}`)]);
      if (global >= env().GLOBAL_DAILY_LLM_CALLS || mine >= AGENT.rateLimits.liveTurnsPerDaySandbox * 5) {
        mode = "replay";
        modeNote = "Today's shared live quota is used up, so this turn ran in replay mode. Add your own key to keep using Live mode.";
      }
    }
  }

  // Thread: existing (must belong to this sandbox) or new.
  let threadId = body.threadId;
  let customerId: string;
  if (threadId) {
    const rows = await db.select().from(s.threads).where(and(eq(s.threads.id, threadId), eq(s.threads.sandboxId, sandboxId)));
    if (!rows[0]) throw new HttpError(404, "Thread not found.");
    customerId = rows[0].customerId;
  } else {
    customerId = scenario?.customerId ?? body.customerId ?? "CUS-1007";
    const cust = await db.select({ id: s.customers.id }).from(s.customers).where(and(eq(s.customers.sandboxId, sandboxId), eq(s.customers.id, customerId)));
    if (!cust[0]) throw new HttpError(404, "Customer not found in this sandbox.");
    threadId = `thr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(s.threads).values({
      id: threadId,
      sandboxId,
      customerId,
      scenarioId: scenario?.id ?? null,
      status: "ACTIVE",
      title: scenario?.title ?? body.message.slice(0, 60),
      mode,
      evidenceAttached: body.evidenceAttached ?? scenario?.evidenceAttached ?? false,
    });
    for (const f of scenario?.faults ?? []) await setFault(db, sandboxId, f.service, f.operation, f.mode, f.n);
  }
  const tid = threadId;

  return sse(async (send) => {
    send("meta", { threadId: tid, customerId, mode, modeNote, scenarioId: scenario?.id ?? null, faultsApplied: body.threadId ? [] : (scenario?.faults ?? []) });

    // A crashed saga in this sandbox is finished before anything new runs.
    const stuck = await findStuckSagas(db, sandboxId);
    if (stuck.length) {
      send("recovery", { sagas: stuck.map((x) => x.id) });
      await recoverThreads({ db, sandboxId, mode: "replay", emit: (e) => send(e.type, e) });
    }

    if (body.forgedCall && scenario?.forgedCall) {
      const res = await forgedRefundAttempt(db, sandboxId, tid, scenario.forgedCall.orderId, scenario.forgedCall.amountCents);
      send("guard", { type: "guard", ok: !res.blocked, code: res.code, message: res.message });
      send("result", { status: "GUARD_BLOCKED", threadId: tid, guard: res });
      return;
    }

    const result = await runTurn({
      db,
      sandboxId,
      threadId: tid,
      customerId,
      mode,
      byok: usingByok ? byok : undefined,
      message: body.message,
      evidenceAttached: body.evidenceAttached ?? scenario?.evidenceAttached ?? false,
      emit: (e) => send(e.type, e),
    });
    if (mode === "live" && result.usage.llmCalls > 0) {
      await incrementDaily(db, `llm:sb:${sandboxId}`, result.usage.llmCalls);
      if (!usingByok) await incrementDaily(db, "llm:global", result.usage.llmCalls);
    }
    send("result", { ...result, mode, modeNote });
  });
});
