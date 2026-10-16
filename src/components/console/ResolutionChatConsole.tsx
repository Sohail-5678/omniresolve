"use client";

/**
 * The conversation. Agent replies carry a "verified" stamp from the grounding verifier (or a
 * labeled template fallback), the policy clauses they cite, and the mock-API calls made during
 * the turn. The scenario brief explains what to watch for before you send.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, BadgeCheck, ChevronDown, FileWarning, ShieldBan, Swords } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { ms } from "@/lib/client/format";
import type { Scenario } from "@/lib/scenarios";
import { CropMarks } from "@/components/art/marks";
import type { ChatItem, NodeId } from "./state";
import { ModeBadge, Panel, StatusChip, Switch } from "./ui";

const NODE_WORDS: Record<NodeId, string> = {
  n1_triage: "Reading the message",
  ask: "Asking a question",
  n2_context: "Loading orders, ledger and tracking",
  n3_retrieve: "Finding the policy in effect",
  n4a_plan: "Drafting a resolution",
  n4b_gate: "Checking it against policy",
  n5_hitl: "Waiting for a supervisor",
  n6_execute: "Executing the saga",
  n7_respond: "Writing and verifying the reply",
};

function Brief({ scenario, onSend, disabled, sent }: { scenario: Scenario; onSend: () => void; disabled: boolean; sent: boolean }) {
  return (
    <div className="poster relative rounded-[20px] p-5 sm:p-6">
      <CropMarks inset={10} size={11} />
      <div className="relative z-10">
        <div className="flex items-baseline justify-between gap-3">
          <span className="display text-[2.2rem] leading-none">{scenario.number}.</span>
          <span className="eyebrow text-ink/70">{scenario.kicker}</span>
        </div>
        <h3 className="display-tight mt-3 text-[1.35rem]">{scenario.title}</h3>
        <p className="mt-2 text-[0.86rem] leading-relaxed text-ink/85">{scenario.summary}</p>
        {scenario.faults.length > 0 && (
          <p className="mono mt-3 text-[0.66rem] font-semibold">
            Faults armed in your sandbox: {scenario.faults.map((f) => `${f.service}.${f.operation} → ${f.mode}`).join(", ")}
          </p>
        )}
        {scenario.watchFor.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {scenario.watchFor.map((w) => (
              <li key={w} className="rounded-full bg-ink/10 px-2.5 py-1 text-[0.68rem] font-semibold">
                {w}
              </li>
            ))}
          </ul>
        )}
        {scenario.message && !sent && (
          <div className="mt-4 rounded-xl bg-card/90 p-3 text-[0.82rem] leading-relaxed shadow-[inset_0_0_0_1px_var(--line)]">
            <p className="eyebrow mb-1 text-muted">The customer writes</p>“{scenario.message}”
            <div className="mt-3 flex justify-end">
              <button type="button" className="btn btn-ink !py-2" onClick={onSend} disabled={disabled}>
                Send this complaint <ArrowUp className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentBubble({ item }: { item: Extract<ChatItem, { kind: "agent" }> }) {
  const [open, setOpen] = useState(false);
  const clauses = item.facts?.clauses ?? [];
  return (
    <div className="rise mr-6 max-w-[620px] sm:mr-16">
      <div className="rounded-[18px] rounded-tl-md bg-card p-4 shadow-[0_0_0_1px_var(--line),0_8px_20px_-16px_rgba(28,26,23,0.5)]">
        <p className="whitespace-pre-wrap text-[0.9rem] leading-relaxed">{item.text}</p>
        {clauses.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {clauses.map((c) => (
              <span key={`${c.id}-${c.version}`} className="mono inline-flex items-center gap-1 rounded-md bg-paper-2 px-1.5 py-0.5 text-[0.6rem] font-semibold">
                <span className="text-signal-deep">{c.id}</span> {c.title} — v{c.version}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-1">
        {item.usedTemplate ? (
          <span className="badge badge-eval" title="The model's draft failed verification (or no model was available), so a reply built only from verified facts was sent.">
            <FileWarning className="size-2.5" aria-hidden /> template fallback
          </span>
        ) : item.verified ? (
          <span className="badge badge-live" title="Every amount, ID, clause and date in this reply was checked against verified facts.">
            <BadgeCheck className="size-2.5" aria-hidden /> verified{item.attempts > 1 ? ` · ${item.attempts} drafts` : ""}
          </span>
        ) : null}
        <ModeBadge badge={item.badge} />
        {item.outcome && <StatusChip status={item.outcome} />}
        {(item.services.length > 0 || item.llm.length > 0) && (
          <button type="button" className="inline-flex items-center gap-0.5 text-[0.66rem] font-semibold text-muted hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
            {item.services.length} API call{item.services.length === 1 ? "" : "s"} · {item.llm.length} model call{item.llm.length === 1 ? "" : "s"}
            <ChevronDown className={cn("size-3 transition-transform duration-200", open && "rotate-180")} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1.5 flex flex-wrap gap-1 pl-1">
          {item.llm.map((c, i) => (
            <li key={`l${i}`} className="mono rounded-md bg-info-wash px-1.5 py-0.5 text-[0.58rem] text-info">
              {c.node} · {c.model.replace("openai/", "")} · {c.inputTokens + c.outputTokens} tok
            </li>
          ))}
          {item.services.map((c, i) => (
            <li key={`s${i}`} className={cn("mono rounded-md px-1.5 py-0.5 text-[0.58rem]", c.ok ? "bg-paper-2 text-ink-soft" : "bg-bad-wash text-bad")}>
              {c.service}.{c.operation} {c.ok ? "✓" : `✗ ${c.status ?? ""}`} {ms(c.durationMs)}
              {c.faultInjected ? " · fault" : ""}
              {c.replayed ? " · idempotent replay" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResolutionChatConsole({
  chat,
  scenario,
  busy,
  activeNode,
  onSend,
  evidenceAttached,
  onEvidence,
  onForgedCall,
  mode,
  modeNote,
  className,
}: {
  chat: ChatItem[];
  scenario: Scenario | undefined;
  busy: boolean;
  activeNode: NodeId | null;
  onSend: (text: string) => void;
  evidenceAttached: boolean;
  onEvidence: (v: boolean) => void;
  onForgedCall?: () => void;
  mode: "replay" | "live";
  modeNote: string | null;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const sentAny = chat.some((c) => c.kind === "customer");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.length, busy, activeNode]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setDraft("");
  };

  return (
    <Panel
      className={className}
      kicker={scenario ? `Case ${scenario.number}` : "Conversation"}
      title={scenario?.title ?? "Your own complaint"}
      right={<Switch checked={evidenceAttached} onChange={onEvidence} label="Photo evidence" disabled={busy || sentAny} />}
      bodyClassName="flex flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 scroll-thin dot-grid">
        {chat.length === 0 && (
          <div className="rounded-2xl bg-card p-5 text-[0.86rem] leading-relaxed shadow-[0_0_0_1px_var(--line)]">
            Pick a case from the top bar, or write your own complaint below as the selected customer.
          </div>
        )}
        {chat.map((item) => {
          if (item.kind === "brief") return scenario ? <Brief key={item.id} scenario={scenario} onSend={() => submit(scenario.message)} disabled={busy} sent={sentAny} /> : null;
          if (item.kind === "customer")
            return (
              <div key={item.id} className="rise ml-10 flex justify-end sm:ml-24">
                <p className="max-w-[560px] whitespace-pre-wrap rounded-[18px] rounded-tr-md bg-ink px-4 py-3 text-[0.9rem] leading-relaxed text-paper">{item.text}</p>
              </div>
            );
          if (item.kind === "agent") return <AgentBubble key={item.id} item={item} />;
          if (item.kind === "guard")
            return (
              <div key={item.id} className="rise flex items-start gap-3 rounded-2xl bg-ink p-4 text-paper">
                <ShieldBan className="mt-0.5 size-5 shrink-0 text-signal" aria-hidden />
                <div>
                  <p className="mono text-[0.72rem] font-bold text-signal">{item.code}</p>
                  <p className="mt-1 text-[0.82rem] leading-relaxed text-paper/85">
                    A refund call with no approval token went straight to the tool boundary and was rejected: {item.message} No model was involved; this is the code-level lock.
                  </p>
                </div>
              </div>
            );
          return (
            <p
              key={item.id}
              className={cn(
                "rise mx-auto max-w-[560px] rounded-xl px-3 py-2 text-center text-[0.76rem] font-medium",
                item.tone === "warn" && "bg-warn-wash text-warn",
                item.tone === "bad" && "bg-bad-wash text-bad",
                item.tone === "ok" && "bg-ok-wash text-ok",
                item.tone === "info" && "bg-info-wash text-info",
              )}
            >
              {item.text}
            </p>
          );
        })}
        {busy && (
          <div className="flex items-center gap-2.5 pl-1 text-[0.78rem] font-semibold text-ink-soft" aria-live="polite">
            <span className="pulse-ring size-2.5 rounded-full bg-signal" aria-hidden />
            <span className="caret">{activeNode ? NODE_WORDS[activeNode] : "Starting"}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line bg-card/60 p-3">
        {modeNote && <p className="mb-2 rounded-lg bg-warn-wash px-3 py-1.5 text-[0.7rem] text-warn">{modeNote}</p>}
        {scenario?.suggestedReplies && scenario.suggestedReplies.length > 0 && (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 scroll-thin">
            {scenario.suggestedReplies.map((r) => (
              <button key={r} type="button" disabled={busy} onClick={() => submit(r)} className="shrink-0 rounded-full bg-paper-2 px-3 py-1.5 text-[0.72rem] font-medium shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-paper-3 disabled:opacity-50">
                {r}
              </button>
            ))}
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <label className="sr-only" htmlFor="composer">
            Message as the customer
          </label>
          <textarea
            id="composer"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder={mode === "replay" ? "Replay mode answers recorded messages — switch to Live to write anything" : "Write as the customer…"}
            className="max-h-36 min-h-[46px] flex-1 resize-none rounded-[14px] bg-card px-4 py-3 text-[0.88rem] shadow-[inset_0_0_0_1.5px_var(--ink)] outline-none placeholder:text-muted focus-visible:shadow-[inset_0_0_0_2px_var(--signal-deep)]"
          />
          <button type="submit" disabled={busy || !draft.trim()} className="btn btn-ink !size-[46px] !rounded-full !p-0" aria-label="Send">
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </form>
        {onForgedCall && (
          <button type="button" onClick={onForgedCall} disabled={busy} className="mt-2 inline-flex items-center gap-1.5 text-[0.72rem] font-semibold text-bad hover:underline disabled:opacity-50">
            <Swords className="size-3.5" aria-hidden /> Try to call the refund tool directly (no token)
          </button>
        )}
      </div>
    </Panel>
  );
}
