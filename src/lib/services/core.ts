/**
 * Shared plumbing for the mock business APIs: the per-call context, the fault-aware
 * call wrapper, per-sandbox sequential IDs and idempotent execution. These are mocks
 * that live in Postgres; they behave like remote APIs (status codes, lost responses,
 * schema drift) so the saga can be tested against realistic failures.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db, Queryable } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { ServiceError, SimulatedCrash } from "@/lib/util/errors";
import { applyPreFault, sleep, type FaultMode, type ServiceName } from "./fault-injector";
import type { IdPrefix } from "@/lib/seed/generate";

export type ServiceCallEvent = {
  service: ServiceName;
  operation: string;
  ok: boolean;
  status?: number;
  error?: string;
  faultMode: FaultMode | null;
  faultInjected: boolean;
  durationMs: number;
  replayed?: boolean;
};

export type ServiceCtx = {
  db: Db;
  sandboxId: string;
  onCall?: (e: ServiceCallEvent) => void;
};

/**
 * Runs one mock API operation with fault injection around it.
 * `drift` returns the malformed payload used by the `schema_drift` fault.
 */
export async function callService<T>(
  ctx: ServiceCtx,
  service: ServiceName,
  operation: string,
  exec: () => Promise<T>,
  drift: (result: T) => unknown,
): Promise<T> {
  const start = Date.now();
  let mode: FaultMode | null = null;
  try {
    const pre = await applyPreFault(ctx.db, ctx.sandboxId, service, operation);
    mode = pre.mode;
    const result = await exec();
    if (pre.post === "commit_then_timeout") {
      await sleep(AGENT.faults.timeoutMs);
      throw new ServiceError(504, "TIMEOUT", `${service}.${operation}: committed, but the response was lost (fault injected)`, undefined, true);
    }
    if (pre.post === "crash_after") {
      ctx.onCall?.({ service, operation, ok: true, faultMode: mode, faultInjected: true, durationMs: Date.now() - start });
      throw new SimulatedCrash(`${service}.${operation}`);
    }
    const out = pre.post === "schema_drift" ? (drift(result) as T) : result;
    ctx.onCall?.({
      service,
      operation,
      ok: true,
      faultMode: mode,
      faultInjected: mode !== null,
      durationMs: Date.now() - start,
      replayed: typeof result === "object" && result !== null && (result as { replayed?: boolean }).replayed === true,
    });
    return out;
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    const se = err instanceof ServiceError ? err : null;
    ctx.onCall?.({
      service,
      operation,
      ok: false,
      status: se?.status,
      error: err instanceof Error ? err.message : String(err),
      faultMode: mode ?? (se?.faultInjected ? "fail_503" : null),
      faultInjected: se?.faultInjected ?? false,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

/** Next per-sandbox sequential ID, e.g. "TCK-1001". Deterministic for a fresh sandbox. */
export async function nextId(db: Queryable, sandboxId: string, prefix: IdPrefix): Promise<string> {
  const res = await db.execute<{ value: number }>(sql`
    UPDATE id_counters SET value = value + 1 WHERE sandbox_id = ${sandboxId} AND prefix = ${prefix} RETURNING value`);
  const value = res.rows[0]?.value;
  if (value === undefined) throw new Error(`id counter ${prefix} missing for sandbox`);
  return `${prefix}-${value}`;
}

/**
 * Executes `fn` at most once per idempotency key (unique constraint on the key).
 * A repeated key returns the stored response without doing the work again, which is
 * what makes retries safe after "committed, but the response was lost".
 */
export async function idempotent<T extends Record<string, unknown>>(
  tx: Queryable,
  sandboxId: string,
  key: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T & { replayed?: boolean }> {
  const prior = await tx
    .select({ response: s.idempotencyKeys.response })
    .from(s.idempotencyKeys)
    .where(and(eq(s.idempotencyKeys.key, key), eq(s.idempotencyKeys.sandboxId, sandboxId)));
  if (prior[0]) return { ...(prior[0].response as T), replayed: true };
  const response = await fn();
  await tx.insert(s.idempotencyKeys).values({ key, sandboxId, operation, response });
  return response;
}

export function notFound(what: string): ServiceError {
  return new ServiceError(404, "NOT_FOUND", `${what} not found`);
}
