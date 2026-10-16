"use client";

/**
 * Retriever inspector: the same hybrid retriever the agent uses, run with and without the
 * temporal filter, showing BM25 / dense / RRF scores and ranks and which clauses the date
 * filter removed ("not in effect on <date>").
 */
import { useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { shortDate } from "@/lib/client/format";

type Row = {
  key: string;
  clauseId: string;
  title: string;
  version: string;
  citation: string;
  text: string;
  inEffect: boolean;
  governingDate: string;
  rank: number;
  scores: { bm25: number; bm25Rank: number; dense: number; denseRank: number; rrf: number };
};
type Result = { results: Row[]; removed: { key: string; clauseId: string; title: string; version: string; reason: string }[]; denseMode: string; candidates: number; timingMs: number };

const PRESETS = [
  { q: "Your returns policy gives me 90 days to send back an unused blanket", date: "2026-08-09" },
  { q: "I was charged twice for the same order", date: "2026-10-02" },
  { q: "my package never showed up and tracking stopped updating", date: "2025-12-28" },
  { q: "the glass arrived shattered, how long do I have to report it", date: "2024-11-20" },
];

function Table({ title, result, tone }: { title: string; result: Result; tone: "naive" | "temporal" }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[0.82rem] font-bold">{title}</p>
        <span className="mono text-[0.62rem] text-muted">
          {result.candidates} candidates · {result.timingMs} ms · dense: {result.denseMode}
        </span>
      </div>
      <ol className="space-y-1.5">
        {result.results.map((r) => (
          <li key={r.key} className={cn("rounded-xl p-3 shadow-[0_0_0_1px_var(--line)]", r.inEffect ? "bg-card" : "bg-bad-wash/60")}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[0.76rem] font-semibold">
                <span className="mono mr-1.5 text-muted">#{r.rank}</span>
                <span className="mono text-signal-deep">{r.clauseId}</span> {r.title}
                <span className="mono ml-1.5 rounded bg-paper-2 px-1 text-[0.6rem]">v{r.version}</span>
              </p>
              {!r.inEffect && tone === "naive" && <span className="mono shrink-0 text-[0.58rem] font-bold uppercase text-bad">stale</span>}
            </div>
            <p className="mt-1 line-clamp-2 text-[0.7rem] leading-snug text-muted">{r.text}</p>
            <p className="mono mt-1.5 text-[0.6rem] text-ink-soft">
              BM25 {r.scores.bm25.toFixed(2)} (#{r.scores.bm25Rank}) · dense {r.scores.dense.toFixed(3)} (#{r.scores.denseRank}) · RRF {r.scores.rrf.toFixed(4)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PolicyRAGInspector() {
  const [query, setQuery] = useState(PRESETS[0].q);
  const [date, setDate] = useState(PRESETS[0].date);
  const [data, setData] = useState<{ temporal: Result; naive: Result | null; staleInNaive: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (q = query, d = date) => {
    setBusy(true);
    setError(null);
    try {
      setData(await api(`/api/rag-search`, { json: { query: q, governingDate: d, compare: true } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 p-6">
      <p className="max-w-2xl text-[0.86rem] leading-relaxed text-ink-soft">
        The governing date picks which policy version applies: the <strong>order date</strong> for returns, shipping and damage; the <strong>claim date</strong> (frozen at {shortDate("2026-10-16")}) for billing, goodwill and approvals. The temporal filter runs before any scoring.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label className="min-w-[260px] flex-1 text-[0.72rem] font-semibold">
          Query
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded-xl bg-card px-3 py-2.5 text-[0.86rem] shadow-[inset_0_0_0_1.5px_var(--ink)] outline-none" />
        </label>
        <label className="text-[0.72rem] font-semibold">
          Order date
          <input type="date" value={date} min="2024-01-01" max="2026-10-16" onChange={(e) => setDate(e.target.value)} className="mono mt-1 block rounded-xl bg-card px-3 py-2 text-[0.8rem] shadow-[inset_0_0_0_1.5px_var(--ink)] outline-none" />
        </label>
        <button type="submit" className="btn btn-ink !py-2.5" disabled={busy}>
          <Search className="size-4" aria-hidden /> Search
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.q}
            type="button"
            onClick={() => {
              setQuery(p.q);
              setDate(p.date);
              run(p.q, p.date);
            }}
            className="rounded-full bg-paper-2 px-3 py-1.5 text-[0.7rem] font-medium shadow-[inset_0_0_0_1px_var(--line)] hover:bg-paper-3"
          >
            {p.q.slice(0, 44)}… · {p.date}
          </button>
        ))}
      </div>
      {error && <p className="text-[0.8rem] text-bad">{error}</p>}
      {data && (
        <>
          {data.staleInNaive !== null && (
            <p className={cn("rounded-xl px-4 py-3 text-[0.82rem] font-semibold", data.staleInNaive > 0 ? "bg-bad-wash text-bad" : "bg-ok-wash text-ok")}>
              Without the date filter, {data.staleInNaive} of the top {data.naive?.results.length ?? 0} clauses would be out of date for this order. With it: 0.
            </p>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            {data.naive && <Table title="Naive (no date filter)" result={data.naive} tone="naive" />}
            <Table title="Temporal (what the agent uses)" result={data.temporal} tone="temporal" />
          </div>
          <details className="rounded-xl bg-card shadow-[0_0_0_1px_var(--line)]">
            <summary className="cursor-pointer px-4 py-3 text-[0.78rem] font-semibold">{data.temporal.removed.length} clauses removed by the temporal filter</summary>
            <ul className="grid gap-1 border-t border-line px-4 py-3 sm:grid-cols-2">
              {data.temporal.removed.map((r) => (
                <li key={r.key} className="mono text-[0.62rem] text-muted line-through decoration-muted/50">
                  {r.clauseId} {r.title} v{r.version} — {r.reason}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
