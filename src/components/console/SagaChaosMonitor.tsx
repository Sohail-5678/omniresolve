"use client";

/**
 * Mock services with per-sandbox chaos switches, and the live saga ledger. The pivot (the
 * irreversible refund) is marked; steps above it can be compensated, steps below it can only
 * be retried or handed to the ops outbox.
 */
import { useMemo, useState } from "react";
import { ChevronDown, LifeBuoy, RotateCcw, Zap } from "lucide-react";
import { cn } from "@/lib/client/cn";
import type { Fault, SagaStepView, ServiceCallView } from "./state";
import { ModeBadge, Panel, StatusChip } from "./ui";

const SERVICES: { key: string; label: string; ops: string[]; primary: string }[] = [
  { key: "billing", label: "Billing", ops: ["getLedger", "refund", "issueStoreCredit"], primary: "refund" },
  { key: "orders", label: "Orders", ops: ["getOrders", "reserveInventory", "releaseInventory", "createReplacementDraft", "cancelDraft", "confirmReplacement"], primary: "createReplacementDraft" },
  { key: "carrier_a", label: "Carrier A", ops: ["getTracking", "createReturnLabel", "voidLabel"], primary: "createReturnLabel" },
  { key: "carrier_b", label: "Carrier B", ops: ["getTracking", "createReturnLabel", "voidLabel"], primary: "createReturnLabel" },
  { key: "tickets", label: "Tickets", ops: ["create", "addNote", "close", "cancel", "notify"], primary: "create" },
  { key: "crm", label: "CRM", ops: ["getCustomer"], primary: "getCustomer" },
];

const MODES: { value: string; label: string }[] = [
  { value: "healthy", label: "Healthy" },
  { value: "fail_503", label: "503 outage" },
  { value: "rate_limit_429", label: "429 rate limit" },
  { value: "timeout", label: "Timeout" },
  { value: "commit_then_timeout", label: "Commit, lose response" },
  { value: "schema_drift", label: "Schema drift" },
  { value: "slow", label: "Slow" },
  { value: "fail_n_times", label: "Fail twice, then work" },
  { value: "crash_after", label: "Crash after step" },
];

const STEP_LABEL: Record<string, string> = {
  "tickets.create": "Open ticket",
  "orders.reserveInventory": "Reserve inventory",
  "carriers.createReturnLabel": "Return label",
  "orders.createReplacementDraft": "Draft replacement",
  "billing.refund": "Refund",
  "billing.issueStoreCredit": "Store credit",
  "orders.confirmReplacement": "Confirm replacement",
  "tickets.resolve": "Close ticket",
  "tickets.notify": "Notification preview",
};

function stepLabel(s: SagaStepView) {
  if (s.status === "RETRY") return `RETRY ${s.attempt ?? 2}/3`;
  if (s.status === "FAILOVER") return "FAILOVER → B";
  if (s.status === "DONE" && s.carrier === "carrier_b") return "DONE · CARRIER B";
  return undefined;
}

