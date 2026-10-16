/**
 * Mock ticketing API (labeled MOCK SERVICE): tickets, notes, status changes, the ops
 * outbox and a labeled notification *preview* (nothing is ever sent). Rolling back a
 * ticket marks it ROLLED_BACK and queues a human follow-up rather than deleting it.
 */
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import type { Queryable } from "@/db/client";
import { callService, idempotent, nextId, notFound, type ServiceCtx } from "./core";

export async function createTicket(
  ctx: ServiceCtx,
  args: { sagaId: string; threadId: string; customerId: string; orderId: string | null; subject: string; idempotencyKey: string },
) {
  return callService(
    ctx,
    "tickets",
    "create",
    () =>
      ctx.db.transaction((tx) =>
        idempotent(tx, ctx.sandboxId, args.idempotencyKey, "tickets.create", async () => {
          const ticketId = await nextId(tx, ctx.sandboxId, "TCK");
          await tx.insert(s.tickets).values({
            sandboxId: ctx.sandboxId,
            id: ticketId,
            customerId: args.customerId,
            orderId: args.orderId,
            threadId: args.threadId,
            sagaId: args.sagaId,
            subject: args.subject,
            status: "OPEN",
          });
          return { ticketId, status: "OPEN" };
        }),
      ),
    (r) => ({ ticket: r.ticketId }),
  );
}

export async function addNote(ctx: ServiceCtx, args: { ticketId: string; body: string; idempotencyKey: string }) {
  return callService(
    ctx,
    "tickets",
    "addNote",
    () =>
      ctx.db.transaction((tx) =>
        idempotent(tx, ctx.sandboxId, args.idempotencyKey, "tickets.addNote", async () => {
          const noteId = await nextId(tx, ctx.sandboxId, "NTE");
          await tx.insert(s.ticketNotes).values({ sandboxId: ctx.sandboxId, id: noteId, ticketId: args.ticketId, body: args.body });
          return { noteId, ticketId: args.ticketId };
        }),
      ),
    (r) => ({ note: r.noteId }),
  );
}

export async function setTicketStatus(ctx: ServiceCtx, args: { ticketId: string; status: string; idempotencyKey: string }) {
  return callService(
    ctx,
    "tickets",
    "close",
    () =>
      ctx.db.transaction((tx) =>
        idempotent(tx, ctx.sandboxId, args.idempotencyKey, "tickets.close", async () => {
          const res = await tx
            .update(s.tickets)
            .set({ status: args.status, updatedAt: new Date() })
            .where(and(eq(s.tickets.sandboxId, ctx.sandboxId), eq(s.tickets.id, args.ticketId)))
            .returning({ id: s.tickets.id });
          if (!res.length) throw notFound(`ticket ${args.ticketId}`);
          return { ticketId: args.ticketId, status: args.status };
        }),
      ),
    (r) => ({ id: r.ticketId, state: r.status.toLowerCase() }),
  );
}

/** Compensation: marks this saga's ticket ROLLED_BACK and queues a human follow-up. */
export async function rollbackTicket(ctx: ServiceCtx, args: { sagaId: string; reason: string }) {
  return callService(
    ctx,
    "tickets",
    "cancel",
    () =>
      ctx.db.transaction(async (tx) => {
        const res = await tx
          .update(s.tickets)
          .set({ status: "ROLLED_BACK", updatedAt: new Date() })
          .where(and(eq(s.tickets.sandboxId, ctx.sandboxId), eq(s.tickets.sagaId, args.sagaId), eq(s.tickets.status, "OPEN")))
          .returning({ id: s.tickets.id });
        for (const t of res) {
          await writeOutbox(tx, ctx.sandboxId, "human_followup", args.sagaId, { ticketId: t.id, reason: args.reason });
        }
        return { affected: res.length };
      }),
    (r) => ({ rolled_back: String(r.affected) }),
  );
}

export async function notifyPreview(
  ctx: ServiceCtx,
  args: { ticketId: string; sagaId: string; preview: string; idempotencyKey: string },
) {
  return callService(
    ctx,
    "tickets",
    "notify",
    () =>
      ctx.db.transaction((tx) =>
        idempotent(tx, ctx.sandboxId, args.idempotencyKey, "tickets.notify", async () => {
          const notificationId = await nextId(tx, ctx.sandboxId, "NTF");
          await tx.insert(s.notifications).values({
            sandboxId: ctx.sandboxId,
            id: notificationId,
            ticketId: args.ticketId,
            sagaId: args.sagaId,
            channel: "email (preview only, not sent)",
            preview: args.preview,
          });
          return { notificationId, channel: "email (preview only, not sent)", preview: args.preview };
        }),
      ),
    (r) => ({ id: r.notificationId }),
  );
}

export async function writeOutbox(db: Queryable, sandboxId: string, kind: string, sagaId: string | null, payload: Record<string, unknown>) {
  const id = await nextId(db, sandboxId, "OBX");
  await db.insert(s.outbox).values({ sandboxId, id, kind, sagaId, payload, status: "open" });
  return id;
}
