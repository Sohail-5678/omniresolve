/**
 * N6 saga executor node: hands approved actions plus their token IDs to the saga
 * orchestrator. Re-running this node (after a crash or a duplicate resume) finds the same
 * saga by thread + plan hash and continues it instead of starting a second one.
 */
import { runSaga } from "@/lib/saga/orchestrator";
import type { SagaPlan } from "@/lib/saga/steps";
import { instrument, type NodeDeps } from "../deps";
import type { GraphState } from "../state";

const EXECUTABLE = new Set(["refund", "store_credit", "replacement", "return_label", "escalate"]);

export function sagaPlanFrom(state: GraphState): SagaPlan {
  const approved = (state.gate?.decisions ?? []).filter((d) => d.status === "AUTO_APPROVED" && EXECUTABLE.has(d.action.type));
  const actions = approved.map((d) => ({
    action: d.action,
    tokenId: state.tokens.find((t) => t.decisionIndex === d.index)?.tokenId ?? null,
  }));
  const primaryOrderId =
    approved.map((d) => ("orderId" in d.action ? d.action.orderId : undefined)).find(Boolean) ?? state.context?.primaryOrderId ?? null;
  return {
    sandboxId: state.sandboxId,
    threadId: state.threadId,
    customerId: state.customerId,
    customerName: state.context?.customer?.name ?? "Customer",
    primaryOrderId: primaryOrderId ?? null,
    actions,
    subject: (state.triage?.summary ?? "Customer resolution").slice(0, 140),
  };
}

export function makeExecuteNode(deps: NodeDeps) {
  return instrument(
    "n6_execute",
    deps,
    async (state: GraphState) => {
      const saga = await runSaga(
        {
          db: deps.db,
          sandboxId: deps.sandboxId,
          emit: (e) => deps.emit(e),
          onServiceCall: (call) => deps.emit({ type: "service_call", call }),
          ...deps.sagaHooks,
        },
        sagaPlanFrom(state),
      );
      return { saga };
    },
    (u) => (u.saga?.steps.some((s) => (s.detail as { faultInjected?: boolean } | null)?.faultInjected) ? "FAULT-INJECTED" : "MOCK SERVICE"),
    (u) => ({ sagaId: u.saga?.sagaId, status: u.saga?.status, ticketStatus: u.saga?.ticketStatus, steps: u.saga?.steps.map((s) => `${s.seq}:${s.name}:${s.status}`) }),
  );
}
