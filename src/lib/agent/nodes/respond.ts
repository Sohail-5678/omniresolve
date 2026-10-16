/**
 * N7 responder (large LLM) + grounding verifier (code). The reply is written from
 * VerifiedFacts only; the verifier checks every amount, ID, clause, date and promise.
 * One regeneration with the list of problems, then a safe template built from facts.
 * When the LLM is unavailable (replay miss, no key, budget), the template is used directly.
 */
import { AGENT } from "@/config/agent";
import { ReplySchema } from "../schemas";
import { structuredCall } from "../structured";
import { RESPONDER_PROMPT_VERSION, RESPONDER_SYSTEM, responderUser } from "../prompts/responder";
import { aliasFacts, buildFacts, volatileAliases } from "../facts";
import { logicalConversation, renderConversation } from "../conversation";
import { instrument, llmBadge, type NodeDeps } from "../deps";
import { templateReply, verifyReply } from "@/lib/verify/grounding";
import type { GraphState, VerifiedFacts } from "../state";

function factsFor(state: GraphState): VerifiedFacts {
  const esc = state.escalation;
  if (!esc) return buildFacts(state);
  switch (esc.code) {
    case "REPLAY_MISS":
      return buildFacts(state, {
        outcomeOverride: "UNAVAILABLE",
        nextStep: "Demo mode can only replay conversations that were recorded with a real model. Switch to Live mode (your own key) to try a new message.",
      });
    case "CONTEXT_UNAVAILABLE": {
      const f = buildFacts(state, { outcomeOverride: "DELAYED" });
      return { ...f, ticket: esc.ticketId ? { ticketId: esc.ticketId, status: "OPEN" } : null, nextStep: "We'll follow up as soon as our order systems are reachable again." };
    }
    default:
      return buildFacts(state, { outcomeOverride: "ESCALATED", nextStep: "A specialist will review your case and get back to you." });
  }
}

export function makeRespondNode(deps: NodeDeps) {
  return instrument(
    "n7_respond",
    deps,
    async (state: GraphState) => {
      const facts = factsFor(state);
      const skipLlm = deps.ablation?.templateResponder === true || (!!state.escalation && ["REPLAY_MISS", "LLM_UNAVAILABLE", "BUDGET_EXCEEDED", "NO_KEY", "QUOTA"].includes(state.escalation.code));
      const aliases = volatileAliases(facts);
      const llmCalls = [...state.llmCalls];
      let problems: string[] = [];
      let text: string | null = null;
      let attempts = 0;

      if (!skipLlm) {
        for (let regen = 0; regen <= AGENT.verifier.maxRegenerations; regen++) {
          attempts++;
          const res = await structuredCall({
            provider: deps.llm,
            node: "responder",
            promptVersion: RESPONDER_PROMPT_VERSION,
            system: RESPONDER_SYSTEM,
            user: responderUser({ factsJson: JSON.stringify(facts, null, 1), conversation: renderConversation(state.messages), problems }),
            logicalInput: { facts: aliasFacts(facts, aliases), messages: logicalConversation(state.messages), problems },
            schema: ReplySchema,
            budget: deps.budget,
            maxTokens: 450,
            aliases,
            onCall: (call) => deps.emit({ type: "llm_call", call }),
          });
          llmCalls.push(...res.calls);
          if (!res.value) break;
          const check = verifyReply(res.value.reply, facts);
          if (deps.ablation?.noVerifier) {
            // Ablation: ship the first draft; keep the verifier's verdict for scoring.
            text = res.value.reply;
            problems = check.problems;
            break;
          }
          if (check.ok) {
            text = res.value.reply;
            problems = [];
            break;
          }
          problems = check.problems;
        }
      }

      const usedTemplate = text === null;
      const finalText = text ?? templateReply(facts);
      const verified = verifyReply(finalText, facts).ok;
      return {
        facts,
        llmCalls,
        reply: { text: finalText, verified, attempts, usedTemplate, problems },
        outcome: "REPLIED" as const,
        messages: [
          {
            role: "agent" as const,
            text: finalText,
            at: new Date().toISOString(),
            turnId: state.turnId,
            meta: { verified, usedTemplate, attempts, badge: llmBadge(llmCalls.filter((c) => c.node === "responder").slice(-1)), outcome: facts.outcome },
          },
        ],
      };
    },
    (u) => llmBadge(u.llmCalls?.filter((c) => c.node === "responder").slice(-1)),
    (u) => ({ outcome: u.facts?.outcome, verified: u.reply?.verified, usedTemplate: u.reply?.usedTemplate, attempts: u.reply?.attempts, problems: u.reply?.problems }),
  );
}
