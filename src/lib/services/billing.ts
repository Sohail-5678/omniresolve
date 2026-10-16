/**
 * Mock Billing API (labeled MOCK SERVICE). Ledger reads, refunds and store credits.
 * refund and issueStoreCredit only run through the tool guard (approval token +
 * idempotency key, one transaction). The mock also refuses to refund more than was
 * paid — a second, independent line of defence behind the policy gate.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { ServiceError } from "@/lib/util/errors";
import { guardedExecute } from "@/lib/security/tool-guard";
import { callService, nextId, type ServiceCtx } from "./core";

/** Ledger for every order of one customer (charges, refunds) plus their store credits. */
export async function getLedger(ctx: ServiceCtx, customerId: string) {
  return callService(
    ctx,
    "billing",
    "getLedger",
    async () => {
      const ownOrders = ctx.db
        .select({ id: s.orders.id })
        .from(s.orders)
        .where(
          and(
            eq(s.orders.sandboxId, ctx.sandboxId),
            eq(s.orders.customerId, customerId),
          ),
        );
      const charges = await ctx.db
        .select()
        .from(s.charges)
        .where(
          and(
            eq(s.charges.sandboxId, ctx.sandboxId),
            inArray(s.charges.orderId, ownOrders),
          ),
        );
      const refunds = await ctx.db
        .select()
        .from(s.refunds)
        .where(
          and(
            eq(s.refunds.sandboxId, ctx.sandboxId),
            inArray(s.refunds.orderId, ownOrders),
          ),
        );
      const credits = await ctx.db
        .select()
        .from(s.storeCredits)
        .where(
          and(
            eq(s.storeCredits.sandboxId, ctx.sandboxId),
            eq(s.storeCredits.customerId, customerId),
          ),
        );
      return {
        charges: charges
          .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
          .map((c) => ({
            chargeId: c.id,
            orderId: c.orderId,
            amountCents: c.amountCents,
            capturedAt: c.capturedAt.toISOString(),
          })),
        refunds: refunds.map((r) => ({
          refundId: r.id,
          orderId: r.orderId,
          amountCents: r.amountCents,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
        })),
        storeCredits: credits.map((c) => ({
          creditId: c.id,
          orderId: c.orderId,
          amountCents: c.amountCents,
          reason: c.reason,
          createdAt: c.createdAt.toISOString(),
        })),
      };
    },
    (r) => ({
      entries: r.charges.map((c) => ({
        id: c.chargeId,
        amount: (c.amountCents / 100).toFixed(2),
      })),
    }),
  );
}

type MoneyArgs = {
  threadId: string;
  sagaId: string;
  tokenId: string | null;
  idempotencyKey: string;
};

export async function refund(
  ctx: ServiceCtx,
  args: MoneyArgs & { orderId: string; amountCents: number; reason: string },
) {
  return callService(
    ctx,
    "billing",
    "refund",
    async () => {
      const out = await guardedExecute(
        ctx.db,
        {
          scope: {
            sandboxId: ctx.sandboxId,
            threadId: args.threadId,
            action: "refund",
            orderId: args.orderId,
            amountCents: args.amountCents,
          },
          tokenId: args.tokenId,
          idempotencyKey: args.idempotencyKey,
          operation: "billing.refund",
        },
        async (tx, token) => {
          // Serialize refunds per order: two threads with two valid tokens must not both pass
          // the balance check before either inserts.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`refund|${ctx.sandboxId}|${args.orderId}`}))`,
          );
          const paid = await tx.execute<{ paid: number; refunded: number }>(sql`
            SELECT
              COALESCE((SELECT sum(amount_cents) FROM charges WHERE sandbox_id = ${ctx.sandboxId} AND order_id = ${args.orderId}), 0)::int AS paid,
              COALESCE((SELECT sum(amount_cents) FROM refunds WHERE sandbox_id = ${ctx.sandboxId} AND order_id = ${args.orderId}), 0)::int AS refunded`);
          const { paid: p, refunded: r } = paid.rows[0] ?? {
            paid: 0,
            refunded: 0,
          };
          if (args.amountCents > p - r) {
            throw new ServiceError(
              422,
              "INVALID",
              `refund ${args.amountCents} exceeds refundable balance ${p - r}`,
            );
          }
          const refundId = await nextId(tx, ctx.sandboxId, "RF");
          await tx.insert(s.refunds).values({
            sandboxId: ctx.sandboxId,
            id: refundId,
            orderId: args.orderId,
            amountCents: args.amountCents,
            reason: args.reason,
            tokenId: token.tokenId,
            sagaId: args.sagaId,
            idempotencyKey: args.idempotencyKey,
          });
          return {
            refundId,
            orderId: args.orderId,
            amountCents: args.amountCents,
            status: "succeeded" as const,
          };
        },
      );
      return { ...out.result, replayed: out.replayed };
    },
    (r) => ({
      refund_id: r.refundId,
      amount: (r.amountCents / 100).toFixed(2),
      state: "ok",
    }),
  );
}

/** Read used by the saga to reconcile an unknown outcome (e.g. schema drift on the pivot). */
export async function findRefundByKey(ctx: ServiceCtx, idempotencyKey: string) {
  const rows = await ctx.db
    .select()
    .from(s.refunds)
    .where(
      and(
        eq(s.refunds.sandboxId, ctx.sandboxId),
        eq(s.refunds.idempotencyKey, idempotencyKey),
      ),
    );
  return rows[0] ?? null;
}

export async function findCreditByKey(ctx: ServiceCtx, idempotencyKey: string) {
  const rows = await ctx.db
    .select()
    .from(s.storeCredits)
    .where(
      and(
        eq(s.storeCredits.sandboxId, ctx.sandboxId),
        eq(s.storeCredits.idempotencyKey, idempotencyKey),
      ),
    );
  return rows[0] ?? null;
}

export async function issueStoreCredit(
  ctx: ServiceCtx,
  args: MoneyArgs & {
    customerId: string;
    orderId: string | null;
    amountCents: number;
    reason: string;
  },
) {
  return callService(
    ctx,
    "billing",
    "issueStoreCredit",
    async () => {
      const out = await guardedExecute(
        ctx.db,
        {
          scope: {
            sandboxId: ctx.sandboxId,
            threadId: args.threadId,
            action: "store_credit",
            orderId: args.orderId,
            amountCents: args.amountCents,
          },
          tokenId: args.tokenId,
          idempotencyKey: args.idempotencyKey,
          operation: "billing.issueStoreCredit",
        },
        async (tx, token) => {
          const creditId = await nextId(tx, ctx.sandboxId, "SC");
          await tx.insert(s.storeCredits).values({
            sandboxId: ctx.sandboxId,
            id: creditId,
            customerId: args.customerId,
            orderId: args.orderId,
            amountCents: args.amountCents,
            reason: args.reason,
            tokenId: token.tokenId,
            sagaId: args.sagaId,
            idempotencyKey: args.idempotencyKey,
          });
          return {
            creditId,
            amountCents: args.amountCents,
            status: "issued" as const,
          };
        },
      );
      return { ...out.result, replayed: out.replayed };
    },
    (r) => ({ credit: r.creditId, value: (r.amountCents / 100).toFixed(2) }),
  );
}
