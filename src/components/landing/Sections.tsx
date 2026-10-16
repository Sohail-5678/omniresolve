import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { SCENARIOS } from "@/lib/scenarios";
import type { ResultMeta } from "@/lib/results";
import { CropMarks, LogoMark } from "@/components/art/marks";
import { GITHUB_URL } from "./Hero";
import { cn } from "@/lib/client/cn";

/* ------------------------------------------------------------------ cases */

const CASE_TONES = ["bg-ink text-paper", "bg-signal text-ink", "bg-card text-ink shadow-[0_0_0_1px_var(--line)]", "bg-paper-2 text-ink"];

export function Cases() {
  const groups = [
    SCENARIOS.filter((s) => s.number === "01"),
    SCENARIOS.filter((s) => s.number.startsWith("02")),
    SCENARIOS.filter((s) => s.number === "03"),
    SCENARIOS.filter((s) => s.number === "04"),
  ];
  return (
    <section id="cases" className="mx-auto max-w-[1280px] px-5 pt-28 sm:px-8 sm:pt-36">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h2 className="display text-[clamp(2.4rem,5.8vw,5.2rem)]">
          Four cases.
          <br />
          One bad day.
        </h2>
        <p className="max-w-sm text-[1rem] leading-relaxed text-ink-soft">
          Each case runs for real in your own sandbox: mock billing, orders, carriers and tickets, with chaos switches you control.
        </p>
      </div>
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {groups.map((g, i) => {
          const head = g[0];
          return (
            <article key={head.id} className={cn("relative flex min-h-[340px] flex-col overflow-hidden rounded-[22px] p-7 sm:p-9", CASE_TONES[i])}>
              {i === 1 && <CropMarks inset={14} size={12} />}
              <div className="flex items-baseline justify-between gap-4">
                <span className="display text-[3.4rem] leading-none">{head.number.slice(0, 2)}.</span>
                <span className="eyebrow opacity-70">{head.kicker}</span>
              </div>
              <h3 className="display-tight mt-6 text-[1.7rem] leading-[1.02]">{i === 1 ? "When the systems fail" : head.title}</h3>
              <p className={cn("mt-4 max-w-[34rem] text-[0.95rem] leading-relaxed", i === 0 ? "text-paper/75" : "text-ink-soft")}>
                {i === 1 ? "Three faults, three behaviours: a carrier outage fails over, an orders outage before the refund rolls everything back, and a refund whose response is lost is paid exactly once." : head.summary}
              </p>
              <div className="mt-auto flex flex-wrap gap-2 pt-7">
                {g.map((s) => (
                  <Link
                    key={s.id}
                    href={`/console?scenario=${s.id}`}
                    className={cn("btn !py-2.5 !text-[0.76rem]", i === 0 ? "btn-signal" : i === 1 ? "btn-ink" : "btn-ink")}
                  >
                    {g.length > 1 ? `${s.number} · ${s.kicker}` : "Run this case"}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ pivot */

const STEPS = [
  { n: 1, label: "Open ticket", kind: "rev" },
  { n: 2, label: "Reserve stock", kind: "rev" },
  { n: 3, label: "Return label", kind: "rev" },
  { n: 4, label: "Draft replacement", kind: "rev" },
  { n: 5, label: "Refund", kind: "pivot" },
  { n: 6, label: "Confirm replacement", kind: "fwd" },
  { n: 7, label: "Close ticket", kind: "fwd" },
  { n: 8, label: "Notify (preview)", kind: "fwd" },
] as const;

export function Pivot() {
  return (
    <section id="pivot" className="mx-auto max-w-[1280px] px-5 pt-28 sm:px-8 sm:pt-36">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
        <h2 className="display text-[clamp(2.4rem,5.8vw,5.2rem)]">
          The refund
          <br />
          goes last.
        </h2>
        <p className="max-w-lg text-[1.02rem] leading-relaxed text-ink-soft lg:justify-self-end">
          A refund can&apos;t truly be undone — reversing one means charging the customer again. So every reversible step runs first, and the refund is the pivot. Before it, any failure unwinds in reverse. After it, we never claw money back: we retry, then hand the rest to an operations outbox and tell the customer the truth.
        </p>
      </div>
      <div className="mt-12 overflow-x-auto pb-2 scroll-thin">
        <ol className="flex min-w-[860px] items-stretch gap-2">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className={cn(
                "relative flex flex-1 flex-col justify-between rounded-2xl p-4",
                s.kind === "pivot" ? "flex-[1.5] bg-signal text-ink" : s.kind === "rev" ? "bg-card shadow-[inset_0_0_0_1.5px_var(--ink)]" : "bg-ink text-paper",
              )}
            >
              <span className="mono text-[0.68rem] font-semibold opacity-70">{String(s.n).padStart(2, "0")}</span>
              <span className={cn("mt-8 font-semibold leading-tight wide", s.kind === "pivot" ? "display-tight text-[1.5rem]" : "text-[0.95rem]")}>{s.label}</span>
              <span className="mono mt-3 text-[0.62rem] uppercase tracking-wider opacity-70">
                {s.kind === "rev" ? "reversible" : s.kind === "pivot" ? "pivot · irreversible" : "retry → outbox"}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-4 grid min-w-[860px] grid-cols-[4fr_1.5fr_3fr] gap-2 text-[0.8rem] font-semibold">
          <p className="flex items-center gap-2 border-t-2 border-dashed border-ink pt-3">← fails here: compensate 4 → 3 → 2 → 1, nothing charged</p>
          <p className="border-t-2 border-signal-deep pt-3 text-signal-ink">unknown outcome: reconcile against the ledger</p>
          <p className="border-t-2 border-ink pt-3">fails here: keep the refund, retry, write to the outbox →</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ receipts */

type Receipt = { key: string; label: string; value: (r: ResultMeta) => string | null; detail: (r: ResultMeta) => string };

function pct(x: unknown): string | null {
  return typeof x === "number" ? `${(x * 100).toFixed(x === 0 || x === 1 ? 0 : 1)}%` : null;
}
function num(x: unknown): string | null {
  return typeof x === "number" ? String(x) : null;
}

const RECEIPTS: Receipt[] = [
  { key: "redteam", label: "unauthorized state changes under attack", value: (r) => num(r.metrics?.unauthorizedStateChanges), detail: (r) => `${r.n ?? "?"} attacks · planner proposed unsafe actions in ${pct(r.metrics?.plannerFooledRate) ?? "?"}` },
  { key: "chaos", label: "saga integrity violations under faults", value: (r) => num(r.metrics?.integrityViolations), detail: (r) => `${r.n ?? "?"} fault-injected runs · recovery ${pct(r.metrics?.recoveryRate) ?? "?"}` },
  { key: "scenarios", label: "task success (final DB state)", value: (r) => pct(r.metrics?.taskSuccess), detail: (r) => `pass^${(r.config as { k?: number } | undefined)?.k ?? "k"} ${pct(r.metrics?.passK) ?? "?"} · ${r.n ?? "?"} scenarios` },
  { key: "retrieval", label: "stale clauses in top-3 (naive → temporal)", value: (r) => (typeof r.metrics?.staleNaive === "number" && typeof r.metrics?.staleTemporal === "number" ? `${pct(r.metrics.staleNaive)} → ${pct(r.metrics.staleTemporal)}` : null), detail: (r) => `${r.n ?? "?"} queries · recall@3 ${pct(r.metrics?.recallAt3Temporal) ?? "?"}` },
];

export function Receipts({ results }: { results: Record<string, ResultMeta> }) {
  return (
    <section id="receipts" className="mx-auto max-w-[1280px] px-5 pt-28 sm:px-8 sm:pt-36">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h2 className="display text-[clamp(2.4rem,5.8vw,5.2rem)]">Receipts.</h2>
        <p className="max-w-md text-[1rem] leading-relaxed text-ink-soft">
          No invented numbers. Each figure is read from a committed result file, with its sample size, date and commit. Evals run locally — the public site never burns the shared quota.
        </p>
      </div>
      <div className="mt-12 grid gap-px overflow-hidden rounded-[22px] bg-line shadow-[0_0_0_1px_var(--line)] sm:grid-cols-2 lg:grid-cols-4">
        {RECEIPTS.map((rc) => {
          const r = results[rc.key];
          const v = r ? rc.value(r) : null;
          return (
            <div key={rc.key} className="flex min-h-[220px] flex-col bg-card p-6">
              <span className="badge badge-eval w-fit">{r ? `eval · ${r.date ?? "?"} · ${r.commit ?? "local"}` : "eval · not run yet"}</span>
              {v ? (
                <span className={cn("display mt-6 leading-none tabular", v.length > 6 ? "text-[2.4rem]" : "text-[3.6rem]")}>{v}</span>
              ) : (
                <span className="display-tight mt-6 text-[1.6rem] text-muted">Not run yet</span>
              )}
              <span className="mt-3 text-[0.9rem] font-semibold leading-snug">{rc.label}</span>
              <span className="mono mt-auto pt-5 text-[0.68rem] text-muted">{r ? rc.detail(r) : "run the eval locally to fill this in"}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[0.8rem] text-muted">
        Full tables, confidence intervals and failure taxonomy are in the console&apos;s Evals drawer and in{" "}
        <a className="underline underline-offset-2" href={`${GITHUB_URL}/blob/main/docs/EVALS.md`} target="_blank" rel="noreferrer">
          docs/EVALS.md
        </a>
        .
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ footer */

export function SiteFooter() {
  return (
    <footer className="px-3 pt-28 sm:px-4 sm:pt-36">
      <div className="poster poster-grain relative px-6 pb-8 pt-12 sm:px-12">
        <CropMarks inset={18} />
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-8">
          <div className="max-w-md">
            <LogoMark className="size-10" />
            <p className="mt-5 text-[1rem] leading-relaxed">
              All business systems here are <strong>mocks</strong> with fictional customers. Refunds move fake money in your private sandbox, which is deleted after 24 hours.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/console" className="btn btn-ink">
              Open the console <ArrowRight className="size-4" aria-hidden />
            </Link>
            <a href={GITHUB_URL} className="btn btn-paper" target="_blank" rel="noreferrer">
              Source on GitHub <ArrowUpRight className="size-4" aria-hidden />
            </a>
          </div>
        </div>
        <p className="display relative z-10 mt-14 select-none whitespace-nowrap text-[clamp(2.2rem,10.1vw,11.4rem)] leading-[0.8]">OmniResolve</p>
        <div className="relative z-10 mt-8 flex flex-wrap justify-between gap-3 border-t border-ink/25 pt-5 text-[0.75rem] font-semibold">
          <span>Built by Ameer Sohail Shaik · TypeScript, LangGraph.js, Next.js, Postgres</span>
          <span className="mono">MIT · $0 infrastructure</span>
        </div>
      </div>
    </footer>
  );
}
