/**
 * Mock Order Management API (labeled MOCK SERVICE). Orders, inventory holds and
 * replacement drafts. createReplacementDraft consumes the replacement approval token;
 * reserveInventory only verifies it. Compensations (release/cancel) are idempotent.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { ServiceError } from "@/lib/util/errors";
import { guardedExecute, verifyTokenOnly } from "@/lib/security/tool-guard";
import { callService, idempotent, nextId, notFound, type ServiceCtx } from "./core";

export async function getOrders(ctx: ServiceCtx, customerId: string) {
  return callService(
    ctx,
    "orders",
    "getOrders",
    async () => {
      const orders = await ctx.db
        .select()
        .from(s.orders)
        .where(and(eq(s.orders.sandboxId, ctx.sandboxId), eq(s.orders.customerId, customerId)))
        .orderBy(sql`${s.orders.orderDate} DESC`);
      const ids = orders.map((o) => o.id);
      const items = ids.length
        ? await ctx.db.select().from(s.orderItems).where(and(eq(s.orderItems.sandboxId, ctx.sandboxId), inArray(s.orderItems.orderId, ids)))
        : [];
      const drafts = ids.length
        ? await ctx.db
            .select({ orderId: s.replacementDrafts.orderId, status: s.replacementDrafts.status })
            .from(s.replacementDrafts)
            .where(and(eq(s.replacementDrafts.sandboxId, ctx.sandboxId), inArray(s.replacementDrafts.orderId, ids)))
        : [];
      const labels = ids.length
        ? await ctx.db
            .select({ orderId: s.labels.orderId, status: s.labels.status })
            .from(s.labels)
            .where(and(eq(s.labels.sandboxId, ctx.sandboxId), inArray(s.labels.orderId, ids)))
        : [];
      const skus = [...new Set(items.map((i) => i.sku))];
      const stock = skus.length
        ? await ctx.db.select().from(s.inventory).where(and(eq(s.inventory.sandboxId, ctx.sandboxId), inArray(s.inventory.sku, skus)))
        : [];
      return {
        inventory: Object.fromEntries(stock.map((x) => [x.sku, Math.max(0, x.onHand - x.reserved)])),
        orders: orders.map((o) => ({
          orderId: o.id,
          orderDate: o.orderDate,
          promisedDate: o.promisedDate,
          deliveredDate: o.deliveredDate,
          status: o.status,
          subtotalCents: o.subtotalCents,
          shippingCents: o.shippingCents,
          totalCents: o.totalCents,
          items: items
            .filter((i) => i.orderId === o.id)
            .sort((a, b) => a.line - b.line)
            .map((i) => ({ sku: i.sku, name: i.name, category: i.category, qty: i.qty, unitPriceCents: i.unitPriceCents })),
          replacements: drafts.filter((d) => d.orderId === o.id && d.status === "confirmed").length,
          activeLabels: labels.filter((l) => l.orderId === o.id && l.status === "active").length,
        })),
      };
    },
    (r) => ({ results: r.orders.map((o) => ({ id: o.orderId, total: (o.totalCents / 100).toFixed(2), state: o.status })) }),
  );
}

type GuardCtx = { threadId: string; sagaId: string; tokenId: string | null; idempotencyKey: string };

export async function reserveInventory(ctx: ServiceCtx, args: GuardCtx & { orderId: string; sku: string; qty: number }) {
  return callService(
    ctx,
    "orders",
    "reserveInventory",
    () =>
      ctx.db.transaction(async (tx) => {
        await verifyTokenOnly(tx, args.tokenId, {
          sandboxId: ctx.sandboxId,
          threadId: args.threadId,
          action: "replacement",
          orderId: args.orderId,
          amountCents: null,
          sku: args.sku,
          qty: args.qty,
        });
        return idempotent(tx, ctx.sandboxId, args.idempotencyKey, "orders.reserveInventory", async () => {
          const inv = await tx
            .select()
            .from(s.inventory)
            .where(and(eq(s.inventory.sandboxId, ctx.sandboxId), eq(s.inventory.sku, args.sku)))
            .for("update");
          const row = inv[0];
          if (!row) throw notFound(`sku ${args.sku}`);
          if (row.onHand - row.reserved < args.qty) throw new ServiceError(409, "OUT_OF_STOCK", `${args.sku} is out of stock`);
          const holdId = await nextId(tx, ctx.sandboxId, "HLD");
          await tx.insert(s.inventoryHolds).values({ sandboxId: ctx.sandboxId, id: holdId, sku: args.sku, qty: args.qty, sagaId: args.sagaId, status: "held" });
          await tx
            .update(s.inventory)
            .set({ reserved: row.reserved + args.qty })
            .where(and(eq(s.inventory.sandboxId, ctx.sandboxId), eq(s.inventory.sku, args.sku)));
          return { holdId, sku: args.sku, qty: args.qty, status: "held" as const };
        });
      }),
    (r) => ({ hold_id: r.holdId, quantity: String(r.qty) }),
  );
}

/** Compensation: releases every active hold this saga created. */
export async function releaseInventory(ctx: ServiceCtx, args: { sagaId: string }) {
  return callService(
    ctx,
    "orders",
    "releaseInventory",
    () =>
      ctx.db.transaction(async (tx) => {
        const holds = await tx
          .select()
          .from(s.inventoryHolds)
          .where(and(eq(s.inventoryHolds.sandboxId, ctx.sandboxId), eq(s.inventoryHolds.sagaId, args.sagaId), eq(s.inventoryHolds.status, "held")))
          .for("update");
        for (const h of holds) {
          await tx.execute(sql`UPDATE inventory SET reserved = GREATEST(0, reserved - ${h.qty}) WHERE sandbox_id = ${ctx.sandboxId} AND sku = ${h.sku}`);
          await tx
            .update(s.inventoryHolds)
            .set({ status: "released" })
            .where(and(eq(s.inventoryHolds.sandboxId, ctx.sandboxId), eq(s.inventoryHolds.id, h.id)));
        }
        return { affected: holds.length };
      }),
    (r) => ({ released: String(r.affected) }),
  );
}

