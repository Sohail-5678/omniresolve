/**
 * Per-sandbox, per-service, per-operation fault injection for the mock APIs.
 * A fault set by one visitor only affects that visitor's sandbox, and every fault
 * switches itself off after AGENT.faultAutoResetMs. Each faulted call is reported
 * so traces can label it FAULT-INJECTED.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { ServiceError } from "@/lib/util/errors";

export const SERVICE_OPERATIONS = {
  crm: ["getCustomer"],
  orders: ["getOrders", "reserveInventory", "releaseInventory", "createReplacementDraft", "cancelDraft", "confirmReplacement"],
  billing: ["getLedger", "refund", "issueStoreCredit"],
  carrier_a: ["getTracking", "createReturnLabel", "voidLabel"],
  carrier_b: ["getTracking", "createReturnLabel", "voidLabel"],
  tickets: ["create", "addNote", "close", "cancel", "notify"],
} as const;

export type ServiceName = keyof typeof SERVICE_OPERATIONS;

export const FAULT_MODES = [
  "healthy",
  "fail_503",
  "rate_limit_429",
  "timeout",
  "commit_then_timeout",
  "schema_drift",
  "slow",
  "fail_n_times",
  "crash_after",
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export type PostFault = "none" | "commit_then_timeout" | "schema_drift" | "crash_after";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isValidOperation(service: string, operation: string): service is ServiceName {
  return service in SERVICE_OPERATIONS && (SERVICE_OPERATIONS[service as ServiceName] as readonly string[]).includes(operation);
}

export async function setFault(
  db: Queryable,
  sandboxId: string,
  service: ServiceName,
  operation: string,
  mode: FaultMode,
  n?: number,
) {
  if (mode === "healthy") {
    await db
      .delete(s.faultSettings)
      .where(and(eq(s.faultSettings.sandboxId, sandboxId), eq(s.faultSettings.service, service), eq(s.faultSettings.operation, operation)));
    return;
  }
  const expiresAt = new Date(Date.now() + AGENT.faultAutoResetMs);
  await db
    .insert(s.faultSettings)
    .values({ sandboxId, service, operation, mode, n: n ?? null, calls: 0, expiresAt })
    .onConflictDoUpdate({
      target: [s.faultSettings.sandboxId, s.faultSettings.service, s.faultSettings.operation],
      set: { mode, n: n ?? null, calls: 0, expiresAt },
    });
}

export async function clearFaults(db: Queryable, sandboxId: string) {
  await db.delete(s.faultSettings).where(eq(s.faultSettings.sandboxId, sandboxId));
}

export async function listFaults(db: Queryable, sandboxId: string) {
  return db
    .select()
    .from(s.faultSettings)
    .where(and(eq(s.faultSettings.sandboxId, sandboxId), gt(s.faultSettings.expiresAt, new Date())));
}

/**
 * Counts the call and applies any "before the work" fault (throwing for 503/429/timeout).
 * Returns the fault that must be applied after the work commits, if any.
 */
export async function applyPreFault(
  db: Queryable,
  sandboxId: string,
  service: ServiceName,
  operation: string,
): Promise<{ mode: FaultMode | null; post: PostFault }> {
  const res = await db.execute<{ mode: FaultMode; n: number | null; calls: number }>(sql`
    UPDATE fault_settings SET calls = calls + 1
    WHERE sandbox_id = ${sandboxId} AND service = ${service} AND operation = ${operation} AND expires_at > now()
    RETURNING mode, n, calls`);
  const row = res.rows[0];
  if (!row) return { mode: null, post: "none" };
  const label = `${service}.${operation}`;
  switch (row.mode) {
    case "fail_503":
      throw new ServiceError(503, "UNAVAILABLE", `${label}: 503 Service Unavailable (fault injected)`, undefined, true);
    case "rate_limit_429":
      throw new ServiceError(429, "RATE_LIMITED", `${label}: 429 Too Many Requests (fault injected)`, AGENT.faults.retryAfterSeconds * 1000, true);
    case "timeout":
      await sleep(AGENT.faults.timeoutMs);
      throw new ServiceError(504, "TIMEOUT", `${label}: timed out (fault injected)`, undefined, true);
    case "slow":
      await sleep(AGENT.faults.slowMs);
      return { mode: row.mode, post: "none" };
    case "fail_n_times":
      if (row.calls <= (row.n ?? 1)) {
        throw new ServiceError(503, "UNAVAILABLE", `${label}: 503 (fault injected, failure ${row.calls} of ${row.n ?? 1})`, undefined, true);
      }
      return { mode: row.mode, post: "none" };
    case "commit_then_timeout":
    case "crash_after":
      // One lost response / one crash: the first call commits then fails; retries and recovery see a healthy API.
      return row.calls === 1 ? { mode: row.mode, post: row.mode } : { mode: null, post: "none" };
    case "schema_drift":
      // A contract change is persistent: every call returns the drifted shape.
      return { mode: row.mode, post: row.mode };
    default:
      return { mode: null, post: "none" };
  }
}
