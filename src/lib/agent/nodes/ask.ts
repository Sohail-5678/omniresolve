/**
 * Clarifying question: ends the turn with one question. The question is verified like any
 * reply (it may only mention the customer's real order IDs); otherwise a template lists them.
 */
import { AGENT } from "@/config/agent";
import { daysBetween } from "@/lib/util/dates";
import { verifyReply } from "@/lib/verify/grounding";
import { instrument, type NodeDeps } from "../deps";
import { loadProfile } from "./triage";
import type { GraphState, VerifiedFacts } from "../state";

export function makeAskNode(deps: NodeDeps) {
  return instrument(
    "ask",
    deps,
    async (state: GraphState) => {
      const profile = await loadProfile(deps, state.customerId);
      const recent = profile.orders.filter((o) => daysBetween(o.orderDate, AGENT.businessDate) <= 120).slice(0, 4);
      const facts: VerifiedFacts = {
        customerFirstName: profile.name.split(" ")[0],
        outcome: "NEEDS_INFO",
        orders: recent.map((o) => ({ orderId: o.orderId, items: o.items, orderDate: o.orderDate })),
        actions: [],
        ticket: null,
        clauses: [],
        policyNumbers: [],
        nextStep: null,
        notes: [],
      };
      const fromLlm = state.triage?.clarifyingQuestion?.trim();
      const template = `Happy to help, ${facts.customerFirstName}. Which order is this about? I can see ${recent
        .map((o) => `${o.orderId} (${o.items.join(", ") || "order"})`)
        .join(", ")}.`;
      // The template is built from facts, so either way the question that ships is verified.
      let text = template;
      let usedTemplate = true;
      if (fromLlm && verifyReply(fromLlm, facts).ok) {
        text = recent.length > 1 && !/ORD-\d{4}/.test(fromLlm) ? `${fromLlm} I can see ${recent.map((o) => `${o.orderId} (${o.items.join(", ")})`).join(", ")}.` : fromLlm;
        usedTemplate = false;
      }
      const verified = true;
      return {
        facts,
        reply: { text, verified, attempts: 1, usedTemplate, problems: [] },
        outcome: "ASKED" as const,
        messages: [{ role: "agent" as const, text, at: new Date().toISOString(), turnId: state.turnId, meta: { verified, usedTemplate, outcome: "ASKED" } }],
      };
    },
    () => "CODE",
    (u) => ({ question: u.reply?.text?.slice(0, 120) }),
  );
}
