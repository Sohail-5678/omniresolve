/**
 * Approval tokens: single-use, short-lived, HMAC-signed authorizations for exactly one
 * state-changing action (action + order + amount + sandbox + thread). Minted only by the
 * policy gate (auto-approved) or by the HITL node (after a human decision). The LLM never
 * sees them: graph state holds token IDs, the executor attaches them at the tool boundary.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { secret } from "@/config/env";
import { canonicalize, hmacHex, safeEqualHex } from "@/lib/util/canonical";

export type TokenAction = "refund" | "store_credit" | "replacement" | "return_label";

export type TokenPayload = {
  v: 1;
  tokenId: string;
  sandboxId: string;
  threadId: string;
  action: TokenAction;
  orderId: string | null;
  amountCents: number | null;
  sku: string | null;
  qty: number | null;
  currency: "USD";
  policyId: string;
  policyVersion: string;
  approvedBy: string; // "AUTO_GATE" | "supervisor:<sandbox-user>"
  issuedAt: number;
  expiresAt: number;
};

export type MintInput = Omit<TokenPayload, "v" | "tokenId" | "currency" | "issuedAt" | "expiresAt">;

export function signPayload(payload: TokenPayload): string {
  return hmacHex(canonicalize(payload), secret("APPROVAL_SIGNING_SECRET"));
}

export function signatureValid(payload: TokenPayload, signature: string): boolean {
  return safeEqualHex(signPayload(payload), signature);
}

export async function mintToken(db: Queryable, input: MintInput, nowMs = Date.now()): Promise<{ tokenId: string; payload: TokenPayload }> {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: TokenPayload = {
    v: 1,
    tokenId: randomUUID(),
    ...input,
    currency: "USD",
    issuedAt,
    expiresAt: issuedAt + AGENT.tokenTtlSeconds,
  };
  await db.insert(s.approvalTokens).values({
    tokenId: payload.tokenId,
    sandboxId: payload.sandboxId,
    threadId: payload.threadId,
    action: payload.action,
    payload: payload as unknown as Record<string, unknown>,
    signature: signPayload(payload),
    status: "issued",
    issuedAt: new Date(issuedAt * 1000),
    expiresAt: new Date(payload.expiresAt * 1000),
  });
  return { tokenId: payload.tokenId, payload };
}

/** Revokes still-unused tokens for a thread (e.g. after a supervisor rejects). */
export async function revokeIssuedTokens(db: Queryable, sandboxId: string, threadId: string, tokenIds?: string[]) {
  const conds = [eq(s.approvalTokens.sandboxId, sandboxId), eq(s.approvalTokens.threadId, threadId), eq(s.approvalTokens.status, "issued")];
  if (tokenIds?.length) conds.push(inArray(s.approvalTokens.tokenId, tokenIds));
  await db.update(s.approvalTokens).set({ status: "revoked" }).where(and(...conds));
}