export async function createReplacementDraft(
  ctx: ServiceCtx,
  args: GuardCtx & { orderId: string; sku: string; qty: number; holdId: string | null },
) {
  return callService(
    ctx,
    "orders",
    "createReplacementDraft",
    async () => {
      const out = await guardedExecute(
        ctx.db,
        {
          scope: { sandboxId: ctx.sandboxId, threadId: args.threadId, action: "replacement", orderId: args.orderId, amountCents: null, sku: args.sku, qty: args.qty },
          tokenId: args.tokenId,
          idempotencyKey: args.idempotencyKey,
          operation: "orders.createReplacementDraft",
        },
        async (tx, token) => {
          const draftId = await nextId(tx, ctx.sandboxId, "RPL");
          await tx.insert(s.replacementDrafts).values({
            sandboxId: ctx.sandboxId,
            id: draftId,
            orderId: args.orderId,
            sku: args.sku,
            qty: args.qty,
            holdId: args.holdId,
            sagaId: args.sagaId,
            tokenId: token.tokenId,
            status: "draft",
          });
          return { draftId, orderId: args.orderId, sku: args.sku, qty: args.qty, status: "draft" as const };
        },
      );
      return { ...out.result, replayed: out.replayed };
    },
    (r) => ({ draft: r.draftId, line: { sku: r.sku } }),
  );
}

/** Compensation: cancels every open draft this saga created. */
export async function cancelDraft(ctx: ServiceCtx, args: { sagaId: string }) {
  return callService(
    ctx,
    "orders",
    "cancelDraft",
    async () => {
      const res = await ctx.db
        .update(s.replacementDrafts)
        .set({ status: "cancelled" })
        .where(and(eq(s.replacementDrafts.sandboxId, ctx.sandboxId), eq(s.replacementDrafts.sagaId, args.sagaId), eq(s.replacementDrafts.status, "draft")))
        .returning({ id: s.replacementDrafts.id });
      return { affected: res.length };
    },
    (r) => ({ cancelled: String(r.affected) }),
  );
}

/** Post-pivot, retriable: turns the draft into a real replacement and consumes the hold. */
export async function confirmReplacement(ctx: ServiceCtx, args: { sagaId: string; draftId: string; idempotencyKey: string }) {
  return callService(
    ctx,
    "orders",
    "confirmReplacement",
    () =>
      ctx.db.transaction(async (tx) =>
        idempotent(tx, ctx.sandboxId, args.idempotencyKey, "orders.confirmReplacement", async () => {
          const drafts = await tx
            .select()
            .from(s.replacementDrafts)
            .where(and(eq(s.replacementDrafts.sandboxId, ctx.sandboxId), eq(s.replacementDrafts.id, args.draftId), eq(s.replacementDrafts.sagaId, args.sagaId)))
            .for("update");
          const d = drafts[0];
          if (!d) throw notFound(`draft ${args.draftId}`);
          if (d.status === "cancelled") throw new ServiceError(409, "CONFLICT", `draft ${d.id} was cancelled`);
          if (d.status === "draft") {
            await tx
              .update(s.replacementDrafts)
              .set({ status: "confirmed" })
              .where(and(eq(s.replacementDrafts.sandboxId, ctx.sandboxId), eq(s.replacementDrafts.id, d.id)));
            if (d.holdId) {
              const holds = await tx
                .select()
                .from(s.inventoryHolds)
                .where(and(eq(s.inventoryHolds.sandboxId, ctx.sandboxId), eq(s.inventoryHolds.id, d.holdId)));
              const h = holds[0];
              if (h && h.status === "held") {
                await tx.execute(
                  sql`UPDATE inventory SET on_hand = on_hand - ${h.qty}, reserved = GREATEST(0, reserved - ${h.qty}) WHERE sandbox_id = ${ctx.sandboxId} AND sku = ${h.sku}`,
                );
                await tx
                  .update(s.inventoryHolds)
                  .set({ status: "consumed" })
                  .where(and(eq(s.inventoryHolds.sandboxId, ctx.sandboxId), eq(s.inventoryHolds.id, h.id)));
              }
            }
          }
          return { draftId: d.id, status: "confirmed" as const };
        }),
      ),
    (r) => ({ id: r.draftId, confirmed: true }),
  );
}
