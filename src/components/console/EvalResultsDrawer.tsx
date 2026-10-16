"use client";

/**
 * Eval results, read from committed result files via /api/results. Every block shows N, the
 * date, the commit and a link to the raw JSON. There is deliberately no "run evals" button:
 * evals spend the shared free quota, so they run locally.
 */
import { useEffect, useState } from "react";
import { ArrowUpRight, Terminal } from "lucide-react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";

type FileSummary = {
  name: string;
  title?: string;
  date?: string;
  commit?: string;
  dataset?: string;
  n?: number;
  models?: string[];
  metrics?: Record<string, unknown>;
  config?: Record<string, unknown>;
  notes?: string[];
  tables?: { title: string; columns: string[]; rows: (string | number | null)[][] }[];
};

function fmt(v: unknown): string {
  if (typeof v === "number") {
    if (v > 0 && v < 1 && !Number.isInteger(v)) return `${(v * 100).toFixed(1)}%`;
    if (v === 0 || v === 1) return String(v);
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3);
  }
  if (Array.isArray(v)) {
    if (v.length === 2 && v.every((x) => typeof x === "number")) return `[${fmt(v[0])}, ${fmt(v[1])}]`;
    return v.join(", ");
  }
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v ?? "—");
}

const COMMANDS = [
  "npm run eval:chaos        # saga integrity under a fault matrix (no LLM)",
  "npm run eval:retrieval    # recall@3, MRR, stale-clause rate",
  "npm run eval:firewall     # detection and false-positive rates",
  "npm run eval:redteam      # 150 + 30 attacks through the full graph",
  "npm run eval:scenarios    # 60 simulated customers, final-state checks, pass^k",
  "npm run readme:tables     # regenerate README tables from data/results",
];

export function EvalResultsDrawer() {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ files: FileSummary[] }>("/api/results")
      .then((r) => setFiles(r.files))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-[0.8rem] text-bad">{error}</p>}
      {files && files.length === 0 && <p className="text-[0.86rem] text-muted">No result files yet. Run the evals locally (commands below).</p>}
      {files?.map((f) => (
        <section key={f.name} className="rounded-2xl bg-card p-5 shadow-[0_0_0_1px_var(--line)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="display-tight text-[1.3rem]">{f.title ?? f.name}</h3>
              <p className="mono mt-1 text-[0.64rem] text-muted">
                {f.dataset ?? ""} · N = {f.n ?? "?"} · {f.date ?? "?"} · commit {f.commit ?? "local"}
                {f.models?.length ? ` · ${f.models.join(", ")}` : ""}
              </p>
            </div>
            <a href={`/api/results?file=${f.name}`} target="_blank" rel="noreferrer" className="badge badge-eval no-underline hover:opacity-80">
              raw json <ArrowUpRight className="size-2.5" aria-hidden />
            </a>
          </div>
          {f.metrics && (
            <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(f.metrics)
                .filter(([, v]) => typeof v !== "object" || Array.isArray(v))
                .slice(0, 12)
                .map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-paper-2/60 p-2.5">
                    <dt className="text-[0.62rem] text-muted">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                    <dd className="mt-0.5 text-[0.95rem] font-bold tabular">{fmt(v)}</dd>
                  </div>
                ))}
            </dl>
          )}
          {f.tables?.map((t) => (
            <div key={t.title} className="mt-4 overflow-x-auto scroll-thin">
              <p className="mb-1.5 text-[0.74rem] font-semibold">{t.title}</p>
              <table className="w-full min-w-[480px] text-left text-[0.72rem]">
                <thead>
                  <tr className="border-b border-line text-muted">
                    {t.columns.map((c) => (
                      <th key={c} className="py-1.5 pr-3 font-semibold">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    <tr key={i} className={cn("border-b border-line/60", i % 2 && "bg-paper-2/30")}>
                      {row.map((cell, j) => (
                        <td key={j} className={cn("py-1.5 pr-3 tabular", j === 0 ? "font-semibold" : "mono")}>
                          {fmt(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {f.notes?.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-4 text-[0.72rem] text-muted">
              {f.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <section className="rounded-2xl bg-ink p-5 text-paper">
        <p className="flex items-center gap-2 text-[0.8rem] font-bold">
          <Terminal className="size-4 text-signal" aria-hidden /> Run the evals locally
        </p>
        <pre className="mono mt-3 overflow-x-auto text-[0.7rem] leading-relaxed text-paper/80">{COMMANDS.join("\n")}</pre>
      </section>
    </div>
  );
}
