/**
 * POST /api/session — create (or reset) the visitor's private sandbox and set the signed
 * session cookie. GET /api/session — current sandbox, expiry and what modes are available.
 */
import { z } from "zod";
import { getDb } from "@/db/client";
import { AGENT } from "@/config/agent";
import { env } from "@/config/env";
import { createSandbox, deleteSandbox, hashIp, sandboxIsLive, signSession, verifySession, SESSION_COOKIE } from "@/lib/security/sandbox";
import { rateLimit, dailyCount } from "@/lib/security/rate-limiter";
import { hasServerKeys } from "@/lib/llm/provider";
import { replayStats } from "@/lib/llm/replay";
import { corpusMeta } from "@/lib/rag/corpus";
import { getCheckpointer } from "@/lib/agent/graph";
import * as s from "@/db/schema";
import { eq } from "drizzle-orm";
import { assertSameOrigin, clientIp, json, parseBody, readCookie, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";
import { toIsoDate } from "@/lib/util/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieHeader(value: string, maxAgeSec: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function sessionInfo(sandboxId: string, expiresAt: Date) {
  const db = getDb();
  const used = await dailyCount(db, "llm:global");
  const cap = env().GLOBAL_DAILY_LLM_CALLS;
  return {
    sandboxId,
    expiresAt: expiresAt.toISOString(),
    businessDate: AGENT.businessDate,
    defaultMode: env().DEFAULT_MODE,
    live: { serverKeys: hasServerKeys(), dailyCap: cap, usedToday: used, available: hasServerKeys() && used < cap, byokAllowed: true },
    replay: replayStats(),
    corpus: corpusMeta(),
    day: toIsoDate(new Date()),
  };
}

export const GET = route(async (req: Request) => {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (!session || !(await sandboxIsLive(getDb(), session.sid))) return json({ session: null }, 200);
  return json({ session: await sessionInfo(session.sid, new Date(session.exp * 1000)) });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const body = await parseBody(req, z.object({ reset: z.boolean().optional() }));
  const db = getDb();
  const existing = verifySession(readCookie(req, SESSION_COOKIE));
  if (existing && !body.reset && (await sandboxIsLive(db, existing.sid))) {
    return json({ session: await sessionInfo(existing.sid, new Date(existing.exp * 1000)) });
  }
  const ip = clientIp(req);
  const rl = rateLimit(`session:${ip}`, AGENT.rateLimits.sessionPerHourIp, 3_600_000);
  if (!rl.ok) throw new HttpError(429, "Too many new sandboxes from this address. Try again later.");

  if (existing && body.reset) {
    const threads = await db.select({ id: s.threads.id }).from(s.threads).where(eq(s.threads.sandboxId, existing.sid));
    const saver = getCheckpointer();
    for (const t of threads) await saver.deleteThread(t.id).catch(() => undefined);
    await deleteSandbox(db, existing.sid);
  }
  const { id, expiresAt } = await createSandbox(db, { ipHash: hashIp(ip) });
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const cookie = signSession({ sid: id, exp });
  return json({ session: await sessionInfo(id, expiresAt) }, 200, { "set-cookie": cookieHeader(cookie, Math.floor(AGENT.sandboxTtlMs / 1000)) });
});
