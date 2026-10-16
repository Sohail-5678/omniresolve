/**
 * Two layers of abuse protection:
 *  - per-instance sliding windows in memory (cheap, resets on cold start), and
 *  - Postgres-backed daily counters for LLM quota (global, per sandbox, per IP).
 * Known gap: the in-memory layer is per serverless instance, not global.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import * as s from "@/db/schema";
import { toIsoDate } from "@/lib/util/dates";

const windows = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterMs: number } {
  const list = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    windows.set(key, list);
    return { ok: false, retryAfterMs: windowMs - (now - list[0]) };
  }
  list.push(now);
  windows.set(key, list);
  if (windows.size > 5_000) {
    for (const [k, v] of windows) if (!v.length || now - v[v.length - 1] > windowMs) windows.delete(k);
  }
  return { ok: true, retryAfterMs: 0 };
}

export function resetRateLimits() {
  windows.clear();
}

export async function incrementDaily(db: Queryable, key: string, by = 1, day = toIsoDate(new Date())): Promise<number> {
  const res = await db.execute<{ count: number }>(sql`
    INSERT INTO usage_counters (key, day, count) VALUES (${key}, ${day}, ${by})
    ON CONFLICT (key, day) DO UPDATE SET count = usage_counters.count + ${by}
    RETURNING count`);
  return res.rows[0]?.count ?? by;
}

export async function dailyCount(db: Queryable, key: string, day = toIsoDate(new Date())): Promise<number> {
  const rows = await db
    .select({ count: s.usageCounters.count })
    .from(s.usageCounters)
    .where(and(eq(s.usageCounters.key, key), eq(s.usageCounters.day, day)));
  return rows[0]?.count ?? 0;
}
