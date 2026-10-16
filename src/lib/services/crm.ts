/** Mock CRM API (labeled MOCK SERVICE in the UI). Read-only: customer profile + open tickets. */
import { and, eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { callService, notFound, type ServiceCtx } from "./core";
import type { z } from "zod";
import type { CustomerWire } from "./wire";

export async function getCustomer(ctx: ServiceCtx, customerId: string): Promise<z.infer<typeof CustomerWire>> {
  return callService(
    ctx,
    "crm",
    "getCustomer",
    async () => {
      const rows = await ctx.db
        .select()
        .from(s.customers)
        .where(and(eq(s.customers.sandboxId, ctx.sandboxId), eq(s.customers.id, customerId)));
      const c = rows[0];
      if (!c) throw notFound(`customer ${customerId}`);
      const open = await ctx.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM tickets WHERE sandbox_id = ${ctx.sandboxId} AND customer_id = ${customerId} AND status IN ('OPEN','ESCALATED','REFUNDED_PENDING_FULFILLMENT')`,
      );
      return {
        customerId: c.id,
        name: c.name,
        emailMasked: c.emailMasked,
        tier: c.tier as "standard" | "gold" | "platinum",
        lifetimeValueCents: c.lifetimeValueCents,
        churnFlags: c.churnFlags,
        since: c.since,
        openTickets: open.rows[0]?.n ?? 0,
      };
    },
    (r) => ({ id: r.customerId, full_name: r.name, tier_level: r.tier.toUpperCase(), ltv: (r.lifetimeValueCents / 100).toFixed(2) }),
  );
}
