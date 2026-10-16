/**
 * Approval tokens + the tool guard, against the real test database.
 * Every DB test mints into its own fresh sandbox, so tests never depend on order.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { AGENT } from "@/config/agent";
import { resetEnvCache, secret } from "@/config/env";
import { GuardError, type GuardCode } from "@/lib/util/errors";
import { canonicalize, hmacHex, safeEqualHex } from "@/lib/util/canonical";
import { mintToken, revokeIssuedTokens, signPayload, signatureValid, type MintInput, type TokenPayload } from "@/lib/security/approval-token";
import { guardedExecute, verifyTokenOnly, type GuardScope } from "@/lib/security/tool-guard";
import { db, freshSandbox } from "../helpers";

const TTL = AGENT.tokenTtlSeconds;
const thr = () => `thr_${randomUUID().slice(0, 8)}`;
const key = (label = "k") => `test-${label}-${randomUUID()}`;

function refundInput(sandboxId: string, threadId: string, over: Partial<MintInput> = {}): MintInput {
  return {
    sandboxId,
    threadId,
    action: "refund",
    orderId: "ORD-9941",
    amountCents: 32000,
    sku: null,
    qty: null,
    policyId: "POL-REFUND",
    policyVersion: "2026.10",
    approvedBy: "AUTO_GATE",
    ...over,
  };
}

function replacementInput(sandboxId: string, threadId: string, over: Partial<MintInput> = {}): MintInput {
  return refundInput(sandboxId, threadId, { action: "replacement", amountCents: null, sku: "GLS-AUR-01", qty: 1, ...over });
}

function scopeOf(p: Pick<TokenPayload, "sandboxId" | "threadId" | "action" | "orderId" | "amountCents" | "sku" | "qty">, over: Partial<GuardScope> = {}): GuardScope {
  return { sandboxId: p.sandboxId, threadId: p.threadId, action: p.action, orderId: p.orderId, amountCents: p.amountCents, sku: p.sku, qty: p.qty, ...over };
}

async function tokenRow(tokenId: string) {
  const rows = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.tokenId, tokenId));
  return rows[0];
}

async function idemRows(sandboxId: string, k: string) {
  return db().select().from(s.idempotencyKeys).where(and(eq(s.idempotencyKeys.sandboxId, sandboxId), eq(s.idempotencyKeys.key, k)));
}

/** Any idempotency row for this key, in any sandbox. */
async function idemRowsAnySandbox(k: string) {
  return db().select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.key, k));
}

async function setTokenColumns(tokenId: string, values: Partial<typeof s.approvalTokens.$inferInsert>) {
  await db().update(s.approvalTokens).set(values).where(eq(s.approvalTokens.tokenId, tokenId));
}

async function refundRows(sandboxId: string, refundId: string) {
  return db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sandboxId), eq(s.refunds.id, refundId)));
}

/** An action that writes a real refund row inside the guard's transaction. */
function writeRefund(sandboxId: string, refundId: string, calls: TokenPayload[] = []) {
  return async (tx: Tx, token: TokenPayload) => {
    calls.push(token);
    await tx.insert(s.refunds).values({
      sandboxId,
      id: refundId,
      orderId: token.orderId ?? "NONE",
      amountCents: token.amountCents ?? 0,
      reason: "test",
      tokenId: token.tokenId,
    });
    return { refundId, amountCents: token.amountCents, status: "succeeded" };
  };
}

