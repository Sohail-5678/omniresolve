/**
 * GET /api/chaos — this sandbox's active faults. POST /api/chaos — set or clear a fault
 * for one service operation (this sandbox only; auto-resets after 10 minutes).
 */
import { z } from "zod";
import { getDb } from "@/db/client";
import { AGENT } from "@/config/agent";
import { FAULT_MODES, SERVICE_OPERATIONS, clearFaults, isValidOperation, listFaults, setFault } from "@/lib/services/fault-injector";
import { rateLimit } from "@/lib/security/rate-limiter";
import { assertSameOrigin, json, parseBody, requireSandbox, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const sandboxId = await requireSandbox(req);
  const faults = await listFaults(getDb(), sandboxId);
  return json({ faults: faults.map((f) => ({ service: f.service, operation: f.operation, mode: f.mode, n: f.n, calls: f.calls, expiresAt: f.expiresAt })), catalog: SERVICE_OPERATIONS, modes: FAULT_MODES });
});

const Body = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ service: z.string().max(20), operation: z.string().max(40), mode: z.enum(FAULT_MODES), n: z.number().int().min(1).max(5).optional() }),
]);

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const sandboxId = await requireSandbox(req);
  if (!rateLimit(`chaos:${sandboxId}`, AGENT.rateLimits.chaosPerMinuteSandbox, 60_000).ok) throw new HttpError(429, "Too many chaos changes this minute.");
  const body = await parseBody(req, Body);
  const db = getDb();
  if ("reset" in body) {
    await clearFaults(db, sandboxId);
  } else {
    if (!isValidOperation(body.service, body.operation)) throw new HttpError(400, "Unknown service operation.");
    await setFault(db, sandboxId, body.service, body.operation, body.mode, body.mode === "fail_n_times" ? (body.n ?? 2) : undefined);
  }
  const faults = await listFaults(db, sandboxId);
  return json({ faults: faults.map((f) => ({ service: f.service, operation: f.operation, mode: f.mode, n: f.n, calls: f.calls, expiresAt: f.expiresAt })) });
});
