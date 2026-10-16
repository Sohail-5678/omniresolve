"use client";

/** Console primitives: badges, status chips, panels, switch, drawer. Colour never stands alone. */
import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, Check, CircleDashed, Loader2, RotateCcw, ShieldAlert, X, Zap } from "lucide-react";
import { cn } from "@/lib/client/cn";

export function ModeBadge({ badge, className }: { badge?: string | null; className?: string }) {
  if (!badge) return null;
  const map: Record<string, string> = {
    LIVE: "badge-live",
    REPLAY: "badge-replay",
    "MOCK SERVICE": "badge-mock",
    "FAULT-INJECTED": "badge-fault",
    CODE: "badge-code",
    FIREWALL: "badge-fault",
    EVAL: "badge-eval",
  };
  return (
    <span className={cn("badge", map[badge] ?? "badge-mock", className)}>
      {badge === "LIVE" && <span className="size-1.5 rounded-full bg-ok" aria-hidden />}
      {badge === "FAULT-INJECTED" && <Zap className="size-2.5" aria-hidden />}
      {badge}
    </span>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "ink" | "signal" | "muted";

const STATUS_TONE: Record<string, Tone> = {
  DONE: "ok",
  RESOLVED: "ok",
  AUTO_APPROVED: "ok",
  RECONCILED: "ok",
  COMPENSATED: "info",
  ROLLED_BACK: "info",
  RUNNING: "signal",
  RETRY: "warn",
  FAILOVER: "warn",
  NEEDS_HUMAN: "warn",
  AWAITING_APPROVAL: "warn",
  PENDING_FULFILLMENT: "warn",
  REFUNDED_PENDING_FULFILLMENT: "warn",
  OUTBOX: "warn",
  ESCALATED: "warn",
  NEEDS_INFO: "info",
  COMPENSATING: "info",
  FAILED: "bad",
  DENIED: "bad",
  REJECTED: "bad",
  BLOCKED: "bad",
  COMPENSATION_FAILED: "bad",
  UNAVAILABLE: "muted",
  DELAYED: "warn",
  PENDING: "muted",
  SKIPPED: "muted",
  INFO: "muted",
};

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-ok-wash text-ok",
  warn: "bg-warn-wash text-warn",
  bad: "bg-bad-wash text-bad",
  info: "bg-info-wash text-info",
  ink: "bg-ink text-paper",
  signal: "bg-signal-wash text-signal-ink",
  muted: "bg-paper-2 text-muted",
};

function StatusIcon({ tone, status }: { tone: Tone; status: string }) {
  const cls = "size-3 shrink-0";
  if (status === "RUNNING") return <Loader2 className={cn(cls, "animate-spin")} aria-hidden />;
  if (status === "COMPENSATED" || status === "ROLLED_BACK" || status === "COMPENSATING") return <RotateCcw className={cls} aria-hidden />;
  if (tone === "ok") return <Check className={cls} aria-hidden />;
  if (tone === "bad") return <X className={cls} aria-hidden />;
  if (tone === "warn") return <AlertTriangle className={cls} aria-hidden />;
  return <CircleDashed className={cls} aria-hidden />;
}

export function StatusChip({ status, label, className }: { status: string; label?: string; className?: string }) {
  const tone = STATUS_TONE[status] ?? "muted";
  return (
    <span className={cn("inline-flex h-[1.35rem] items-center gap-1 whitespace-nowrap rounded-md px-1.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wide", TONE_CLASS[tone], className)}>
      <StatusIcon tone={tone} status={status} />
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Panel({ title, kicker, right, children, className, bodyClassName }: { title: string; kicker?: string; right?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("panel flex min-h-0 flex-col", className)} aria-label={title}>
      <div className="panel-head">
        <div className="min-w-0">
          {kicker && <p className="eyebrow text-muted">{kicker}</p>}
          <h2 className="truncate text-[0.95rem] font-bold wide">{title}</h2>
        </div>
        {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
      </div>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 text-[0.74rem] font-semibold disabled:opacity-50"
    >
      <span className={cn("relative h-[18px] w-[32px] rounded-full transition-colors duration-200", checked ? "bg-ink" : "bg-paper-3")}>
        <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-card shadow transition-transform duration-200 [transition-timing-function:var(--ease-out)]", checked ? "translate-x-[16px]" : "translate-x-[2px]")} />
      </span>
      {label}
    </button>
  );
}

export function Drawer({ open, onClose, title, kicker, children, width = "max-w-[860px]" }: { open: boolean; onClose: () => void; title: string; kicker?: string; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div className={cn("fixed inset-0 z-50 overflow-hidden", open ? "pointer-events-auto" : "pointer-events-none")} aria-hidden={!open}>
      <div className={cn("absolute inset-0 bg-ink/35 transition-opacity duration-200", open ? "opacity-100" : "opacity-0")} onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col bg-paper outline-none transition-[transform,visibility] duration-300 [transition-timing-function:var(--ease-drawer)]",
          width,
          open ? "visible translate-x-0 shadow-[-24px_0_48px_-24px_rgba(28,26,23,0.45)]" : "invisible translate-x-full",
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            {kicker && <p className="eyebrow text-muted">{kicker}</p>}
            <h2 className="display-tight mt-1 text-[1.6rem]">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost !p-2" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">{open && children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, body }: { icon?: ReactNode; title: string; body?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ?? <ShieldAlert className="size-5 text-muted" aria-hidden />}
      <p className="text-[0.85rem] font-semibold">{title}</p>
      {body && <p className="max-w-[26ch] text-[0.78rem] text-muted">{body}</p>}
    </div>
  );
}