async function expectGuard(p: Promise<unknown>, code: GuardCode): Promise<GuardError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected GuardError ${code}`).toBeInstanceOf(GuardError);
  expect((err as GuardError).code).toBe(code);
  expect((err as GuardError).name).toBe("GuardError");
  return err as GuardError;
}

/**
 * Runs guardedExecute and asserts it is rejected with `code` without ever calling the action,
 * without recording the idempotency key, and without changing the token row in any way.
 */
async function expectRejected(scope: GuardScope, tokenId: string | null | undefined, code: GuardCode, nowMs?: number) {
  const before = tokenId ? await tokenRow(tokenId) : undefined;
  const k = key("rej");
  let called = 0;
  const err = await expectGuard(
    guardedExecute(db(), { scope, tokenId, idempotencyKey: k, operation: "test.op", nowMs }, async () => {
      called++;
      return { ok: true };
    }),
    code,
  );
  expect(called).toBe(0);
  expect(await idemRowsAnySandbox(k)).toHaveLength(0);
  if (before) {
    const after = await tokenRow(tokenId!);
    expect(after.status).toBe(before.status);
    expect(after.consumedAt?.getTime() ?? null).toBe(before.consumedAt?.getTime() ?? null);
    expect(after.signature).toBe(before.signature);
    expect(after.payload).toEqual(before.payload);
  }
  return err;
}

// ---------------------------------------------------------------------------- canonical helpers
describe("canonicalize", () => {
  it("is independent of key order, recursively", () => {
    const a = { b: 2, a: { z: [3, { y: 1, x: 2 }], c: null }, d: "s" };
    const b = { d: "s", a: { c: null, z: [3, { x: 2, y: 1 }] }, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":null,"z":[3,{"x":2,"y":1}]},"b":2,"d":"s"}');
  });

  it("preserves array order, keeps null, drops undefined, and passes primitives through", () => {
    expect(canonicalize([2, 1, 3])).toBe("[2,1,3]");
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalize({ a: undefined })).toBe(canonicalize({}));
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(new Date("2026-01-02T03:04:05.000Z"))).toBe('"2026-01-02T03:04:05.000Z"');
  });

  it("makes the token signature independent of payload key order (as after a jsonb round trip)", () => {
    const p: TokenPayload = {
      v: 1,
      tokenId: "tok-1",
      sandboxId: "sb_x",
      threadId: "thr_x",
      action: "refund",
      orderId: "ORD-1",
      amountCents: 100,
      sku: null,
      qty: null,
      currency: "USD",
      policyId: "P",
      policyVersion: "1",
      approvedBy: "AUTO_GATE",
      issuedAt: 1000,
      expiresAt: 1000 + TTL,
    };
    const reversed = Object.fromEntries(Object.entries(p).reverse()) as TokenPayload;
    expect(Object.keys(reversed)[0]).toBe("expiresAt");
    expect(signPayload(reversed)).toBe(signPayload(p));
    expect(signPayload(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(signatureValid(reversed, signPayload(p))).toBe(true);
    expect(signatureValid({ ...p, amountCents: 101 }, signPayload(p))).toBe(false);
  });

  it("signs exactly HMAC-SHA256(canonical payload, APPROVAL_SIGNING_SECRET)", () => {
    const p: TokenPayload = {
      v: 1,
      tokenId: "tok-2",
      sandboxId: "sb_y",
      threadId: "thr_y",
      action: "replacement",
      orderId: "ORD-2",
      amountCents: null,
      sku: "GLS-AUR-01",
      qty: 1,
      currency: "USD",
      policyId: "P",
      policyVersion: "1",
      approvedBy: "supervisor:demo",
      issuedAt: 2000,
      expiresAt: 2000 + TTL,
    };
    const configured = secret("APPROVAL_SIGNING_SECRET");
    expect(configured.length).toBeGreaterThanOrEqual(32);
    expect(signPayload(p)).toBe(hmacHex(canonicalize(p), configured));
    // Not a plain JSON.stringify (insertion order would leak into the signature) and not keyed by another secret.
    expect(JSON.stringify(p)).not.toBe(canonicalize(p));
    expect(signPayload(p)).not.toBe(hmacHex(JSON.stringify(p), configured));
    expect(signPayload(p)).not.toBe(hmacHex(canonicalize(p), "some-other-secret-some-other-secret-0001"));
    // A number vs a numeric string must sign differently (no type coercion in the canonical form).
    expect(signPayload({ ...p, qty: "1" as unknown as number })).not.toBe(signPayload(p));
  });
});

describe("safeEqualHex", () => {
  const h = hmacHex("payload", "secret-secret-secret-secret-secret!");

  it("accepts identical hex strings", () => {
    expect(safeEqualHex(h, h)).toBe(true);
    expect(safeEqualHex("00ff", "00ff")).toBe(true);
  });

  it("rejects differing, different-length, odd-length and empty inputs", () => {
    const flipped = h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");
    expect(safeEqualHex(h, flipped)).toBe(false);
    expect(safeEqualHex(h, h.slice(0, -2))).toBe(false);
    expect(safeEqualHex("abc", "abc")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
  });

  // BUG (latent, low severity): src/lib/util/canonical.ts safeEqualHex() relies on Buffer.from(x, "hex"),
  // which silently stops at the first non-hex character. Two DIFFERENT equal-length strings that share
  // a valid hex prefix therefore compare equal: safeEqualHex("abzz", "abyy") === true (expected false).
  // Not exploitable through current callers (one side is always a full 64-char HMAC/sha256, so the other
  // side must decode fully to the same length), but the function's contract is wrong.
  it("rejects different strings that only share a valid hex prefix", () => {
    expect(safeEqualHex("abzz", "abyy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------- mint
describe("mintToken", () => {
  it("stores an issued, signed row whose payload round-trips and expires after the TTL", async () => {
    const sb = await freshSandbox();
    const t = thr();
    const now = Date.UTC(2026, 9, 16, 12, 0, 0, 750);
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, t), now);

    const issuedAt = Math.floor(now / 1000);
    expect(issuedAt).toBe(Date.UTC(2026, 9, 16, 12, 0, 0) / 1000);
    expect(tokenId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(payload).toEqual({
      v: 1,
      tokenId,
      sandboxId: sb,
      threadId: t,
      action: "refund",
      orderId: "ORD-9941",
      amountCents: 32000,
      sku: null,
      qty: null,
      currency: "USD",
      policyId: "POL-REFUND",
      policyVersion: "2026.10",
      approvedBy: "AUTO_GATE",
      issuedAt,
      expiresAt: issuedAt + TTL,
    });
    // Tokens are short-lived: exactly 15 minutes.
    expect(payload.expiresAt - payload.issuedAt).toBe(15 * 60);

    const row = await tokenRow(tokenId);
    expect(row.status).toBe("issued");
    expect(row.sandboxId).toBe(sb);
    expect(row.threadId).toBe(t);
    expect(row.action).toBe("refund");
    expect(row.consumedAt).toBeNull();
    expect(row.issuedAt.getTime()).toBe(payload.issuedAt * 1000);
    expect(row.expiresAt.getTime()).toBe(payload.expiresAt * 1000);
    expect(row.payload).toEqual(payload);
    expect(row.signature).toBe(signPayload(payload));
    expect(signatureValid(row.payload as unknown as TokenPayload, row.signature)).toBe(true);

    // Every mint gets a fresh id, even for identical input at the same instant.
    const again = await mintToken(db(), refundInput(sb, t), now);
    expect(again.tokenId).not.toBe(tokenId);
    expect(again.payload).toEqual({ ...payload, tokenId: again.tokenId });
    expect((await tokenRow(again.tokenId)).signature).not.toBe(row.signature);
  });
});

// ---------------------------------------------------------------------------- guardedExecute
describe("guardedExecute", () => {
  it("verifies, runs the action and consumes the token in the same transaction", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const k = key("ok");
    const refundId = `RF-T-${randomUUID().slice(0, 6)}`;
    let statusSeenInsideTx: string | undefined;

    const before = Date.now();
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: k, operation: "billing.refund" }, async (tx, token) => {
      expect(token).toEqual(payload);
      const r = await tx.select({ status: s.approvalTokens.status }).from(s.approvalTokens).where(eq(s.approvalTokens.tokenId, tokenId));
      statusSeenInsideTx = r[0].status;
      return writeRefund(sb, refundId)(tx, token);
    });

    expect(statusSeenInsideTx).toBe("issued");
    expect(out).toEqual({ result: { refundId, amountCents: 32000, status: "succeeded" }, replayed: false, tokenId });

    const after = Date.now();
    const row = await tokenRow(tokenId);
    expect(row.status).toBe("consumed");
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.consumedAt!.getTime()).toBeLessThanOrEqual(after + 5_000);
    // Consumption touches only status/consumedAt: the signed payload is intact.
    expect(row.payload).toEqual(payload);
    expect(row.signature).toBe(signPayload(payload));

    const idem = await idemRows(sb, k);
    expect(idem).toHaveLength(1);
    expect(idem[0].operation).toBe("billing.refund");
    expect(idem[0].response).toEqual({ refundId, amountCents: 32000, status: "succeeded" });

    const refunds = await refundRows(sb, refundId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].tokenId).toBe(tokenId);
    expect(refunds[0].amountCents).toBe(32000);
  });

  it("rejects reuse of a consumed token with TOKEN_ALREADY_USED", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const first = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("first"), operation: "billing.refund" }, async () => ({ n: 1 }));
    expect(first).toEqual({ result: { n: 1 }, replayed: false, tokenId });
    const consumedAt = (await tokenRow(tokenId)).consumedAt!.getTime();
    // A fresh idempotency key does not launder a spent token (expectRejected uses a new key each time).
    const err = await expectRejected(scopeOf(payload), tokenId, "TOKEN_ALREADY_USED");
    expect(err.message).toMatch(/already used/i);
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_ALREADY_USED");
    const row = await tokenRow(tokenId);
    expect(row.status).toBe("consumed");
    expect(row.consumedAt!.getTime()).toBe(consumedAt);
  });

  it("consumes only the presented token: an identical sibling token stays issued and spendable", async () => {
    const sb = await freshSandbox();
    const t = thr();
    const a = await mintToken(db(), refundInput(sb, t));
    const b = await mintToken(db(), refundInput(sb, t));
    const sbOther = await freshSandbox();
    const other = await mintToken(db(), refundInput(sbOther, t));

    await guardedExecute(db(), { scope: scopeOf(a.payload), tokenId: a.tokenId, idempotencyKey: key("a"), operation: "t" }, async () => ({ ok: 1 }));
    expect((await tokenRow(a.tokenId)).status).toBe("consumed");
    for (const id of [b.tokenId, other.tokenId]) {
      const row = await tokenRow(id);
      expect(row.status).toBe("issued");
      expect(row.consumedAt).toBeNull();
    }

    const out = await guardedExecute(db(), { scope: scopeOf(b.payload), tokenId: b.tokenId, idempotencyKey: key("b"), operation: "t" }, async (_tx, tok) => ({ id: tok.tokenId }));
    expect(out).toEqual({ result: { id: b.tokenId }, replayed: false, tokenId: b.tokenId });
    expect((await tokenRow(other.tokenId)).status).toBe("issued");
  });

  it("rejects a payload tampered in the DB row with TOKEN_BAD_SIGNATURE (old or new amount)", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const forged = { ...payload, amountCents: 999_999 };
    await db().update(s.approvalTokens).set({ payload: forged as unknown as Record<string, unknown> }).where(eq(s.approvalTokens.tokenId, tokenId));

    await expectRejected(scopeOf(forged), tokenId, "TOKEN_BAD_SIGNATURE");
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_BAD_SIGNATURE");
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("rejects a payload whose scope fields were swapped and re-signed with the wrong secret", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const forged = { ...payload, orderId: "ORD-0001" };
    const forgedSig = hmacHex(canonicalize(forged), "attacker-guess-attacker-guess-attacker!!");
    await db()
      .update(s.approvalTokens)
      .set({ payload: forged as unknown as Record<string, unknown>, signature: forgedSig })
      .where(eq(s.approvalTokens.tokenId, tokenId));
    await expectRejected(scopeOf(forged), tokenId, "TOKEN_BAD_SIGNATURE");
  });

  // Every field of the payload is covered by the signature: tamper one at a time (the scope is made to
  // agree with the forgery, so only the signature check can stop it).
  it.each<[string, (p: TokenPayload) => Record<string, unknown>]>([
    ["v", (p) => ({ ...p, v: 2 })],
    ["tokenId", (p) => ({ ...p, tokenId: randomUUID() })],
    ["sandboxId", (p) => ({ ...p, sandboxId: "sb_forged" })],
    ["threadId", (p) => ({ ...p, threadId: "thr_forged" })],
    ["action", (p) => ({ ...p, action: "store_credit" })],
    ["orderId", (p) => ({ ...p, orderId: "ORD-0001" })],
    ["amountCents (by one cent)", (p) => ({ ...p, amountCents: (p.amountCents ?? 0) - 1 })],
    ["amountCents (as a string)", (p) => ({ ...p, amountCents: String(p.amountCents) })],
    ["sku", (p) => ({ ...p, sku: "GLS-AUR-01" })],
    ["qty", (p) => ({ ...p, qty: 5 })],
    ["currency", (p) => ({ ...p, currency: "EUR" })],
    ["policyId", (p) => ({ ...p, policyId: "POL-FORGED" })],
    ["policyVersion", (p) => ({ ...p, policyVersion: "1999.01" })],
    ["approvedBy", (p) => ({ ...p, approvedBy: "supervisor:attacker" })],
    ["issuedAt", (p) => ({ ...p, issuedAt: p.issuedAt + 3600 })],
    ["expiresAt (extended)", (p) => ({ ...p, expiresAt: p.expiresAt + 86_400 })],
    ["an added field", (p) => ({ ...p, bonus: true })],
    ["a removed field", (p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "policyId"))],
  ])("rejects a DB payload with a tampered %s (original signature kept) as TOKEN_BAD_SIGNATURE", async (_label, forge) => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const forged = forge(payload);
    expect(canonicalize(forged)).not.toBe(canonicalize(payload));
    await setTokenColumns(tokenId, { payload: forged });
    const f = forged as unknown as TokenPayload;
    const scope = scopeOf({ ...f, sandboxId: payload.sandboxId, amountCents: f.amountCents === null ? null : Number(f.amountCents) });
    await expectRejected(scope, tokenId, "TOKEN_BAD_SIGNATURE");
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("binds tokens to the signing secret: rotating it invalidates outstanding tokens", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const original = process.env.APPROVAL_SIGNING_SECRET;
    const rotated = "rotated-signing-secret-rotated-signing-0001";
    try {
      process.env.APPROVAL_SIGNING_SECRET = rotated;
      resetEnvCache();
      expect(secret("APPROVAL_SIGNING_SECRET")).toBe(rotated);
      expect(signPayload(payload)).not.toBe((await tokenRow(tokenId)).signature);
      await expectRejected(scopeOf(payload), tokenId, "TOKEN_BAD_SIGNATURE");
    } finally {
      if (original === undefined) delete process.env.APPROVAL_SIGNING_SECRET;
      else process.env.APPROVAL_SIGNING_SECRET = original;
      resetEnvCache();
    }
    expect(secret("APPROVAL_SIGNING_SECRET")).not.toBe(rotated);
    // Back under the original secret the same token verifies and can be spent.
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("rot"), operation: "t" }, async () => ({ ok: 1 }));
    expect(out.tokenId).toBe(tokenId);
  });

  it.each([
    ["one flipped hex digit", (sig: string) => sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a")],
    ["truncated", (sig: string) => sig.slice(0, 62)],
    ["empty", () => ""],
    ["non-hex of the same length", (sig: string) => "zz" + sig.slice(2)],
    ["upper-case copy with one byte changed", (sig: string) => (sig.slice(0, -2) + (sig.endsWith("00") ? "11" : "00")).toUpperCase()],
  ])("rejects a tampered signature (%s) with TOKEN_BAD_SIGNATURE", async (_label, tamper) => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const row = await tokenRow(tokenId);
    await db().update(s.approvalTokens).set({ signature: tamper(row.signature) }).where(eq(s.approvalTokens.tokenId, tokenId));
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_BAD_SIGNATURE");
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("rejects a token minted in the past (beyond the TTL) with TOKEN_EXPIRED and leaves it issued", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()), Date.now() - (TTL + 60) * 1000);
    // No nowMs: the guard must fall back to the real clock.
    const err = await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED");
    expect(err.message).toMatch(/expired/i);
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("accepts a token minted a moment ago by the real clock (no nowMs) and rejects it once nowMs passes expiry", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()), Date.now() - (TTL - 60) * 1000);
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED", Date.now() + 120_000);
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("live"), operation: "t" }, async () => ({ ok: 1 }));
    expect(out).toEqual({ result: { ok: 1 }, replayed: false, tokenId });
  });

  it("uses the signed payload's expiry, not the row's unsigned expires_at column", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()), Date.now() - (TTL + 60) * 1000);
    await setTokenColumns(tokenId, { expiresAt: new Date(Date.now() + 86_400_000) });
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED");

    const fresh = await mintToken(db(), refundInput(sb, thr()));
    await setTokenColumns(fresh.tokenId, { expiresAt: new Date(Date.now() - 86_400_000) });
    const out = await guardedExecute(db(), { scope: scopeOf(fresh.payload), tokenId: fresh.tokenId, idempotencyKey: key(), operation: "t" }, async () => ({ ok: 1 }));
    expect(out.tokenId).toBe(fresh.tokenId);
  });

  it("treats the expiry instant as the last valid millisecond", async () => {
    const sb = await freshSandbox();
    // Far from the real clock, so only the explicit nowMs can make these outcomes differ.
    const mintAt = Date.UTC(2020, 0, 2, 12, 0, 0);
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()), mintAt);
    const expiryMs = payload.expiresAt * 1000;
    expect(expiryMs).toBe(mintAt + TTL * 1000);

    await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED", expiryMs + 1);
    await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED", expiryMs + 60_000);
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("edge"), operation: "t", nowMs: expiryMs }, async () => ({ ok: 1 }));
    expect(out).toEqual({ result: { ok: 1 }, replayed: false, tokenId });
    expect((await tokenRow(tokenId)).status).toBe("consumed");
  });

  it.each(["expired", "pending", ""])("rejects a token whose row status is %j (not 'issued') with TOKEN_EXPIRED even inside its TTL", async (status) => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    await setTokenColumns(tokenId, { status });
    const err = await expectRejected(scopeOf(payload), tokenId, "TOKEN_EXPIRED");
    expect(err.message).toMatch(/no longer valid/i);
  });

  it("rejects a different amount with TOKEN_AMOUNT_MISMATCH", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const err = await expectRejected(scopeOf(payload, { amountCents: 32001 }), tokenId, "TOKEN_AMOUNT_MISMATCH");
    expect(err.message).toMatch(/amount/i);
    await expectRejected(scopeOf(payload, { amountCents: 31999 }), tokenId, "TOKEN_AMOUNT_MISMATCH");
    await expectRejected(scopeOf(payload, { amountCents: null }), tokenId, "TOKEN_AMOUNT_MISMATCH");
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("rejects an amount on a token that approved no amount with TOKEN_AMOUNT_MISMATCH", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), replacementInput(sb, thr()));
    await expectRejected(scopeOf(payload, { amountCents: 1 }), tokenId, "TOKEN_AMOUNT_MISMATCH");
  });

  describe("scope mismatch", () => {
    it.each<[string, Partial<GuardScope>]>([
      ["order", { orderId: "ORD-0001" }],
      ["order missing", { orderId: null }],
      ["thread", { threadId: "thr_other" }],
      ["action", { action: "store_credit" }],
    ])("rejects a refund token used for a different %s with TOKEN_SCOPE_MISMATCH", async (_label, over) => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
      await expectRejected(scopeOf(payload, over), tokenId, "TOKEN_SCOPE_MISMATCH");
      expect((await tokenRow(tokenId)).status).toBe("issued");
    });

    it.each<[string, Partial<GuardScope>]>([
      ["sku", { sku: "GLS-OTHER-99" }],
      ["sku missing", { sku: null }],
      ["qty", { qty: 2 }],
      ["qty missing", { qty: undefined }],
      ["action", { action: "return_label" }],
    ])("rejects a replacement token used for a different %s with TOKEN_SCOPE_MISMATCH", async (_label, over) => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), replacementInput(sb, thr()));
      await expectRejected(scopeOf(payload, over), tokenId, "TOKEN_SCOPE_MISMATCH");
    });

    it("does not let a token approved for no order authorize an action on an order", async () => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr(), { action: "store_credit", orderId: null, amountCents: 500 }));
      await expectRejected(scopeOf(payload, { orderId: "ORD-9941" }), tokenId, "TOKEN_SCOPE_MISMATCH");
      const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("sc"), operation: "billing.credit" }, async (_tx, tok) => ({ order: tok.orderId }));
      expect(out.result).toEqual({ order: null });
    });

    it("trusts the signed payload, not the row's unsigned sandbox/thread/action columns", async () => {
      const sbA = await freshSandbox();
      const sbB = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), refundInput(sbA, thr()));

      // Re-labelling the unsigned columns does not re-scope the token.
      await setTokenColumns(tokenId, { action: "store_credit", threadId: "thr_relabelled" });
      await expectRejected(scopeOf(payload, { action: "store_credit", threadId: "thr_relabelled" }), tokenId, "TOKEN_SCOPE_MISMATCH");

      // Moving the row to sandbox B: B finds it but the signed sandboxId still says A; A no longer finds it.
      await setTokenColumns(tokenId, { sandboxId: sbB });
      const err = await expectRejected(scopeOf(payload, { sandboxId: sbB }), tokenId, "TOKEN_SCOPE_MISMATCH");
      expect(err.message).toMatch(/different sandbox, thread or action/i);
      await expectRejected(scopeOf(payload), tokenId, "TOKEN_MISSING");

      // Restored, the token works for exactly its signed scope.
      await setTokenColumns(tokenId, { sandboxId: sbA });
      const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key(), operation: "t" }, async () => ({ ok: 1 }));
      expect(out.tokenId).toBe(tokenId);
    });

    it("rejects an sku/qty on a refund token that approved none", async () => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
      await expectRejected(scopeOf(payload, { sku: "GLS-AUR-01" }), tokenId, "TOKEN_SCOPE_MISMATCH");
      await expectRejected(scopeOf(payload, { qty: 1 }), tokenId, "TOKEN_SCOPE_MISMATCH");
    });

    it("accepts a replacement token for exactly its sku and qty (and omitted sku/qty equal null on refunds)", async () => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), replacementInput(sb, thr()));
      const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key("repl"), operation: "orders.replace" }, async (_tx, tok) => ({ sku: tok.sku, qty: tok.qty }));
      expect(out.result).toEqual({ sku: "GLS-AUR-01", qty: 1 });

      expect((await tokenRow(tokenId)).status).toBe("consumed");

      const r = await mintToken(db(), refundInput(sb, thr()));
      const { sku: _s, qty: _q, ...noItem } = scopeOf(r.payload);
      expect("sku" in noItem || "qty" in noItem).toBe(false);
      const out2 = await guardedExecute(db(), { scope: noItem, tokenId: r.tokenId, idempotencyKey: key("ref"), operation: "billing.refund" }, async () => ({ ok: true }));
      expect(out2).toEqual({ result: { ok: true }, replayed: false, tokenId: r.tokenId });
      expect((await tokenRow(r.tokenId)).status).toBe("consumed");
    });

    it("reports scope mismatch before status, so a consumed token for another order is TOKEN_SCOPE_MISMATCH", async () => {
      const sb = await freshSandbox();
      const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
      await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key(), operation: "t" }, async () => ({ ok: 1 }));
      await expectRejected(scopeOf(payload, { orderId: "ORD-0001" }), tokenId, "TOKEN_SCOPE_MISMATCH");
      await expectRejected(scopeOf(payload), tokenId, "TOKEN_ALREADY_USED");
    });
  });

  it("does not find a token minted in another sandbox (TOKEN_MISSING), and leaves it usable there", async () => {
    const sbA = await freshSandbox();
    const sbB = await freshSandbox();
    const t = thr();
    const { tokenId, payload } = await mintToken(db(), refundInput(sbA, t));
    const err = await expectRejected(scopeOf(payload, { sandboxId: sbB }), tokenId, "TOKEN_MISSING");
    expect(err.message).toMatch(/not found for this sandbox/i);
    expect((await tokenRow(tokenId)).status).toBe("issued");
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key(), operation: "t" }, async () => ({ ok: 1 }));
    expect(out.tokenId).toBe(tokenId);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("rejects a call with no token (%s) with TOKEN_MISSING", async (_label, tokenId) => {
    const sb = await freshSandbox();
    const { tokenId: minted, payload } = await mintToken(db(), refundInput(sb, thr()));
    // Rejected up front ("not attached"), not after a lookup ("not found").
    const err = await expectRejected(scopeOf(payload), tokenId, "TOKEN_MISSING");
    expect(err.message).toMatch(/no approval token was attached/i);
    expect((await tokenRow(minted)).status).toBe("issued");
  });

  it("rejects an unknown token id with TOKEN_MISSING", async () => {
    const sb = await freshSandbox();
    const { payload } = await mintToken(db(), refundInput(sb, thr()));
    const err = await expectRejected(scopeOf(payload), randomUUID(), "TOKEN_MISSING");
    expect(err.message).toMatch(/not found for this sandbox/i);
  });

  it("rejects a revoked token with TOKEN_REVOKED", async () => {
    const sb = await freshSandbox();
    const t = thr();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, t));
    await revokeIssuedTokens(db(), sb, t);
    expect((await tokenRow(tokenId)).status).toBe("revoked");
    const err = await expectRejected(scopeOf(payload), tokenId, "TOKEN_REVOKED");
    expect(err.message).toMatch(/revoked/i);
    // Revocation is terminal: a later revoke call does not resurrect or otherwise change it.
    await revokeIssuedTokens(db(), sb, t);
    expect((await tokenRow(tokenId)).status).toBe("revoked");
  });

  it("revokeIssuedTokens only touches issued tokens of that sandbox+thread (and only the listed ids)", async () => {
    const sb = await freshSandbox();
    const sbOther = await freshSandbox();
    const t = thr();
    const consumed = await mintToken(db(), refundInput(sb, t));
    await guardedExecute(db(), { scope: scopeOf(consumed.payload), tokenId: consumed.tokenId, idempotencyKey: key(), operation: "t" }, async () => ({ ok: 1 }));
    const listed = await mintToken(db(), refundInput(sb, t, { amountCents: 100 }));
    const unlisted = await mintToken(db(), refundInput(sb, t, { amountCents: 200 }));
    const otherThread = await mintToken(db(), refundInput(sb, thr()));
    const otherSandbox = await mintToken(db(), refundInput(sbOther, t));

    await revokeIssuedTokens(db(), sb, t, [listed.tokenId, consumed.tokenId]);
    expect((await tokenRow(listed.tokenId)).status).toBe("revoked");
    expect((await tokenRow(unlisted.tokenId)).status).toBe("issued");
    expect((await tokenRow(consumed.tokenId)).status).toBe("consumed");

    await revokeIssuedTokens(db(), sb, t);
    expect((await tokenRow(unlisted.tokenId)).status).toBe("revoked");
    expect((await tokenRow(consumed.tokenId)).status).toBe("consumed");
    expect((await tokenRow(otherThread.tokenId)).status).toBe("issued");
    expect((await tokenRow(otherSandbox.tokenId)).status).toBe("issued");
  });

  it("rolls back everything when the action throws: token stays issued, no idempotency row, no side effect", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const k = key("boom");
    const refundId = `RF-T-${randomUUID().slice(0, 6)}`;

    const boom = new Error("upstream exploded");
    const err = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: k, operation: "billing.refund" }, async (tx, tok) => {
      await writeRefund(sb, refundId)(tx, tok);
      throw boom;
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);

    const row = await tokenRow(tokenId);
    expect(row.status).toBe("issued");
    expect(row.consumedAt).toBeNull();
    expect(await idemRows(sb, k)).toHaveLength(0);
    expect(await refundRows(sb, refundId)).toHaveLength(0);

    // The same call can then be retried with the same key and token.
    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: k, operation: "billing.refund" }, writeRefund(sb, refundId));
    expect(out.replayed).toBe(false);
    expect((await tokenRow(tokenId)).status).toBe("consumed");
    expect(await refundRows(sb, refundId)).toHaveLength(1);
  });

  it("returns the stored response for a repeated idempotency key without needing the token again", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const k = key("idem");
    const refundId = `RF-T-${randomUUID().slice(0, 6)}`;
    const calls: TokenPayload[] = [];
    const first = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: k, operation: "billing.refund" }, writeRefund(sb, refundId, calls));
    expect(first).toEqual({ result: { refundId, amountCents: 32000, status: "succeeded" }, replayed: false, tokenId });
    const consumedAt = (await tokenRow(tokenId)).consumedAt!.getTime();

    // A fresh, still-issued token presented with the old key is neither verified nor consumed.
    const spare = await mintToken(db(), refundInput(sb, thr()));
    for (const retryToken of [null, undefined, tokenId, spare.tokenId]) {
      const again = await guardedExecute(db(), { scope: scopeOf(payload), tokenId: retryToken, idempotencyKey: k, operation: "billing.refund" }, writeRefund(sb, refundId, calls));
      expect(again).toEqual({ result: first.result, replayed: true, tokenId: retryToken ?? null });
    }
    expect(calls).toHaveLength(1);
    expect(await refundRows(sb, refundId)).toHaveLength(1);
    const idem = await idemRows(sb, k);
    expect(idem).toHaveLength(1);
    expect(idem[0].response).toEqual(first.result);
    const row = await tokenRow(tokenId);
    expect(row.status).toBe("consumed");
    expect(row.consumedAt!.getTime()).toBe(consumedAt);
    expect((await tokenRow(spare.tokenId)).status).toBe("issued");
  });

  it("does not replay another sandbox's stored response for the same idempotency key", async () => {
    const sbA = await freshSandbox();
    const sbB = await freshSandbox();
    const a = await mintToken(db(), refundInput(sbA, thr()));
    const k = key("shared");
    await guardedExecute(db(), { scope: scopeOf(a.payload), tokenId: a.tokenId, idempotencyKey: k, operation: "t" }, async () => ({ owner: "A" }));

    // Without a token, sandbox B must not see A's stored response: it hits the token check instead.
    await expectGuard(
      guardedExecute(db(), { scope: scopeOf(a.payload, { sandboxId: sbB }), tokenId: null, idempotencyKey: k, operation: "t" }, async () => ({ owner: "B" })),
      "TOKEN_MISSING",
    );
  });

  // BUG (latent, low severity): src/lib/security/tool-guard.ts guardedExecute() looks up a prior
  // idempotency key scoped by (key, sandbox_id), but idempotency_keys.key is a GLOBAL primary key
  // (src/db/schema.ts). So when sandbox B reuses a key already stored by sandbox A, the lookup misses,
  // B's action runs, and the final INSERT fails with a unique violation, rolling back B's otherwise
  // valid, authorized action. Expected: per-sandbox keys (PK on (sandbox_id, key)) so B succeeds.
  // Actual: B throws a duplicate-key error and its token stays issued. Production saga keys hash the
  // sandboxId in (src/lib/saga/idempotency.ts), so this is not reachable from the saga today.
  it("lets two sandboxes use the same idempotency key independently", async () => {
    const sbA = await freshSandbox();
    const sbB = await freshSandbox();
    const k = key("collide");
    const a = await mintToken(db(), refundInput(sbA, thr()));
    await guardedExecute(db(), { scope: scopeOf(a.payload), tokenId: a.tokenId, idempotencyKey: k, operation: "t" }, async () => ({ owner: "A" }));

    const b = await mintToken(db(), refundInput(sbB, thr()));
    const out = await guardedExecute(db(), { scope: scopeOf(b.payload), tokenId: b.tokenId, idempotencyKey: k, operation: "t" }, async () => ({ owner: "B" }));
    expect(out).toEqual({ result: { owner: "B" }, replayed: false, tokenId: b.tokenId });
    expect((await tokenRow(b.tokenId)).status).toBe("consumed");
  });

  it("lets exactly one of two concurrent calls with the same token succeed", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    let actions = 0;
    const run = (k: string) =>
      guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: k, operation: "t" }, async () => {
        actions++;
        await new Promise((r) => setTimeout(r, 150));
        return { k };
      });
    const k1 = key("c1");
    const k2 = key("c2");
    const results = await Promise.allSettled([run(k1), run(k2)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof run>>> => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(GuardError);
    expect((bad[0].reason as GuardError).code).toBe("TOKEN_ALREADY_USED");
    expect(actions).toBe(1);
    expect((await tokenRow(tokenId)).status).toBe("consumed");
    // Only the winner's idempotency key was recorded.
    const winnerKey = ok[0].value.result.k;
    expect([k1, k2]).toContain(winnerKey);
    expect(await idemRows(sb, winnerKey)).toHaveLength(1);
    expect(await idemRows(sb, winnerKey === k1 ? k2 : k1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------- verifyTokenOnly
describe("verifyTokenOnly", () => {
  it("validates without consuming, so the token can still be spent afterwards", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), replacementInput(sb, thr()));

    const p1 = await db().transaction((tx) => verifyTokenOnly(tx, tokenId, scopeOf(payload)));
    const p2 = await db().transaction((tx) => verifyTokenOnly(tx, tokenId, scopeOf(payload)));
    expect(p1).toEqual(payload);
    expect(p2).toEqual(payload);
    const row = await tokenRow(tokenId);
    expect(row.status).toBe("issued");
    expect(row.consumedAt).toBeNull();

    const out = await guardedExecute(db(), { scope: scopeOf(payload), tokenId, idempotencyKey: key(), operation: "orders.replace" }, async () => ({ ok: 1 }));
    expect(out.replayed).toBe(false);
    await expectGuard(
      db().transaction((tx) => verifyTokenOnly(tx, tokenId, scopeOf(payload))),
      "TOKEN_ALREADY_USED",
    );
  });

  it("applies the same checks as guardedExecute (missing, scope, amount, expiry)", async () => {
    const sb = await freshSandbox();
    const { tokenId, payload } = await mintToken(db(), refundInput(sb, thr()));
    const v = (id: string | null, scope: GuardScope, nowMs?: number) => db().transaction((tx) => verifyTokenOnly(tx, id, scope, nowMs));
    await expectGuard(v(null, scopeOf(payload)), "TOKEN_MISSING");
    await expectGuard(v(tokenId, scopeOf(payload, { orderId: "ORD-0001" })), "TOKEN_SCOPE_MISMATCH");
    await expectGuard(v(tokenId, scopeOf(payload, { amountCents: 1 })), "TOKEN_AMOUNT_MISMATCH");
    await expectGuard(v(tokenId, scopeOf(payload), (payload.expiresAt + 1) * 1000), "TOKEN_EXPIRED");
    expect(await v(tokenId, scopeOf(payload), payload.expiresAt * 1000)).toEqual(payload);
    expect((await tokenRow(tokenId)).status).toBe("issued");
  });

  it("also rejects tampered, foreign-sandbox, revoked and (by the real clock) expired tokens", async () => {
    const sb = await freshSandbox();
    const sbOther = await freshSandbox();
    const t = thr();
    const v = (id: string, scope: GuardScope) => db().transaction((tx) => verifyTokenOnly(tx, id, scope));

    const tampered = await mintToken(db(), refundInput(sb, t));
    await setTokenColumns(tampered.tokenId, { signature: "00".repeat(32) });
    await expectGuard(v(tampered.tokenId, scopeOf(tampered.payload)), "TOKEN_BAD_SIGNATURE");

    const foreign = await mintToken(db(), refundInput(sb, t));
    await expectGuard(v(foreign.tokenId, scopeOf(foreign.payload, { sandboxId: sbOther })), "TOKEN_MISSING");

    const revoked = await mintToken(db(), refundInput(sb, t));
    await revokeIssuedTokens(db(), sb, t, [revoked.tokenId]);
    await expectGuard(v(revoked.tokenId, scopeOf(revoked.payload)), "TOKEN_REVOKED");

    // No nowMs: verifyTokenOnly must default to the real clock.
    const stale = await mintToken(db(), refundInput(sb, t), Date.now() - (TTL + 60) * 1000);
    await expectGuard(v(stale.tokenId, scopeOf(stale.payload)), "TOKEN_EXPIRED");

    expect((await tokenRow(foreign.tokenId)).status).toBe("issued");
    expect((await tokenRow(stale.tokenId)).status).toBe("issued");
  });
});
