/**
 * GET /api/services/:name?customerId=… — read-only views of the MOCK business systems for
 * the Customer 360 sidebar and service cards (this sandbox only). `overview` returns the
 * customer, orders, ledger, shipments, tickets and labels in one call; `customers` lists
 * the sandbox's customers; `health` summarises recent calls per service.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import { json, requireSandbox, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request, ctx: { params: Promise<{ name: string }> }) => {
  const sandboxId = await requireSandbox(req);
  const { name } = await ctx.params;
  const url = new URL(req.url);
  const db = getDb();

  if (name === "customers") {
    const rows = await db
      .select({ id: s.customers.id, name: s.customers.name, tier: s.customers.tier })
      .from(s.customers)
      .where(eq(s.customers.sandboxId, sandboxId))
      .orderBy(asc(s.customers.id))
      .limit(60);
    return json({ customers: rows, badge: "MOCK SERVICE" });
  }

  if (name === "health") {
    const rows = await db.execute<{ service: string; calls: number; failed: number; faulted: number }>(sql`
      SELECT data->'call'->>'service' AS service,
             count(*)::int AS calls,
             count(*) FILTER (WHERE (data->'call'->>'ok')::boolean = false)::int AS failed,
             count(*) FILTER (WHERE (data->'call'->>'faultInjected')::boolean = true)::int AS faulted
      FROM trace_events
      WHERE sandbox_id = ${sandboxId} AND kind = 'service_call' AND created_at > now() - interval '15 minutes'
      GROUP BY 1`);
    return json({ services: rows.rows });
  }

  if (name !== "overview") throw new HttpError(404, "Unknown service view.");
  const customerId = url.searchParams.get("customerId") ?? "";
  if (!/^CUS-\d{4}$/.test(customerId)) throw new HttpError(400, "customerId is required.");
  const cust = await db.select().from(s.customers).where(and(eq(s.customers.sandboxId, sandboxId), eq(s.customers.id, customerId)));
  if (!cust[0]) throw new HttpError(404, "Customer not found.");
  const orders = await db
    .select()
    .from(s.orders)
    .where(and(eq(s.orders.sandboxId, sandboxId), eq(s.orders.customerId, customerId)))
    .orderBy(desc(s.orders.orderDate))
    .limit(12);
  const ids = orders.map((o) => o.id);
  const none = ids.length === 0;
  const [items, charges, refunds, credits, shipments, tickets, labels, drafts, holds, outbox, notes, notifications] = await Promise.all([
    none ? [] : db.select().from(s.orderItems).where(and(eq(s.orderItems.sandboxId, sandboxId), inArray(s.orderItems.orderId, ids))),
    none ? [] : db.select().from(s.charges).where(and(eq(s.charges.sandboxId, sandboxId), inArray(s.charges.orderId, ids))).orderBy(asc(s.charges.capturedAt)),
    none ? [] : db.select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sandboxId), inArray(s.refunds.orderId, ids))).orderBy(asc(s.refunds.createdAt)),
    db.select().from(s.storeCredits).where(and(eq(s.storeCredits.sandboxId, sandboxId), eq(s.storeCredits.customerId, customerId))),
    none ? [] : db.select().from(s.shipments).where(and(eq(s.shipments.sandboxId, sandboxId), inArray(s.shipments.orderId, ids))),
    db.select().from(s.tickets).where(and(eq(s.tickets.sandboxId, sandboxId), eq(s.tickets.customerId, customerId))).orderBy(desc(s.tickets.createdAt)),
    none ? [] : db.select().from(s.labels).where(and(eq(s.labels.sandboxId, sandboxId), inArray(s.labels.orderId, ids))),
    none ? [] : db.select().from(s.replacementDrafts).where(and(eq(s.replacementDrafts.sandboxId, sandboxId), inArray(s.replacementDrafts.orderId, ids))),
    db.select().from(s.inventoryHolds).where(eq(s.inventoryHolds.sandboxId, sandboxId)),
    db.select().from(s.outbox).where(eq(s.outbox.sandboxId, sandboxId)).orderBy(desc(s.outbox.createdAt)).limit(40),
    db.select().from(s.ticketNotes).where(eq(s.ticketNotes.sandboxId, sandboxId)).orderBy(desc(s.ticketNotes.createdAt)).limit(40),
    db.select().from(s.notifications).where(eq(s.notifications.sandboxId, sandboxId)).orderBy(desc(s.notifications.createdAt)).limit(20),
  ]);
  // Outbox rows, notes and notification previews belong to this customer only through their tickets / sagas.
  const ticketIds = new Set(tickets.map((t) => t.id));
  const sagaIds = new Set(tickets.map((t) => t.sagaId).filter(Boolean) as string[]);
  return json({
    badge: "MOCK SERVICE",
    customer: cust[0],
    orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) })),
    ledger: { charges, refunds, storeCredits: credits },
    shipments: shipments.map((x) => ({ ...x })),
    tickets,
    labels,
    replacements: drafts,
    holds: holds.filter((h) => drafts.some((d) => d.holdId === h.id) || (h.status === "held" && sagaIds.has(h.sagaId))),
    outbox: outbox.filter((o) => (o.sagaId && sagaIds.has(o.sagaId)) || ticketIds.has(String((o.payload as { ticketId?: string }).ticketId ?? ""))).slice(0, 10),
    notes: notes.filter((n) => ticketIds.has(n.ticketId)).slice(0, 10),
    notifications: notifications.filter((n) => ticketIds.has(n.ticketId)).slice(0, 5),
  });
});
