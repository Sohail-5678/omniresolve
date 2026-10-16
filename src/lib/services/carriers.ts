/**
 * Mock carrier APIs, "Carrier A" and "Carrier B" (labeled MOCK SERVICE). Tracking reads,
 * return labels (guarded by the return_label token) and label voiding (compensation).
 * Each carrier is a separate fault target, so Carrier A can be "down" while B works.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Queryable } from "@/db/client";
import { AGENT } from "@/config/agent";
import { guardedExecute } from "@/lib/security/tool-guard";
import { callService, nextId, type ServiceCtx } from "./core";

export type Carrier = "carrier_a" | "carrier_b";

/** Tracking for every shipment this carrier handled for one customer's orders. */
export async function getTracking(ctx: ServiceCtx, carrier: Carrier, customerId: string) {
  return callService(
    ctx,
    carrier,
    "getTracking",
    async () => {
      const ownOrders = ctx.db
        .select({ id: s.orders.id })
        .from(s.orders)
        .where(and(eq(s.orders.sandboxId, ctx.sandboxId), eq(s.orders.customerId, customerId)));
      const rows = await ctx.db
        .select()
        .from(s.shipments)
        .where(and(eq(s.shipments.sandboxId, ctx.sandboxId), eq(s.shipments.carrier, carrier), inArray(s.shipments.orderId, ownOrders)));
      return {
        shipments: rows.map((r) => ({ orderId: r.orderId, carrier: r.carrier, trackingNo: r.trackingNo, status: r.status, events: r.events })),
      };
    },
    (r) => ({ packages: r.shipments.map((x) => ({ tracking: x.trackingNo })) }),
  );
}

export async function createReturnLabel(
  ctx: ServiceCtx,
  carrier: Carrier,
  args: { threadId: string; sagaId: string; orderId: string; tokenId: string | null; idempotencyKey: string },
) {
  return callService(
    ctx,
    carrier,
    "createReturnLabel",
    async () => {
      const out = await guardedExecute(
        ctx.db,
        {
          scope: { sandboxId: ctx.sandboxId, threadId: args.threadId, action: "return_label", orderId: args.orderId, amountCents: null },
          tokenId: args.tokenId,
          idempotencyKey: args.idempotencyKey,
          operation: `${carrier}.createReturnLabel`,
        },
        async (tx, token) => {
          const labelId = await nextId(tx, ctx.sandboxId, "LBL");
          const n = labelId.split("-")[1];
          const trackingNo = `${carrier === "carrier_a" ? "CA" : "CB"}88${n.padStart(8, "0")}`;
          await tx.insert(s.labels).values({
            sandboxId: ctx.sandboxId,
            id: labelId,
            orderId: args.orderId,
            carrier,
            trackingNo,
            sagaId: args.sagaId,
            tokenId: token.tokenId,
            status: "active",
          });
          return { labelId, carrier, trackingNo, status: "active" as const };
        },
      );
      return { ...out.result, replayed: out.replayed };
    },
    (r) => ({ label: r.labelId, tracking_number: Number(r.trackingNo.slice(2)) }),
  );
}

/** Compensation: voids every active label this saga created with this carrier. */
export async function voidLabel(ctx: ServiceCtx, carrier: Carrier, args: { sagaId: string }) {
  return callService(
    ctx,
    carrier,
    "voidLabel",
    async () => {
      const res = await ctx.db
        .update(s.labels)
        .set({ status: "voided" })
        .where(and(eq(s.labels.sandboxId, ctx.sandboxId), eq(s.labels.sagaId, args.sagaId), eq(s.labels.carrier, carrier), eq(s.labels.status, "active")))
        .returning({ id: s.labels.id });
      return { affected: res.length };
    },
    (r) => ({ voided: String(r.affected) }),
  );
}

// ---------------------------------------------------------------- per-sandbox circuit breaker

export async function breakerOpen(db: Queryable, sandboxId: string, carrier: Carrier): Promise<boolean> {
  const rows = await db
    .select()
    .from(s.breakers)
    .where(and(eq(s.breakers.sandboxId, sandboxId), eq(s.breakers.service, carrier)));
  const b = rows[0];
  return !!b?.openUntil && b.openUntil.getTime() > Date.now();
}

export async function recordCarrierResult(db: Queryable, sandboxId: string, carrier: Carrier, ok: boolean) {
  if (ok) {
    await db.execute(sql`
      INSERT INTO breakers (sandbox_id, service, consecutive_failures, open_until) VALUES (${sandboxId}, ${carrier}, 0, NULL)
      ON CONFLICT (sandbox_id, service) DO UPDATE SET consecutive_failures = 0, open_until = NULL`);
    return;
  }
  const openUntil = new Date(Date.now() + AGENT.breaker.openMs);
  await db.execute(sql`
    INSERT INTO breakers (sandbox_id, service, consecutive_failures, open_until) VALUES (${sandboxId}, ${carrier}, 1, NULL)
    ON CONFLICT (sandbox_id, service) DO UPDATE SET
      consecutive_failures = breakers.consecutive_failures + 1,
      open_until = CASE WHEN breakers.consecutive_failures + 1 >= ${AGENT.breaker.failureThreshold} THEN ${openUntil} ELSE breakers.open_until END`);
}
