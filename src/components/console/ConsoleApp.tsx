"use client";

/**
 * The operations console. Owns the session (private sandbox), the event-driven state, and the
 * calls to /api/resolve, /api/hitl, /api/chaos and /api/saga/recover. Desktop shows all panels;
 * below 1280 px the panels become tabs.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, byokHeaders, postSSE } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { scenarioById } from "@/lib/scenarios";
import type { HitlDecision } from "@/lib/agent/state";
import { initialState, reducer, type Fault } from "./state";
import { TopBar, type SessionInfo } from "./TopBar";
import { Customer360Sidebar } from "./Customer360Sidebar";
import { ResolutionChatConsole } from "./ResolutionChatConsole";
import { AgentGraphView } from "./AgentGraphView";
import { SagaChaosMonitor } from "./SagaChaosMonitor";
import { HITLSupervisorDeck } from "./HITLSupervisorDeck";
import { PolicyRAGInspector } from "./PolicyRAGInspector";
import { EvalResultsDrawer } from "./EvalResultsDrawer";
import { Drawer } from "./ui";

type Tab = "chat" | "graph" | "saga" | "customer";

export function ConsoleApp({ initialScenarioId }: { initialScenarioId: string | null }) {
  const router = useRouter();
  const first = scenarioById(initialScenarioId) ?? scenarioById("s1-damaged-double-charge")!;
  const [scenarioId, setScenarioId] = useState(first.id);
  const scenario = scenarioById(scenarioId);
  const [state, dispatch] = useReducer(reducer, initialState(first.customerId, first.id));
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [mode, setMode] = useState<"replay" | "live">(first.id === "free-play" ? "live" : "replay");
  const [byok, setByok] = useState("");
  const [faults, setFaults] = useState<Fault[]>([]);
  const [evidence, setEvidence] = useState(first.evidenceAttached);
  const [drawer, setDrawer] = useState<null | "rag" | "evals">(null);
  const [tab, setTab] = useState<Tab>("chat");
  const abortRef = useRef<AbortController | null>(null);

  const loadFaults = useCallback(async () => {
    try {
      const r = await api<{ faults: Fault[] }>("/api/chaos");
      setFaults(r.faults);
    } catch {
      /* session not ready */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const existing = await api<{ session: SessionInfo | null }>("/api/session");
        const s = existing.session ?? (await api<{ session: SessionInfo }>("/api/session", { json: {} })).session;
        if (!alive) return;
        setSession(s);
        loadFaults();
      } catch (e) {
        if (alive) setSessionError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadFaults]);

  const headers = useMemo(() => (mode === "live" ? byokHeaders({ groq: byok }) : {}), [mode, byok]);
  const onEvent = useCallback((event: string, data: unknown) => dispatch({ type: "event", event, data }), []);

  const stream = useCallback(
    async (url: string, body: unknown) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await postSSE(url, body, onEvent, { headers, signal: ctrl.signal });
      } catch (e) {
        if ((e as Error).name !== "AbortError") dispatch({ type: "system", tone: "bad", text: (e as Error).message });
      } finally {
        dispatch({ type: "done" });
        loadFaults();
      }
    },
    [headers, onEvent, loadFaults],
  );

  const send = useCallback(
    (text: string) => {
      if (!session) return;
      dispatch({ type: "send", text });
      setTab("chat");
      stream("/api/resolve", {
        threadId: state.threadId ?? undefined,
        message: text,
        scenarioId: state.threadId ? undefined : scenarioId,
        customerId: state.customerId,
        mode,
        evidenceAttached: evidence,
      });
    },
    [session, stream, state.threadId, state.customerId, scenarioId, mode, evidence],
  );

  const decide = useCallback(
    (d: HitlDecision) => {
      if (!state.threadId || !state.approval) return;
      const interruptId = state.approval.interruptId;
      dispatch({ type: "send", text: "", resume: true });
      dispatch({ type: "system", tone: "info", text: d.decision === "reject" ? "Supervisor rejected. Resuming the run…" : d.decision === "modify" ? "Supervisor approved a modified plan. Resuming the run…" : "Supervisor approved. Resuming the run from its checkpoint…" });
      stream("/api/hitl", { threadId: state.threadId, interruptId, ...d, mode });
    },
    [state.threadId, state.approval, stream, mode],
  );

  const forged = useCallback(() => {
    if (!scenario?.forgedCall) return;
    dispatch({ type: "system", tone: "warn", text: `Forging billing.refund(${scenario.forgedCall.orderId}, ${(scenario.forgedCall.amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}) with no approval token…` });
    dispatch({ type: "send", text: "", resume: true });
    stream("/api/resolve", { threadId: state.threadId ?? undefined, message: "forged tool call", scenarioId, customerId: state.customerId, forgedCall: true, mode: "replay" });
  }, [scenario, stream, state.threadId, scenarioId, state.customerId]);

  const recover = useCallback(() => {
    dispatch({ type: "send", text: "", resume: true });
    dispatch({ type: "system", tone: "info", text: "Recovering from the saga log…" });
    stream("/api/saga/recover", {});
  }, [stream]);

  const pickScenario = (id: string) => {
    const s = scenarioById(id);
    if (!s) return;
    abortRef.current?.abort();
    setScenarioId(id);
    setEvidence(s.evidenceAttached);
    if (id === "free-play") setMode("live");
    dispatch({ type: "reset", customerId: s.customerId, scenarioId: id });
    router.replace(`/console?scenario=${id}`, { scroll: false });
  };

  const resetSandbox = useCallback(async () => {
    abortRef.current?.abort();
    try {
      const r = await api<{ session: SessionInfo }>("/api/session", { json: { reset: true } });
      setSession(r.session);
      dispatch({ type: "reset", customerId: scenario?.customerId ?? state.customerId, scenarioId });
      dispatch({ type: "system", tone: "ok", text: "Fresh sandbox: data reseeded, faults cleared, threads deleted." });
      loadFaults();
    } catch (e) {
      dispatch({ type: "system", tone: "bad", text: (e as Error).message });
    }
  }, [scenario, state.customerId, scenarioId, loadFaults]);

  const setFault = useCallback(
    async (service: string, operation: string, faultMode: string) => {
      try {
        const r = await api<{ faults: Fault[] }>("/api/chaos", { json: { service, operation, mode: faultMode } });
        setFaults(r.faults);
      } catch (e) {
        dispatch({ type: "system", tone: "bad", text: (e as Error).message });
      }
    },
    [],
  );
  const clearFaults = useCallback(async () => {
    const r = await api<{ faults: Fault[] }>("/api/chaos", { json: { reset: true } });
    setFaults(r.faults);
  }, []);

  const focusOrders = useMemo(() => {
    const ids = new Set<string>();
    const msg = scenario?.message ?? "";
    for (const m of msg.matchAll(/ORD-\d{4}/g)) ids.add(m[0]);
    for (const c of state.chat) if (c.kind === "agent") c.facts?.orders.forEach((o) => ids.add(o.orderId));
    return [...ids];
  }, [scenario, state.chat]);

  if (sessionError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="panel max-w-md p-6 text-center">
          <p className="display-tight text-[1.4rem]">Couldn&apos;t start a sandbox</p>
          <p className="mt-2 text-[0.86rem] text-muted">{sessionError}</p>
          <button type="button" className="btn btn-ink mt-4" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const chat = (
    <ResolutionChatConsole
      className="h-full"
      chat={state.chat}
      scenario={scenario}
      busy={state.busy || !session}
      activeNode={state.activeNode}
      onSend={send}
      evidenceAttached={evidence}
      onEvidence={setEvidence}
      onForgedCall={scenario?.forgedCall ? forged : undefined}
      mode={mode}
      modeNote={state.modeNote}
    />
  );
  const graph = <AgentGraphView className="h-full" nodes={state.nodes} activeNode={state.activeNode} llm={state.llm} threadId={state.threadId} refreshKey={state.refreshKey} />;
  const saga = (
    <SagaChaosMonitor
      className="h-full"
      faults={faults}
      onFault={setFault}
      onClearFaults={clearFaults}
      services={state.services}
      steps={state.sagaSteps}
      sagaId={state.sagaId}
      sagaStatus={state.sagaStatus}
      ticketStatus={state.ticketStatus}
      crashed={state.crashed}
      onRecover={recover}
      disabled={state.busy}
    />
  );
  const customer = session ? <Customer360Sidebar className="h-full" customerId={state.customerId} refreshKey={state.refreshKey} focusOrderIds={focusOrders} /> : <div className="panel h-full animate-pulse" />;

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <TopBar session={session} scenario={scenario} onScenario={pickScenario} mode={mode} onMode={setMode} byokKey={byok} onByok={setByok} onReset={resetSandbox} onOpen={setDrawer} busy={state.busy} />

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-paper px-3 py-2 xl:hidden" role="tablist" aria-label="Console panels">
        {(["chat", "graph", "saga", "customer"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("rounded-full px-3.5 py-1.5 text-[0.74rem] font-semibold capitalize transition-colors", tab === t ? "bg-ink text-paper" : "bg-paper-2 text-ink-soft")}>
            {t === "saga" ? "Saga & chaos" : t}
            {t === "graph" && state.busy && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-signal align-middle" />}
          </button>
        ))}
      </div>

      <main className="hidden min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_420px] gap-3 p-3 xl:grid 2xl:grid-cols-[330px_minmax(0,1fr)_460px]">
        <div className="min-h-0">{customer}</div>
        <div className="min-h-0">{chat}</div>
        <div className="grid min-h-0 grid-rows-[minmax(0,1.05fr)_minmax(0,1fr)] gap-3">
          {graph}
          {saga}
        </div>
      </main>
      <main className="min-h-0 flex-1 p-2 sm:p-3 xl:hidden">
        <div className={cn("h-full", tab !== "chat" && "hidden")}>{chat}</div>
        <div className={cn("h-full", tab !== "graph" && "hidden")}>{graph}</div>
        <div className={cn("h-full", tab !== "saga" && "hidden")}>{saga}</div>
        <div className={cn("h-full", tab !== "customer" && "hidden")}>{customer}</div>
      </main>

      {state.approval && !state.busy && <HITLSupervisorDeck card={state.approval.card} presets={scenario?.supervisorPresets ?? []} mode={mode} busy={state.busy} onDecide={decide} />}

      <Drawer open={drawer === "rag"} onClose={() => setDrawer(null)} kicker="N3 · temporal hybrid retrieval" title="Policy inspector">
        <PolicyRAGInspector />
      </Drawer>
      <Drawer open={drawer === "evals"} onClose={() => setDrawer(null)} kicker="From committed result files" title="Eval results">
        <EvalResultsDrawer />
      </Drawer>
    </div>
  );
}