export function SagaChaosMonitor({
  faults,
  onFault,
  onClearFaults,
  services,
  steps,
  sagaId,
  sagaStatus,
  ticketStatus,
  crashed,
  onRecover,
  disabled,
  className,
}: {
  faults: Fault[];
  onFault: (service: string, operation: string, mode: string) => void;
  onClearFaults: () => void;
  services: ServiceCallView[];
  steps: SagaStepView[];
  sagaId: string | null;
  sagaStatus: string | null;
  ticketStatus: string | null;
  crashed: boolean;
  onRecover: () => void;
  disabled: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const stats = useMemo(() => {
    const m: Record<string, { calls: number; failed: number; faulted: number }> = {};
    for (const c of services) {
      const k = c.service;
      m[k] ??= { calls: 0, failed: 0, faulted: 0 };
      m[k].calls++;
      if (!c.ok) m[k].failed++;
      if (c.faultInjected) m[k].faulted++;
    }
    return m;
  }, [services]);
  const pivotIdx = steps.findIndex((s) => s.kind === "pivot");

  return (
    <Panel
      className={className}
      kicker="Mock services · this sandbox only"
      title="Saga & chaos"
      right={
        faults.length > 0 ? (
          <button type="button" className="btn btn-ghost !px-2 !py-1 !text-[0.68rem]" onClick={onClearFaults} disabled={disabled}>
            <RotateCcw className="size-3" aria-hidden /> Clear faults
          </button>
        ) : (
          <ModeBadge badge="MOCK SERVICE" />
        )
      }
      bodyClassName="overflow-y-auto scroll-thin"
    >
      <div className="grid grid-cols-2 gap-1.5 p-3">
        {SERVICES.map((svc) => {
          const active = faults.filter((f) => f.service === svc.key);
          const st = stats[svc.key];
          const isOpen = open === svc.key;
          return (
            <div key={svc.key} className={cn("rounded-xl p-2.5 transition-colors duration-200", active.length ? "bg-bad-wash shadow-[inset_0_0_0_1px_rgba(168,53,42,0.35)]" : "bg-paper-2/70 shadow-[inset_0_0_0_1px_var(--line)]")}>
              <button type="button" className="flex w-full items-center justify-between gap-1 text-left" onClick={() => setOpen(isOpen ? null : svc.key)} aria-expanded={isOpen}>
                <span className="flex items-center gap-1.5 text-[0.76rem] font-bold">
                  <span className={cn("size-2 rounded-full", active.length ? "bg-bad" : "bg-ok")} aria-hidden />
                  {svc.label}
                </span>
                <ChevronDown className={cn("size-3.5 text-muted transition-transform duration-200", isOpen && "rotate-180")} aria-hidden />
              </button>
              <p className="mono mt-1 text-[0.6rem] text-muted">
                {active.length ? (
                  <span className="font-semibold text-bad">
                    <Zap className="mr-0.5 inline size-2.5" aria-hidden />
                    {active.map((f) => `${f.operation}: ${f.mode}`).join(" · ")}
                  </span>
                ) : st ? (
                  `${st.calls} calls${st.failed ? ` · ${st.failed} failed` : ""}`
                ) : (
                  "healthy · no calls yet"
                )}
              </p>
              {isOpen && (
                <div className="mt-2 space-y-1.5">
                  {svc.ops.map((op) => {
                    const f = active.find((x) => x.operation === op);
                    return (
                      <label key={op} className="flex items-center justify-between gap-2 text-[0.64rem]">
                        <span className="mono truncate">{op}</span>
                        <select
                          className="mono max-w-[8.5rem] rounded-md bg-card px-1 py-0.5 text-[0.62rem] shadow-[inset_0_0_0_1px_var(--line-strong)]"
                          value={f?.mode ?? "healthy"}
                          disabled={disabled}
                          onChange={(e) => onFault(svc.key, op, e.target.value)}
                          aria-label={`${svc.label} ${op} fault`}
                        >
                          {MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-3 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[0.8rem] font-bold wide">
            Saga ledger {sagaId && <span className="mono ml-1 text-[0.62rem] font-normal text-muted">{sagaId}</span>}
          </p>
          {sagaStatus && <StatusChip status={sagaStatus} />}
        </div>
        {crashed && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-bad-wash px-3 py-2 text-[0.72rem] text-bad">
            <span>The process “crashed” mid-saga. The log in Postgres knows exactly where it stopped.</span>
            <button type="button" className="btn btn-ink !px-2.5 !py-1.5 !text-[0.68rem]" onClick={onRecover} disabled={disabled}>
              <LifeBuoy className="size-3" aria-hidden /> Recover
            </button>
          </div>
        )}
        {steps.length === 0 ? (
          <p className="rounded-lg bg-paper-2/60 px-3 py-4 text-center text-[0.74rem] text-muted">The saga log appears once an approved plan executes.</p>
        ) : (
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={s.seq}>
                {i === pivotIdx && (
                  <div className="my-1.5 flex items-center gap-2" aria-hidden>
                    <span className="h-px flex-1 bg-signal-deep" />
                    <span className="mono text-[0.56rem] font-bold uppercase tracking-wider text-signal-ink">pivot · cannot be undone</span>
                    <span className="h-px flex-1 bg-signal-deep" />
                  </div>
                )}
                <div className={cn("flex items-start justify-between gap-2 rounded-lg px-2.5 py-1.5", s.kind === "pivot" ? "bg-signal-wash" : "bg-paper-2/50", s.status === "RUNNING" && "ring-1 ring-signal")}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[0.74rem] font-semibold">
                      <span className="mono text-[0.6rem] text-muted">{String(s.seq).padStart(2, "0")}</span>
                      {STEP_LABEL[s.name] ?? s.name}
                      <span className="mono rounded bg-card px-1 text-[0.54rem] font-semibold uppercase text-muted shadow-[inset_0_0_0_1px_var(--line)]">{s.kind === "reversible" ? "rev" : s.kind === "pivot" ? "pivot" : "retry"}</span>
                      {s.faultInjected && <ModeBadge badge="FAULT-INJECTED" className="!h-4 !text-[0.52rem]" />}
                    </p>
                    {s.message && <p className="mono mt-0.5 break-words text-[0.6rem] leading-snug text-muted">{s.message}</p>}
                  </div>
                  <StatusChip status={s.status} label={stepLabel(s)} />
                </div>
              </li>
            ))}
          </ol>
        )}
        {ticketStatus && (
          <p className="mt-2 text-[0.7rem] text-muted">
            Ticket status: <span className="font-semibold text-ink">{ticketStatus.replace(/_/g, " ")}</span>
          </p>
        )}
      </div>
    </Panel>
  );
}
