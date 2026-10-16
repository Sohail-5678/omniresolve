/**
 * Retry policy for saga steps (spec 7.7.4): retry 429/502/503/504/timeouts with
 * exponential backoff and jitter — min(cap, base * 2^attempt) * random(0.5, 1.0) —
 * honouring retry-after on 429 (capped). Never retry 4xx or schema mismatches:
 * retrying cannot fix a bad request or a changed contract.
 */
import { AGENT } from "@/config/agent";
import { GuardError, ServiceError } from "@/lib/util/errors";

export function isRetryable(err: unknown): boolean {
  if (err instanceof GuardError) return false;
  if (err instanceof ServiceError) {
    if (err.code === "UPSTREAM_SCHEMA_MISMATCH") return false;
    return [429, 502, 503, 504].includes(err.status);
  }
  return false;
}

/** True when the call may have committed even though it failed (we must reconcile, not assume). */
export function outcomeUnknown(err: unknown): boolean {
  return err instanceof ServiceError && (err.code === "UPSTREAM_SCHEMA_MISMATCH" || err.code === "TIMEOUT");
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const { baseMs, capMs } = AGENT.retry;
  const raw = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(raw * (0.5 + 0.5 * random()));
}

export type RetryHooks = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  hooks: RetryHooks = {},
  maxAttempts: number = AGENT.retry.maxAttempts,
): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return { value: await fn(attempt + 1), attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { attempts: attempt + 1 });
      }
      let delay = backoffMs(attempt, hooks.random);
      if (err instanceof ServiceError && err.status === 429 && err.retryAfterMs) {
        delay = Math.min(Math.max(delay, err.retryAfterMs), AGENT.retry.retryAfterCapMs);
      }
      hooks.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err });
      await sleep(delay);
    }
  }
  throw lastErr;
}
