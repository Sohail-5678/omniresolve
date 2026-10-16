/**
 * N3 node: temporal hybrid retrieval, one query per triaged intent, governed by the claim
 * date (process rules) and the primary order's date (customer-facing promises).
 */
import { AGENT } from "@/config/agent";
import { INTENT_QUERY_HINTS, retrieveForIntents } from "@/lib/rag/retriever";
import { instrument, type NodeDeps } from "../deps";
import { lastCustomerText } from "../conversation";
import type { GraphState } from "../state";

export function makeRetrieveNode(deps: NodeDeps) {
  return instrument(
    "n3_retrieve",
    deps,
    async (state: GraphState) => {
      const message = lastCustomerText(state.messages);
      const intents = state.triage?.intents.length ? state.triage.intents : ["other"];
      const primary = state.context?.orders.find((o) => o.id === state.context?.primaryOrderId);
      const dates = { claimDate: AGENT.businessDate, orderDate: primary?.orderDate ?? null };
      // Manipulation signals pull in the approval/security clauses so replies can cite them.
      const flagged = (state.triage?.socialEngineeringSignals.length ?? 0) > 0 || state.firewall?.outcome === "flag";
      const effectiveIntents = flagged ? [...intents, "security"] : intents;
      const queries = effectiveIntents.map((i) => `${INTENT_QUERY_HINTS[i] ?? ""} ${message}`.trim());
      queries.forEach((q) => deps.onQuery?.(q));
      const embeddings: Record<string, number[] | null> = {};
      if (deps.embedQuery) {
        for (const q of queries) embeddings[q] = await deps.embedQuery(q).catch(() => null);
      }
      const naive = deps.ablation?.noTemporal === true;
      const r = retrieveForIntents(effectiveIntents, message, dates, embeddings, { naive, pin: !naive });
      return {
        policies: r.results,
        retrievalMeta: { queries: r.queries, denseMode: r.denseMode, timingMs: r.timingMs, removedCount: r.removedCount },
      };
    },
    () => "CODE",
    (u) => ({
      clauses: u.policies?.map((p) => p.citation),
      denseMode: u.retrievalMeta?.denseMode,
      timingMs: u.retrievalMeta?.timingMs,
      removedByTemporalFilter: u.retrievalMeta?.removedCount,
    }),
  );
}
