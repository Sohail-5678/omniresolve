/**
 * The tool boundary. Every state-changing mock API call (refund, store credit, return
 * label, replacement) runs through `guardedExecute`, which — inside ONE transaction —
 * returns a stored response for a repeated idempotency key, or else locks the approval
 * token, verifies signature/scope/amount/expiry/status, performs the action and marks
 * the token consumed. No token, no state change: this is what actually prevents
 * unauthorized money movement, even if a prompt injection fully controls the planner.
 */
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import * as s from "@/db/schema";
import { GuardError } from "@/lib/util/errors";
import { signatureValid, type TokenAction, type TokenPayload } from "./approval-token";

export type GuardScope = {
  sandboxId: string;
  threadId: string;
  action: TokenAction;
  orderId: string | null;
  amountCents: number | null;
  sku?: string | null;
  qty?: number | null;
};

export type GuardOutcome<T> = { result: T; replayed: boolean; tokenId: string | null };

async function loadAndVerify(tx: Tx, tokenId: string | null | undefined, scope: GuardScope, nowMs: number) {
  if (!tokenId) throw new GuardError("TOKEN_MISSING", "No approval token was attached to this call.");
  const rows = await tx
    .select()
    .from(s.approvalTokens)
    .where(and(eq(s.approvalTokens.tokenId, tokenId), eq(s.approvalTokens.sandboxId, scope.sandboxId)))
    .for("update");
  const row = rows[0];
  if (!row) throw new GuardError("TOKEN_MISSING", "Approval token not found for this sandbox.");
  const payload = row.payload as unknown as TokenPayload;
  if (!signatureValid(payload, row.signature)) {
    throw new GuardError("TOKEN_BAD_SIGNATURE", "Approval token signature does not verify.");
  }
  if (payload.sandboxId !== scope.sandboxId || payload.threadId !== scope.threadId || payload.action !== scope.action) {
    throw new GuardError("TOKEN_SCOPE_MISMATCH", "Token was issued for a different sandbox, thread or action.");
  }
  if ((payload.orderId ?? null) !== (scope.orderId ?? null)) {
    throw new GuardError("TOKEN_SCOPE_MISMATCH", "Token was issued for a different order.");
  }
  if ((payload.sku ?? null) !== (scope.sku ?? null) || (payload.qty ?? null) !== (scope.qty ?? null)) {
    throw new GuardError("TOKEN_SCOPE_MISMATCH", "Token was issued for a different item or quantity.");
  }
  if ((payload.amountCents ?? null) !== (scope.amountCents ?? null)) {
    throw new GuardError("TOKEN_AMOUNT_MISMATCH", "Amount does not match the approved amount.");
  }
  if (row.status === "consumed") throw new GuardError("TOKEN_ALREADY_USED", "Approval token was already used.");
  if (row.status === "revoked") throw new GuardError("TOKEN_REVOKED", "Approval token was revoked.");
  if (row.status !== "issued") throw new GuardError("TOKEN_EXPIRED", "Approval token is no longer valid.");
  if (payload.expiresAt * 1000 < nowMs) throw new GuardError("TOKEN_EXPIRED", "Approval token has expired.");
  return { row, payload };
}

/**
 * Idempotency first (a retried, already-committed call returns its stored response),
 * then token verification, the action, and token consumption — all in one transaction.
 */
export async function guardedExecute<T extends Record<string, unknown>>(
  db: Db,
  opts: { scope: GuardScope; tokenId: string | null | undefined; idempotencyKey: string; operation: string; nowMs?: number },
  action: (tx: Tx, token: TokenPayload) => Promise<T>,
): Promise<GuardOutcome<T>> {
  return db.transaction(async (tx) => {
    const prior = await tx
      .select({ response: s.idempotencyKeys.response })
      .from(s.idempotencyKeys)
      .where(and(eq(s.idempotencyKeys.key, opts.idempotencyKey), eq(s.idempotencyKeys.sandboxId, opts.scope.sandboxId)));
    if (prior[0]) return { result: prior[0].response as T, replayed: true, tokenId: opts.tokenId ?? null };

    const { payload } = await loadAndVerify(tx, opts.tokenId, opts.scope, opts.nowMs ?? Date.now());
    const result = await action(tx, payload);
    await tx
      .update(s.approvalTokens)
      .set({ status: "consumed", consumedAt: new Date() })
      .where(eq(s.approvalTokens.tokenId, payload.tokenId));
    await tx.insert(s.idempotencyKeys).values({
      key: opts.idempotencyKey,
      sandboxId: opts.scope.sandboxId,
      operation: opts.operation,
      response: result,
    });
    return { result, replayed: false, tokenId: payload.tokenId };
  });
}

/**
 * Verify-only check for preparatory steps (e.g. reserving inventory for an approved
 * replacement): the token must be valid and unused, but is not consumed here.
 */
export async function verifyTokenOnly(tx: Tx, tokenId: string | null | undefined, scope: GuardScope, nowMs = Date.now()) {
  const { payload } = await loadAndVerify(tx, tokenId, scope, nowMs);
  return payload;
}
