/**
 * N1 triage (small LLM): intents, severity, churn risk, order IDs, missing info and
 * social-engineering signals. Firewall signals are merged in by code, and code decides
 * whether a clarifying question is needed (the LLM's opinion is one input).
 */
import { and, desc, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { daysBetween } from "@/lib/util/dates";
import { TriageSchema, type Triage } from "../schemas";
import { structuredCall } from "../structured";
import { TRIAGE_PROMPT_VERSION, TRIAGE_SYSTEM, triageUser } from "../prompts/triage";
import { logicalConversation, renderConversation } from "../conversation";
import { instrument, llmBadge, type NodeDeps } from "../deps";
import type { GraphState } from "../state";

export type CustomerProfile = {
  name: string;
  tier: string;
  orders: { orderId: string; orderDate: string; status: string; items: string[] }[];
};

/** Session context the chat widget already knows (not one of the faultable mock APIs). */
export async function loadProfile(deps: Pick<NodeDeps, "db" | "sandboxId">, customerId: string): Promise<CustomerProfile> {
  const cust = await deps.db
    .select({ name: s.customers.name, tier: s.customers.tier })
    .from(s.customers)
    .where(and(eq(s.customers.sandboxId, deps.sandboxId), eq(s.customers.id, customerId)));
  const orders = await deps.db
    .select({ id: s.orders.id, orderDate: s.orders.orderDate, status: s.orders.status })
    .from(s.orders)
    .where(and(eq(s.orders.sandboxId, deps.sandboxId), eq(s.orders.customerId, customerId)))
    .orderBy(desc(s.orders.orderDate))
    .limit(10);
  const items = orders.length
    ? await deps.db.select({ orderId: s.orderItems.orderId, name: s.orderItems.name }).from(s.orderItems).where(eq(s.orderItems.sandboxId, deps.sandboxId))
    : [];
  return {
    name: cust[0]?.name ?? "Customer",
    tier: cust[0]?.tier ?? "standard",
    orders: orders.map((o) => ({ orderId: o.id, orderDate: o.orderDate, status: o.status, items: items.filter((i) => i.orderId === o.id).map((i) => i.name) })),
  };
}

const FIREWALL_TO_SIGNAL: Record<string, Triage["socialEngineeringSignals"][number]> = {
  instruction_override: "instruction_override",
  role_tag: "instruction_override",
  hidden_unicode: "instruction_override",
  authority_claim: "authority_claim",
  authority_approval: "authority_claim",
  tool_call_text: "tool_call_text",
  system_prompt_probe: "system_prompt_probe",
  urgency_pressure: "urgency_pressure",
  fake_prior_promise: "fake_prior_promise",
  fake_policy_citation: "fake_policy_citation",
};

const ORDER_INTENTS = new Set(["damaged_item", "double_charge", "late_delivery", "lost_package", "return_request", "refund_status"]);

export function needsClarification(triage: Triage, profile: CustomerProfile): boolean {
  const valid = triage.orderIdsMentioned.filter((id) => profile.orders.some((o) => o.orderId === id));
  if (valid.length > 0) return false;
  if (!triage.intents.some((i) => ORDER_INTENTS.has(i))) return false;
  const recent = profile.orders.filter((o) => daysBetween(o.orderDate, AGENT.businessDate) <= 120);
  if (recent.length === 1) return false;
  return true;
}

export function makeTriageNode(deps: NodeDeps) {
  return instrument(
    "n1_triage",
    deps,
    async (state: GraphState) => {
      const profile = await loadProfile(deps, state.customerId);
      const res = await structuredCall({
        provider: deps.llm,
        node: "triage",
        promptVersion: TRIAGE_PROMPT_VERSION,
        system: TRIAGE_SYSTEM,
        user: triageUser({ profileJson: JSON.stringify(profile, null, 1), conversation: renderConversation(state.messages) }),
        logicalInput: { profile, messages: logicalConversation(state.messages) },
        schema: TriageSchema,
        budget: deps.budget,
        maxTokens: 450,
        onCall: (call) => deps.emit({ type: "llm_call", call }),
      });
      const llmCalls = [...state.llmCalls, ...res.calls];
      if (!res.value) {
        return {
          llmCalls,
          escalation: { code: res.unavailableCode === "REPLAY_MISS" ? "REPLAY_MISS" : (res.error ?? "LLM_ERROR"), reason: res.errorDetail ?? "Triage failed" },
        };
      }
      const signals = new Set(res.value.socialEngineeringSignals);
      for (const sig of state.firewall?.signals ?? []) {
        const mapped = FIREWALL_TO_SIGNAL[sig.rule];
        if (mapped) signals.add(mapped);
      }
      const known = new Set(profile.orders.map((o) => o.orderId));
      const triage: Triage = {
        ...res.value,
        orderIdsMentioned: res.value.orderIdsMentioned.filter((id) => known.has(id) || /ORD-\d{4}/.test(id)),
        socialEngineeringSignals: [...signals],
      };
      if (needsClarification(triage, profile) && !triage.missingInfo.includes("order_id")) triage.missingInfo = [...triage.missingInfo, "order_id"];
      return { triage, llmCalls };
    },
    (u) => llmBadge(u.llmCalls?.slice(-3)),
    (u) => ({ intents: u.triage?.intents, orderIds: u.triage?.orderIdsMentioned, signals: u.triage?.socialEngineeringSignals, missing: u.triage?.missingInfo, escalation: u.escalation?.code }),
  );
}

export function afterTriage(state: GraphState): "ask" | "context" | "respond" {
  if (state.escalation) return "respond";
  if (!state.triage) return "respond";
  const t = state.triage;
  if (t.missingInfo.includes("order_id") || (t.missingInfo.length > 0 && t.orderIdsMentioned.length === 0)) return "ask";
  return "context";
}
