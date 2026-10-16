/**
 * POST /api/hitl — the supervisor's decision for a paused run: approve | modify | reject.
 * Resumes the checkpointed graph with Command({ resume }) and streams the saga live.
 * Repeating the same (thread, interrupt) returns the stored result; it never runs twice.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { env } from "@/config/env";
import { resumeTurn } from "@/lib/agent/runner";
import { hasServerKeys } from "@/lib/llm/provider";
import { assertSameOrigin, parseBody, requireSandbox, route, sse } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";
import { incrementDaily } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  threadId: z.string().regex(/^thr_[A-Za-z0-9_-]{6,40}$/),
  interruptId: z.string().min(1).max(100),
  decision: z.enum(["approve", "modify", "reject"]),
  amountCents: z.number().int().positive().max(10_000_000).optional(),
  removeActions: z.array(z.number().int().min(0).max(2_000)).max(10).optional(),
  note: z.string().max(500).optional(),
  mode: z.enum(["replay", "live"]).optional(),
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const sandboxId = await requireSandbox(req);
  const body = await parseBody(req, Body);
  const db = getDb();
  const rows = await db.select().from(s.threads).where(and(eq(s.threads.id, body.threadId), eq(s.threads.sandboxId, sandboxId)));
  if (!rows[0]) throw new HttpError(404, "Thread not found.");

  const byok = { groq: req.headers.get("x-byok-groq") || undefined, gemini: req.headers.get("x-byok-gemini") || undefined };
  const usingByok = !!(byok.groq || byok.gemini);
  let mode = body.mode ?? (rows[0].mode as "replay" | "live");
  if (mode === "live" && !usingByok && !hasServerKeys()) mode = "replay";

  return sse(async (send) => {
    send("meta", { threadId: body.threadId, mode });
    const result = await resumeTurn({
      db,
      sandboxId,
      threadId: body.threadId,
      mode,
      byok: usingByok ? byok : undefined,
      interruptId: body.interruptId,
      decision: { decision: body.decision, amountCents: body.amountCents, removeActions: body.removeActions, note: body.note },
      emit: (e) => send(e.type, e),
    });
    if (mode === "live" && result.usage.llmCalls > 0 && !result.duplicate) {
      await incrementDaily(db, `llm:sb:${sandboxId}`, result.usage.llmCalls);
      if (!usingByok && env().GROQ_API_KEY) await incrementDaily(db, "llm:global", result.usage.llmCalls);
    }
    send("result", { ...result, mode });
  });
});
