/**
 * N2 node: loads the customer's data from the mock APIs in parallel. If Orders or Billing
 * cannot be reached after a retry, the agent does not guess: it opens a ticket and tells
 * the customer there is a delay.
 */
import { AGENT } from "@/config/agent";
import type { ServiceCallEvent, ServiceCtx } from "@/lib/services/core";
import * as tickets from "@/lib/services/tickets";
import * as wire from "@/lib/services/wire";
import { loadContext } from "../context";
import { instrument, type NodeDeps } from "../deps";
import type { GraphState } from "../state";

export function makeContextNode(deps: NodeDeps) {
  return instrument(
    "n2_context",
    deps,
    async (state: GraphState) => {
      const svc: ServiceCtx = { db: deps.db, sandboxId: deps.sandboxId, onCall: (call: ServiceCallEvent) => deps.emit({ type: "service_call", call }) };
      const context = await loadContext(svc, state.customerId, AGENT.businessDate, state.triage?.orderIdsMentioned ?? []);
      if (context.sources.orders === "failed" || context.sources.billing === "failed") {
        let ticketId: string | undefined;
        try {
          const t = wire.parseWire(
            wire.TicketWire,
            await tickets.createTicket(svc, {
              sagaId: `ctx-${state.turnId}`,
              threadId: state.threadId,
              customerId: state.customerId,
              orderId: context.primaryOrderId,
              subject: "Follow-up: order systems unavailable during chat",
              idempotencyKey: `ctx-${state.threadId}-${state.turnId}`,
            }),
            "tickets.create",
          );
          ticketId = t.ticketId;
        } catch {
          ticketId = undefined;
        }
        return {
          context,
          escalation: { code: "CONTEXT_UNAVAILABLE", reason: `Order or billing data unavailable (${Object.keys(context.sourceErrors).join(", ")})`, ticketId },
        };
      }
      return { context };
    },
    (u) => (u.context && Object.values(u.context.sources).some((x) => x !== "ok") ? "FAULT-INJECTED" : "MOCK SERVICE"),
    (u) => ({ sources: u.context?.sources, primaryOrderId: u.context?.primaryOrderId, orders: u.context?.orders.length, escalation: u.escalation?.code }),
  );
}
