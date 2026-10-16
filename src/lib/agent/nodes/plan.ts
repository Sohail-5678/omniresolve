/**
 * N4a planner (large LLM): proposes actions with citations. The schema only accepts clause
 * IDs that N3 returned. If no clause cleared the score floor, or the plan is still invalid
 * after repairs, or the budget ran out, the plan becomes "escalate" — never a guess.
 */
import { planSchema, type ResolutionPlan } from "../schemas";
import { structuredCall } from "../structured";
import { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM, plannerUser } from "../prompts/planner";
import { contextForPlanner } from "../context";
import { logicalConversation, renderConversation } from "../conversation";
import { instrument, llmBadge, type NodeDeps } from "../deps";
import type { GraphState } from "../state";

export function makePlanNode(deps: NodeDeps) {
  return instrument(
    "n4a_plan",
    deps,
    async (state: GraphState) => {
      const clauses = state.policies ?? [];
      if (!clauses.length) {
        const plan: ResolutionPlan = {
          actions: [{ type: "escalate", reason: "No policy clause matched this request closely enough." }],
          rationale: "Retrieval returned nothing above the score floor, so a specialist must review.",
          citedClauseIds: [],
        };
        return { plan };
      }
      const focus = state.triage?.orderIdsMentioned.length ? state.triage.orderIdsMentioned : state.context?.primaryOrderId ? [state.context.primaryOrderId] : [];
      const ctx = contextForPlanner(state.context!, focus);
      const clauseBlock = clauses.map((c) => `[${c.clauseId} · ${c.title} · v${c.version}${c.pinned ? " · states the rule" : ""}]\n${c.text}`).join("\n\n");
      const triage = state.triage
        ? { intents: state.triage.intents, churnRisk: state.triage.churnRisk, orderIdsMentioned: state.triage.orderIdsMentioned, socialEngineeringSignals: state.triage.socialEngineeringSignals, summary: state.triage.summary }
        : {};
      const res = await structuredCall({
        provider: deps.llm,
        node: "planner",
        promptVersion: PLANNER_PROMPT_VERSION,
        system: PLANNER_SYSTEM,
        user: plannerUser({ contextJson: JSON.stringify(ctx, null, 1), clauses: clauseBlock, triageJson: JSON.stringify(triage), conversation: renderConversation(state.messages) }),
        logicalInput: { ctx, clauses: clauses.map((c) => c.key), triage, messages: logicalConversation(state.messages) },
        schema: planSchema(clauses.map((c) => c.clauseId)),
        budget: deps.budget,
        maxTokens: 700,
        onCall: (call) => deps.emit({ type: "llm_call", call }),
      });
      const llmCalls = [...state.llmCalls, ...res.calls];
      if (!res.value) {
        if (res.unavailableCode === "REPLAY_MISS") return { llmCalls, escalation: { code: "REPLAY_MISS", reason: res.errorDetail ?? "No recording" } };
        const code = res.error === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : res.error === "LLM_UNAVAILABLE" ? "LLM_UNAVAILABLE" : "PLAN_INVALID";
        const plan: ResolutionPlan = {
          actions: [{ type: "escalate", reason: code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : "Planner could not produce a valid plan" }],
          rationale: res.errorDetail ?? code,
          citedClauseIds: [],
        };
        return { llmCalls, plan };
      }
      return { llmCalls, plan: res.value };
    },
    (u) => llmBadge(u.llmCalls?.filter((c) => c.node === "planner")),
    (u) => ({ actions: u.plan?.actions.map((a) => a.type), cited: u.plan?.citedClauseIds, escalation: u.escalation?.code }),
  );
}
