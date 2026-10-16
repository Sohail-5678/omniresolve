/**
 * zod schemas for everything an LLM produces (triage, plan, reply) plus the Action union
 * shared with the policy gate. LLM output is untrusted: it only becomes state after it
 * passes these schemas (with a bounded repair loop, see structured.ts).
 */
import { z } from "zod";

export const ORDER_ID = /^ORD-\d{4}$/;

export const INTENTS = [
  "damaged_item",
  "double_charge",
  "late_delivery",
  "lost_package",
  "return_request",
  "refund_status",
  "vip_churn",
  "policy_question",
  "other",
] as const;

export const SOCIAL_SIGNALS = [
  "authority_claim",
  "instruction_override",
  "tool_call_text",
  "urgency_pressure",
  "fake_prior_promise",
  "fake_policy_citation",
  "system_prompt_probe",
] as const;

export const MISSING_INFO = ["order_id", "item", "issue_details"] as const;

export const TriageSchema = z.object({
  intents: z.array(z.enum(INTENTS)).min(1).max(3),
  severity: z.enum(["low", "medium", "high"]),
  sentiment: z.enum(["negative", "neutral", "positive"]),
  churnRisk: z.enum(["low", "medium", "high"]),
  orderIdsMentioned: z.array(z.string().regex(ORDER_ID)).max(5),
  missingInfo: z.array(z.enum(MISSING_INFO)).max(3),
  clarifyingQuestion: z.string().max(300).nullable(),
  socialEngineeringSignals: z.array(z.enum(SOCIAL_SIGNALS)).max(7),
  summary: z.string().min(1).max(300),
});
export type Triage = z.infer<typeof TriageSchema>;

export const REFUND_REASONS = ["damaged", "duplicate_charge", "late_delivery", "lost_package", "return", "goodwill", "other"] as const;
export const CREDIT_REASONS = ["out_of_window_return", "late_delivery", "goodwill", "damaged", "other"] as const;

const cents = z.number().int().positive().max(10_000_000);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("refund"),
    orderId: z.string().regex(ORDER_ID),
    amountCents: cents,
    reason: z.enum(REFUND_REASONS),
    exception: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("replacement"),
    orderId: z.string().regex(ORDER_ID),
    sku: z.string().min(1).max(40),
    qty: z.number().int().positive().max(20),
    reason: z.enum(["damaged", "lost_package"]).optional(),
  }),
  z.object({
    type: z.literal("return_label"),
    orderId: z.string().regex(ORDER_ID),
    reason: z.enum(["return", "damaged"]).optional(),
  }),
  z.object({
    type: z.literal("store_credit"),
    amountCents: cents,
    reason: z.enum(CREDIT_REASONS),
    orderId: z.string().regex(ORDER_ID).optional(),
    exception: z.boolean().optional(),
  }),
  z.object({ type: z.literal("escalate"), reason: z.string().min(1).max(300) }),
  z.object({ type: z.literal("deny"), reason: z.string().min(1).max(300), alternative: z.string().max(300).optional() }),
  z.object({ type: z.literal("ask_customer"), question: z.string().min(1).max(300) }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];

export const MONEY_ACTIONS: ActionType[] = ["refund", "store_credit"];
export const STATE_CHANGING_ACTIONS: ActionType[] = ["refund", "store_credit", "replacement", "return_label", "escalate"];

/** Builds the plan schema for one turn: cited clause IDs must be ones N3 actually returned. */
export function planSchema(allowedClauseIds: string[]) {
  const allowed = new Set(allowedClauseIds);
  return z.object({
    actions: z.array(ActionSchema).min(1).max(5),
    rationale: z.string().min(1).max(700),
    citedClauseIds: z
      .array(z.string())
      .max(6)
      .superRefine((ids, ctx) => {
        ids.forEach((id, i) => {
          if (!allowed.has(id)) {
            ctx.addIssue({
              code: "custom",
              path: [i],
              message: `clause "${id}" was not in the retrieved clauses; cite only: ${[...allowed].join(", ") || "(none)"}`,
            });
          }
        });
      }),
  });
}
export type ResolutionPlan = {
  actions: Action[];
  rationale: string;
  citedClauseIds: string[];
};

export const ReplySchema = z.object({
  reply: z.string().min(1).max(2_000),
});

export function describeAction(a: Action): string {
  switch (a.type) {
    case "refund":
      return `refund ${a.orderId} ${a.amountCents}c (${a.reason})`;
    case "replacement":
      return `replacement ${a.orderId} ${a.sku} x${a.qty}`;
    case "return_label":
      return `return label ${a.orderId}`;
    case "store_credit":
      return `store credit ${a.amountCents}c (${a.reason})`;
    case "escalate":
      return `escalate: ${a.reason}`;
    case "deny":
      return `deny: ${a.reason}`;
    case "ask_customer":
      return `ask: ${a.question}`;
  }
}
