/**
 * Visitor sandboxes and the signed session cookie that names them.
 * The sandbox ID used by every query comes from this cookie (HMAC-signed, httpOnly),
 * never from a request body, so one visitor cannot address another visitor's data.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { secret } from "@/config/env";
import { hmacHex, safeEqualHex, sha256Hex } from "@/lib/util/canonical";
import { cloneTemplateInto, ensureTemplate } from "@/lib/seed/template";
import { SEED_VERSION } from "@/lib/seed/generate";

export const SESSION_COOKIE = "or_session";

export type SessionPayload = { sid: string; exp: number };

export function newSandboxId(): string {
  return `sb_${randomBytes(9).toString("base64url")}`;
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacHex(body, secret("SESSION_SECRET"))}`;
}

export function verifySession(cookie: string | undefined | null): SessionPayload | null {
  if (!cookie) return null;
  const [body, sig] = cookie.split(".");
  if (!body || !sig) return null;
  if (!safeEqualHex(sig, hmacHex(body, secret("SESSION_SECRET")))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.sid !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashIp(ip: string): string {
  return sha256Hex(`${ip}|${secret("SESSION_SECRET")}`).slice(0, 24);
}

export async function createSandbox(db: Db, opts: { ipHash?: string; id?: string } = {}) {
  await ensureTemplate(db);
  const id = opts.id ?? newSandboxId();
  const expiresAt = new Date(Date.now() + AGENT.sandboxTtlMs);
  await db.transaction(async (tx) => {
    await tx.insert(s.sandboxes).values({ id, expiresAt, ipHash: opts.ipHash ?? null, seedVersion: SEED_VERSION });
    await cloneTemplateInto(tx, id);
  });
  return { id, expiresAt };
}

export async function sandboxIsLive(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: s.sandboxes.id })
    .from(s.sandboxes)
    .where(and(eq(s.sandboxes.id, id), gt(s.sandboxes.expiresAt, new Date()), eq(s.sandboxes.isTemplate, false)));
  return rows.length > 0;
}

export async function deleteSandbox(db: Db, id: string) {
  await db.delete(s.sandboxes).where(and(eq(s.sandboxes.id, id), eq(s.sandboxes.isTemplate, false)));
}

/** Deletes expired sandboxes (cascades to all their rows). Returns the thread IDs removed. */
export async function cleanupExpired(db: Db): Promise<{ sandboxes: number; threadIds: string[] }> {
  const expired = await db
    .select({ id: s.sandboxes.id })
    .from(s.sandboxes)
    .where(and(lt(s.sandboxes.expiresAt, new Date()), eq(s.sandboxes.isTemplate, false)));
  if (!expired.length) return { sandboxes: 0, threadIds: [] };
  const ids = expired.map((e) => e.id);
  const threadRows = await db.select({ id: s.threads.id }).from(s.threads).where(inArray(s.threads.sandboxId, ids));
  for (const id of ids) await deleteSandbox(db, id);
  return { sandboxes: ids.length, threadIds: threadRows.map((r) => r.id) };
}
