/**
 * Canonical JSON (recursively sorted keys, no whitespace) and hashing helpers.
 * Used for approval-token payloads, idempotency keys, plan hashes and replay keys,
 * so the same logical value always produces the same bytes.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  // Buffer.from(x, "hex") stops at the first non-hex character, so validate first.
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
