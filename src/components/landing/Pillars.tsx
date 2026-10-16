"use client";

/**
 * "Five pillars hold the roof": the temple diagram where each column is one design pillar.
 * Columns are buttons (keyboard and pointer); the selected pillar's detail sits beside it.
 */
import { useState } from "react";
import { cn } from "@/lib/client/cn";

const PILLARS = [
  {
    n: "01",
    short: "Graph",
    title: "Graph orchestration",
    body: "Seven nodes in LangGraph.js. Three call an LLM and must return zod-valid JSON (with a bounded repair loop); the rest are plain code. Every node checkpoints to Postgres, so a run can stop in one request and finish in another.",
    proof: "Measured by task success against the final database state, and pass^k.",
  },
  {
    n: "02",
    short: "Policy",
    title: "Policy as code",
    body: "Versioned rules for 2024, 2025 and 2026 are the source of truth; retrieval only finds the words to cite. A date filter runs before any scoring, so last year's 90-day window can't leak into this year's answer.",
    proof: "Measured by recall@3, MRR and the stale-clause rate, naive vs temporal.",
  },
  {
    n: "03",
    short: "Human",
    title: "Human in the loop",
    body: "Over the limit, the graph calls interrupt(): state is saved and the request ends. A supervisor approves, lowers the amount or rejects — minutes later, on any server — and the run resumes exactly where it stopped. Approving twice does nothing twice.",
    proof: "Measured by escalation precision and recall, and resume correctness after a cold start.",
  },
  {
    n: "04",
    short: "Saga",
    title: "Saga execution",
    body: "Reversible steps go first and the refund goes last. A failure before the refund unwinds everything in reverse; after it, steps retry and land in an ops outbox. Idempotency keys make a lost response harmless.",
    proof: "Measured by integrity violations across a fault matrix (target: zero).",
  },
  {
    n: "05",
    short: "Guards",
    title: "Guardrails",
    body: "A heuristic firewall routes suspicious messages to a human. The real lock is the approval token: single-use, HMAC-signed, checked at the tool boundary in the same transaction as the action. The model never sees one.",
    proof: "Measured by unauthorized state changes under red-team attack (target: zero).",
  },
];

export function Pillars() {
  const [active, setActive] = useState(0);
  const xs = [190, 345, 500, 655, 810];
  const p = PILLARS[active];
  return (
    <section id="pillars" className="mx-auto max-w-[1280px] px-5 pt-24 sm:px-8 sm:pt-32">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end">
        <div>
          <p className="eyebrow text-muted">How it works</p>
          <h2 className="display mt-4 text-[clamp(2.4rem,5.8vw,5.2rem)]">
            Five pillars
            <br />
            hold the roof
          </h2>
        </div>
        <p className="max-w-md text-[1.02rem] leading-relaxed text-ink-soft lg:justify-self-end">
          Every design choice answers a question an interviewer — or an attacker — will ask. Pick a column.
        </p>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)] lg:items-center">
        <svg viewBox="0 0 1000 560" className="w-full" role="group" aria-label="The five pillars">
          <path d="M90 124 L500 34 L910 124 Z" fill="var(--card)" stroke="var(--ink)" strokeWidth={2.5} strokeLinejoin="round" />
          <text x={500} y={99} textAnchor="middle" fontSize={16} fontWeight={800} letterSpacing={6} fill="var(--ink)" style={{ fontVariationSettings: '"wdth" 125' }}>
            THE LLM PROPOSES · CODE DECIDES
          </text>
          <rect x={90} y={124} width={820} height={18} fill="var(--ink)" />
          <rect x={110} y={142} width={780} height={34} fill="var(--card)" stroke="var(--ink)" strokeWidth={2.5} />
          {Array.from({ length: 12 }, (_, i) => 130 + i * 64).map((x) => (
            <path key={x} d={`M${x} 147 V171 M${x + 7} 147 V171 M${x + 14} 147 V171`} stroke="var(--ink)" strokeWidth={1.6} />
          ))}
          {xs.map((x, i) => {
            const on = i === active;
            return (
              <g
                key={x}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={`${PILLARS[i].n} ${PILLARS[i].title}`}
                className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[var(--signal-deep)]"
                onClick={() => setActive(i)}
                onMouseEnter={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive(i);
                  }
                  if (e.key === "ArrowRight") setActive((i + 1) % 5);
                  if (e.key === "ArrowLeft") setActive((i + 4) % 5);
                }}
              >
                <rect x={x - 46} y={176} width={92} height={10} fill={on ? "var(--signal)" : "var(--card)"} stroke="var(--ink)" strokeWidth={2.5} style={{ transition: "fill 180ms ease" }} />
                <path d={`M${x - 30} 186 L${x - 34} 452 L${x + 34} 452 L${x + 30} 186 Z`} fill={on ? "var(--signal)" : "var(--card)"} stroke="var(--ink)" strokeWidth={2.5} style={{ transition: "fill 180ms ease" }} />
                <path d={`M${x - 14} 194 L${x - 16} 446 M${x} 194 V446 M${x + 14} 194 L${x + 16} 446`} stroke="var(--ink)" strokeOpacity={0.35} strokeWidth={1.5} />
                <rect x={x - 42} y={452} width={84} height={12} fill={on ? "var(--signal)" : "var(--card)"} stroke="var(--ink)" strokeWidth={2.5} />
                <text x={x} y={300} textAnchor="middle" fontSize={34} fontWeight={900} fill="var(--ink)" style={{ fontVariationSettings: '"wdth" 125' }}>
                  {PILLARS[i].n}
                </text>
                <text x={x} y={334} textAnchor="middle" fontSize={13} fontWeight={700} letterSpacing={2.5} fill="var(--ink)" style={{ fontVariationSettings: '"wdth" 125' }}>
                  {PILLARS[i].short.toUpperCase()}
                </text>
              </g>
            );
          })}
          <rect x={100} y={464} width={800} height={20} fill="var(--card)" stroke="var(--ink)" strokeWidth={2.5} />
          <rect x={70} y={484} width={860} height={20} fill="var(--card)" stroke="var(--ink)" strokeWidth={2.5} />
          <rect x={40} y={504} width={920} height={20} fill="var(--ink)" />
          <text x={500} y={518} textAnchor="middle" fontSize={11} fontWeight={700} letterSpacing={4} fill="var(--paper)" className="mono">
            POSTGRES · INTEGER CENTS · ONE SANDBOX PER VISITOR
          </text>
        </svg>

        <div key={p.n} className="rise border-t-2 border-ink pt-6">
          <p className="mono text-[0.72rem] font-semibold text-signal-deep">PILLAR {p.n}</p>
          <h3 className="display-tight mt-2 text-[2rem]">{p.title}</h3>
          <p className="mt-4 text-[1rem] leading-relaxed text-ink-soft">{p.body}</p>
          <p className="mt-5 flex gap-2 text-[0.85rem] font-semibold text-ink">
            <span aria-hidden className="mt-[0.45em] size-2 shrink-0 rounded-[2px] bg-signal" />
            {p.proof}
          </p>
          <div className="mt-6 flex gap-1.5" aria-hidden>
            {PILLARS.map((x, i) => (
              <span key={x.n} className={cn("h-1 flex-1 rounded-full transition-colors duration-200", i === active ? "bg-ink" : "bg-paper-3")} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
