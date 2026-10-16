"use client";

/** Console top bar: case picker, Replay/Live switch (with bring-your-own-key), sandbox, tools. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookOpenText, ChevronDown, FlaskConical, KeyRound, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/client/cn";
import { hoursLeft } from "@/lib/client/format";
import { SCENARIOS, type Scenario } from "@/lib/scenarios";
import { LogoMark } from "@/components/art/marks";

export type SessionInfo = {
  sandboxId: string;
  expiresAt: string;
  businessDate: string;
  defaultMode: "replay" | "live";
  live: { serverKeys: boolean; dailyCap: number; usedToday: number; available: boolean; byokAllowed: boolean };
  replay: { entries: number; models: string[] };
};

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onOut();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [ref, onOut, active]);
}

export function TopBar({
  session,
  scenario,
  onScenario,
  mode,
  onMode,
  byokKey,
  onByok,
  onReset,
  onOpen,
  busy,
}: {
  session: SessionInfo | null;
  scenario: Scenario | undefined;
  onScenario: (id: string) => void;
  mode: "replay" | "live";
  onMode: (m: "replay" | "live") => void;
  byokKey: string;
  onByok: (k: string) => void;
  onReset: () => void;
  onOpen: (d: "rag" | "evals") => void;
  busy: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLDivElement>(null);
  useOutside(menuRef, () => setMenu(false), menu);
  useOutside(keyRef, () => setKeyOpen(false), keyOpen);
  const liveReady = !!byokKey || !!session?.live.available;

  return (
    <header className="relative z-30 flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 bg-ink px-3 py-2 text-paper sm:px-4">
      <Link href="/" className="flex items-center gap-2 pr-1" aria-label="OmniResolve home">
        <LogoMark className="size-7" color="var(--signal)" />
        <span className="display hidden text-[0.85rem] sm:inline">OmniResolve</span>
      </Link>
      <span className="hidden h-6 w-px bg-paper/15 sm:block" aria-hidden />

      <div ref={menuRef} className="relative min-w-0">
        <button type="button" disabled={busy} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} className="flex max-w-[52vw] items-center gap-2 rounded-xl bg-paper/8 px-3 py-2 text-left text-[0.78rem] font-semibold transition-colors hover:bg-paper/12 disabled:opacity-50 sm:max-w-none">
          <span className="mono rounded bg-signal px-1.5 py-0.5 text-[0.62rem] font-bold text-ink">{scenario?.number ?? "—"}</span>
          <span className="truncate">{scenario?.title ?? "Choose a case"}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
        {menu && (
          <div role="menu" className="rise absolute left-0 top-[calc(100%+6px)] w-[min(420px,92vw)] overflow-hidden rounded-2xl bg-paper text-ink shadow-[0_24px_48px_-16px_rgba(0,0,0,0.5)]">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onScenario(s.id);
                }}
                className={cn("flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-paper-2", s.id === scenario?.id && "bg-signal-wash")}
              >
                <span className="display w-9 shrink-0 text-[1.05rem] leading-tight">{s.number}</span>
                <span className="min-w-0">
                  <span className="block text-[0.82rem] font-bold leading-snug">{s.title}</span>
                  <span className="eyebrow mt-0.5 block text-muted">{s.kicker}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="pill-toggle sm !bg-paper/10" role="group" aria-label="Model mode">
          <button type="button" data-active={mode === "replay"} disabled={busy} onClick={() => onMode("replay")} className="!text-paper/80 data-[active=true]:!text-ink">
            Replay
          </button>
          <button
            type="button"
            data-active={mode === "live"}
            disabled={busy}
            onClick={() => {
              onMode("live");
              if (!liveReady) setKeyOpen(true);
            }}
            className="!text-paper/80 data-[active=true]:!text-ink"
          >
            Live
          </button>
        </div>
        <div ref={keyRef} className="relative">
          <button type="button" onClick={() => setKeyOpen(!keyOpen)} className={cn("btn !rounded-[10px] !px-2 !py-1.5", byokKey ? "bg-ok text-paper" : "bg-paper/10 text-paper hover:bg-paper/15")} aria-label="Use your own API key" aria-expanded={keyOpen}>
            <KeyRound className="size-3.5" aria-hidden />
          </button>
          {keyOpen && (
            <div className="rise absolute right-0 top-[calc(100%+6px)] w-[300px] rounded-2xl bg-paper p-4 text-ink shadow-[0_24px_48px_-16px_rgba(0,0,0,0.5)]">
              <p className="text-[0.8rem] font-bold">Live mode</p>
              <p className="mt-1 text-[0.72rem] leading-relaxed text-muted">
                {session?.live.available
                  ? `Server keys are on (${session.live.usedToday}/${session.live.dailyCap} shared calls used today). Add your own Groq key to skip the shared quota.`
                  : "The shared quota isn't available. Paste your own Groq key — it stays in this tab's memory and is sent only with your requests, never stored."}
              </p>
              <label className="mt-3 block text-[0.7rem] font-semibold">
                Groq API key
                <input
                  type="password"
                  autoComplete="off"
                  value={byokKey}
                  onChange={(e) => onByok(e.target.value.trim())}
                  placeholder="gsk_…"
                  className="mono mt-1 w-full rounded-lg bg-card px-2.5 py-2 text-[0.76rem] shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none"
                />
              </label>
            </div>
          )}
        </div>
        <span className="hidden h-6 w-px bg-paper/15 md:block" aria-hidden />
        <button type="button" onClick={() => onOpen("rag")} className="btn !rounded-[10px] bg-paper/10 !px-2.5 !py-1.5 !text-[0.72rem] text-paper hover:bg-paper/15">
          <Search className="size-3.5" aria-hidden /> <span className="hidden md:inline">Inspector</span>
        </button>
        <button type="button" onClick={() => onOpen("evals")} className="btn !rounded-[10px] bg-paper/10 !px-2.5 !py-1.5 !text-[0.72rem] text-paper hover:bg-paper/15">
          <FlaskConical className="size-3.5" aria-hidden /> <span className="hidden md:inline">Evals</span>
        </button>
        <a href="https://github.com/Sohail-5678/omniresolve" target="_blank" rel="noreferrer" className="btn hidden !rounded-[10px] bg-paper/10 !px-2.5 !py-1.5 text-paper hover:bg-paper/15 lg:inline-flex" aria-label="Source on GitHub">
          <BookOpenText className="size-3.5" aria-hidden />
        </a>
        {session && (
          <span className="mono hidden items-center gap-1.5 rounded-[10px] bg-paper/6 px-2.5 py-1.5 text-[0.62rem] text-paper/70 xl:inline-flex" title="Your private sandbox. Data, chaos switches and approvals here affect nobody else.">
            {session.sandboxId.slice(0, 10)}… · {hoursLeft(session.expiresAt)}
          </span>
        )}
        <button type="button" onClick={onReset} disabled={busy} className="btn !rounded-[10px] bg-signal !px-2.5 !py-1.5 !text-[0.72rem] text-ink hover:bg-signal-soft" title="Fresh sandbox: reseed data, clear faults and threads">
          <RefreshCw className="size-3.5" aria-hidden /> <span className="hidden sm:inline">Reset</span>
        </button>
      </div>
    </header>
  );
}
