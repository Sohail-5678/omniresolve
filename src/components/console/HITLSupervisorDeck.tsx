"use client";

/**
 * Supervisor approval docket (N5). Shows exactly what will change in each system, the gate's
 * checks and reasons, the cited policy text and risk signals. Approve, modify (lower the
 * amount, drop actions — never above what was paid) or reject. The run then resumes live.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Gavel, Pencil, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { cents, humanize } from "@/lib/client/format";
import type { ApprovalCard, HitlDecision } from "@/lib/agent/state";
import type { SupervisorPreset } from "@/lib/scenarios";
import { CropMarks } from "@/components/art/marks";
import { StatusChip } from "./ui";

export function HITLSupervisorDeck({
  card,
  presets,
  mode,
  busy,
  onDecide,
}: {
  card: ApprovalCard;
  presets: SupervisorPreset[];
  mode: "replay" | "live";
  busy: boolean;
  onDecide: (d: HitlDecision) => void;
}) {
  const live = useMemo(() => card.decisions.filter((d) => d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED"), [card]);
  const denied = useMemo(() => card.decisions.filter((d) => d.status === "DENIED"), [card]);
  const money = live.find((d) => d.action.type === "refund" || d.action.type === "store_credit");
  const moneyAmount = money && "amountCents" in money.action ? money.action.amountCents : undefined;
  const maxForMoney = money && "orderId" in money.action && money.action.orderId ? card.maxRefundableCents[money.action.orderId] : undefined;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(moneyAmount !== undefined ? (moneyAmount / 100).toFixed(2) : "");
  const [removed, setRemoved] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const amountCents = Math.round(Number(amount) * 100);
  const amountValid = !money || (Number.isFinite(amountCents) && amountCents > 0 && (maxForMoney === undefined || amountCents <= maxForMoney));
  const isPresetEquivalent = moneyAmount === amountCents;

  const applyPreset = (p: SupervisorPreset) => {
    const removeActions = (p.decision.removeActionsOfType ?? []).flatMap((t) => live.filter((d) => d.action.type === t).map((d) => d.index));
    onDecide({ decision: p.decision.decision, note: p.decision.note, amountCents: p.decision.amountCents, removeActions: removeActions.length ? removeActions : undefined });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/45 p-0 sm:items-center sm:p-6" role="presentation">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="hitl-title" className="rise flex max-h-[96dvh] w-full max-w-[980px] flex-col overflow-hidden rounded-t-[24px] bg-paper shadow-[0_40px_80px_-30px_rgba(28,26,23,0.6)] outline-none sm:rounded-[24px]">
        <div className="poster relative shrink-0 rounded-none px-6 pb-5 pt-6 sm:px-8">
          <CropMarks inset={12} size={12} />
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="eyebrow flex items-center gap-1.5 text-ink/75">
                <Gavel className="size-3.5" aria-hidden /> N5 · interrupt() · checkpoint saved
              </p>
              <h2 id="hitl-title" className="display mt-2 text-[clamp(1.8rem,4vw,2.8rem)]">
                Supervisor
                <br className="sm:hidden" /> approval
              </h2>
            </div>
            <div className="text-right">
              <p className="mono text-[0.66rem] font-semibold uppercase">Exposure</p>
              <p className="display text-[2rem] leading-none tabular">{cents(card.totalExposureCents)}</p>
              <p className="mono mt-1 text-[0.66rem] font-semibold">auto-limit {cents(card.autoLimitCents)}</p>
            </div>
          </div>
          <div className="relative z-10 mt-4 flex flex-wrap gap-1.5">
            {card.humanReasons.map((r) => (
              <span key={r} className="mono rounded-md bg-ink px-2 py-1 text-[0.62rem] font-semibold text-signal-soft">
                {humanize(r)}
              </span>
            ))}
            {card.riskSignals.map((r) => (
              <span key={r} className="mono inline-flex items-center gap-1 rounded-md bg-bad-wash px-2 py-1 text-[0.62rem] font-semibold text-bad">
                <ShieldAlert className="size-3" aria-hidden /> {r.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 scroll-thin sm:px-8">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8rem]">
                <span className="font-bold">{card.customer.name}</span>
                <span className="mono rounded bg-ink px-1.5 text-[0.6rem] font-bold uppercase text-paper">{card.customer.tier}</span>
                <span className="text-muted">LTV {cents(card.customer.lifetimeValueCents)}</span>
                <span className="text-muted">{card.customer.openTickets} open tickets</span>
              </div>
              <p className="rounded-xl bg-card p-3 text-[0.86rem] leading-relaxed shadow-[0_0_0_1px_var(--line)]">
                <span className="eyebrow mb-1 block text-muted">Complaint</span>
                {card.complaint}
              </p>

              <div>
                <p className="eyebrow mb-2 text-muted">What will change</p>
                <ul className="overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line)]">
                  {card.diff.map((d, i) => (
                    <li key={i} className={cn("grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 px-3 py-2.5 text-[0.8rem]", i % 2 ? "bg-card" : "bg-paper-2/40", !d.reversible && "bg-signal-wash")}>
                      <span className="mono text-[0.64rem] font-semibold uppercase text-muted">{d.system}</span>
                      <span className="leading-snug">{d.change}</span>
                      <span className="mono text-[0.72rem] font-semibold tabular">{d.amountCents !== undefined ? cents(d.amountCents) : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <details className="group rounded-xl bg-card shadow-[0_0_0_1px_var(--line)]">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[0.78rem] font-semibold">
                  Gate checks ({live.length + denied.length} actions)
                  <span className="text-muted transition-transform group-open:rotate-180">▾</span>
                </summary>
                <div className="space-y-3 border-t border-line px-3 py-3">
                  {[...live, ...denied].map((d) => (
                    <div key={d.index}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[0.76rem] font-bold">
                          {humanize(d.action.type)}
                          {"amountCents" in d.action ? ` · ${cents(d.action.amountCents)}` : ""}
                          {d.addedByGate && <span className="ml-1.5 text-[0.62rem] font-semibold text-info">added by gate</span>}
                        </p>
                        <StatusChip status={d.status} />
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {d.checks.map((c) => (
                          <li key={c.code} className={cn("flex gap-1.5 text-[0.68rem] leading-snug", c.pass ? "text-ink-soft" : "font-semibold text-bad")}>
                            {c.pass ? <Check className="mt-0.5 size-3 shrink-0 text-ok" aria-hidden /> : <X className="mt-0.5 size-3 shrink-0" aria-hidden />}
                            <span>
                              <span className="mono">{c.code}</span> — {c.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </details>
            </div>

            <div className="space-y-4">
              <div>
                <p className="eyebrow mb-2 text-muted">Cited policy</p>
                {card.clauses.length === 0 ? (
                  <p className="text-[0.76rem] text-muted">The planner cited no clauses.</p>
                ) : (
                  <ul className="space-y-2">
                    {card.clauses.map((c) => (
                      <li key={c.citation} className="rounded-xl bg-card p-3 text-[0.74rem] leading-relaxed shadow-[0_0_0_1px_var(--line)]">
                        <p className="mono mb-1 text-[0.62rem] font-bold text-signal-deep">{c.citation}</p>
                        {c.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {card.rationale && (
                <p className="text-[0.74rem] leading-relaxed text-muted">
                  <span className="font-semibold text-ink">Planner rationale:</span> {card.rationale}
                </p>
              )}
            </div>
          </div>

          {editing && (
            <div className="mt-5 rounded-xl bg-card p-4 shadow-[inset_0_0_0_1.5px_var(--ink)]">
              <p className="text-[0.8rem] font-bold">Modify the resolution</p>
              {money && (
                <label className="mt-3 block text-[0.74rem]">
                  {humanize(money.action.type)} amount (max {cents(maxForMoney ?? moneyAmount ?? 0)} — never more than was paid)
                  <div className="mt-1 flex items-center gap-1">
                    <span className="mono text-[0.9rem]">$</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                      className="mono w-36 rounded-lg bg-paper px-2 py-1.5 text-[0.9rem] shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--signal-deep)]"
                      aria-invalid={!amountValid}
                    />
                  </div>
                  {!amountValid && <span className="mt-1 block text-[0.7rem] font-semibold text-bad">Enter an amount above $0 and no more than what was paid.</span>}
                </label>
              )}
              <fieldset className="mt-3">
                <legend className="text-[0.74rem]">Remove actions</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {live
                    .filter((d) => d !== money)
                    .map((d) => (
                      <label key={d.index} className="flex items-center gap-1.5 rounded-lg bg-paper-2 px-2 py-1 text-[0.72rem]">
                        <input type="checkbox" checked={removed.includes(d.index)} onChange={(e) => setRemoved(e.target.checked ? [...removed, d.index] : removed.filter((x) => x !== d.index))} />
                        {humanize(d.action.type)}
                      </label>
                    ))}
                </div>
              </fieldset>
              {mode === "replay" && !isPresetEquivalent && <p className="mt-2 text-[0.7rem] text-warn">Custom amounts were not recorded, so the reply will use the verified template.</p>}
            </div>
          )}

          <label className="mt-4 block text-[0.74rem] text-muted">
            Note for the record (optional)
            <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} className="mt-1 w-full rounded-lg bg-card px-3 py-2 text-[0.82rem] text-ink shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none" />
          </label>
        </div>

        <div className="shrink-0 border-t border-line bg-card px-6 py-4 sm:px-8">
          {presets.length > 0 && !editing && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="eyebrow mr-1 text-muted">Recorded choices</span>
              {presets.map((p) => (
                <button key={p.label} type="button" disabled={busy} onClick={() => applyPreset(p)} className="rounded-full bg-paper-2 px-3 py-1.5 text-[0.72rem] font-semibold shadow-[inset_0_0_0_1px_var(--line)] hover:bg-paper-3 disabled:opacity-50">
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => onDecide({ decision: "reject", note: note || undefined })}>
              <X className="size-4" aria-hidden /> Reject & escalate
            </button>
            {editing ? (
              <button
                type="button"
                disabled={busy || !amountValid}
                className="btn btn-signal"
                onClick={() => onDecide({ decision: "modify", amountCents: money ? amountCents : undefined, removeActions: removed.length ? removed : undefined, note: note || undefined })}
              >
                <Check className="size-4" aria-hidden /> Approve modified plan
              </button>
            ) : (
              <button type="button" disabled={busy} className="btn btn-paper" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden /> Modify
              </button>
            )}
            <button type="button" disabled={busy} className="btn btn-ink" onClick={() => onDecide({ decision: "approve", note: note || undefined })}>
              <Check className="size-4" aria-hidden /> Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
