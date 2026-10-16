"use client";

/**
 * The 7-node graph (plus "ask") lit live from SSE events. Click a node for its output.
 * Tabs: model calls for this session, and the checkpoint timeline from LangGraph history.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/client/cn";
import { ms, timeOf } from "@/lib/client/format";
import { NODE_MODELS } from "@/config/models";
import type { LlmCallView, NodeId, NodeView } from "./state";
import { ModeBadge, Panel } from "./ui";

type Layout = { id: NodeId; x: number; y: number; w: number; label: string; sub: string; llm?: boolean };

const SPINE = 120;
const BRANCH = 318;
const LAYOUT: Layout[] = [
  { id: "n1_triage", x: SPINE, y: 26, w: 168, label: "N1 · Triage", sub: NODE_MODELS.triage[0].model.replace("openai/", ""), llm: true },
  { id: "ask", x: BRANCH, y: 26, w: 116, label: "Ask", sub: "clarify · end turn" },
  { id: "n2_context", x: SPINE, y: 84, w: 168, label: "N2 · Context", sub: "4 mock APIs · parallel" },
  { id: "n3_retrieve", x: SPINE, y: 142, w: 168, label: "N3 · Retrieve", sub: "date filter · BM25 · dense · RRF" },
  { id: "n4a_plan", x: SPINE, y: 200, w: 168, label: "N4a · Plan", sub: NODE_MODELS.planner[0].model.replace("openai/", ""), llm: true },
  { id: "n4b_gate", x: SPINE, y: 258, w: 168, label: "N4b · Policy gate", sub: "code decides · tokens" },
  { id: "n5_hitl", x: BRANCH, y: 287, w: 116, label: "N5 · Human", sub: "interrupt()" },
  { id: "n6_execute", x: SPINE, y: 316, w: 168, label: "N6 · Saga", sub: "pivot · compensate" },
  { id: "n7_respond", x: SPINE, y: 374, w: 168, label: "N7 · Respond", sub: "LLM + verifier", llm: true },
];

/** [from, to, label, labelX, labelY, rotate?] */
const EDGES: [NodeId, NodeId, string, number, number, boolean?][] = [
  ["n1_triage", "n2_context", "", 0, 0],
  ["n1_triage", "ask", "unclear", 232, 19],
  ["n2_context", "n3_retrieve", "", 0, 0],
  ["n3_retrieve", "n4a_plan", "", 0, 0],
  ["n4a_plan", "n4b_gate", "", 0, 0],
  ["n4b_gate", "n6_execute", "auto", 126, 290],
  ["n4b_gate", "n5_hitl", "over limit", 258, 252],
  ["n5_hitl", "n6_execute", "approve", 262, 312],
  ["n4b_gate", "n7_respond", "denied", 16, 316, true],
  ["n6_execute", "n7_respond", "", 0, 0],
];

const H = 38;

function pos(id: NodeId) {
  return LAYOUT.find((l) => l.id === id)!;
}

function edgePath(a: NodeId, b: NodeId): string {
  const A = pos(a);
  const B = pos(b);
  if (a === "n4b_gate" && b === "n7_respond") {
    const x = A.x - A.w / 2 - 14;
    return `M${A.x - A.w / 2} ${A.y} H${x} V${B.y} H${B.x - B.w / 2}`;
  }
  if (A.x === B.x) return `M${A.x} ${A.y + H / 2} V${B.y - H / 2}`;
  if (B.y === A.y) return `M${A.x + A.w / 2} ${A.y} H${B.x - B.w / 2}`;
  if (B.x > A.x) return `M${A.x + A.w / 2} ${A.y} H${B.x} V${B.y - H / 2}`;
  return `M${A.x} ${A.y + H / 2} V${B.y} H${B.x + B.w / 2}`;
}

function nodeFill(status: NodeView["status"]) {
  switch (status) {
    case "active":
      return { fill: "var(--signal)", stroke: "var(--ink)", text: "var(--ink)", sub: "var(--ink)" };
    case "done":
      return { fill: "var(--ink)", stroke: "var(--ink)", text: "var(--paper)", sub: "rgba(244,239,230,0.6)" };
    case "waiting":
      return { fill: "var(--warn-wash)", stroke: "var(--warn)", text: "var(--ink)", sub: "var(--warn)" };
    case "error":
      return { fill: "var(--bad-wash)", stroke: "var(--bad)", text: "var(--bad)", sub: "var(--bad)" };
    default:
      return { fill: "var(--card)", stroke: "var(--line-strong)", text: "var(--ink-soft)", sub: "var(--muted)" };
  }
}

type Checkpoint = { checkpointId: string; step: number; source: string; next: string[]; createdAt?: string; writes: string[] };

export function AgentGraphView({ nodes, activeNode, llm, threadId, refreshKey, className }: { nodes: Record<NodeId, NodeView>; activeNode: NodeId | null; llm: LlmCallView[]; threadId: string | null; refreshKey: number; className?: string }) {
  const [tab, setTab] = useState<"graph" | "calls" | "checkpoints">("graph");
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [history, setHistory] = useState<Checkpoint[]>([]);

  useEffect(() => {
    if (tab !== "checkpoints" || !threadId) return;
    let alive = true;
    api<{ history: Checkpoint[] }>(`/api/threads/${threadId}`)
      .then((r) => alive && setHistory(r.history))
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [tab, threadId, refreshKey]);

  const shown = selected ?? activeNode;
  const detail = shown ? nodes[shown] : null;
  const traversed = useMemo(() => new Set(EDGES.filter(([a, b]) => nodes[a].status !== "idle" && nodes[b].status !== "idle").map(([a, b]) => `${a}-${b}`)), [nodes]);
  const totals = useMemo(() => llm.reduce((t, c) => ({ calls: t.calls + 1, tokens: t.tokens + c.inputTokens + c.outputTokens, cost: t.cost + c.costUsd }), { calls: 0, tokens: 0, cost: 0 }), [llm]);

  return (
    <Panel
      className={className}
      kicker="LangGraph.js · Postgres checkpoints"
      title="Agent graph"
      right={
        <div className="pill-toggle sm" role="tablist" aria-label="Graph views">
          {(["graph", "calls", "checkpoints"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => setTab(t)}>
              {t === "graph" ? "Graph" : t === "calls" ? "Calls" : "Checkpoints"}
            </button>
          ))}
        </div>
      }
      bodyClassName="flex flex-col overflow-hidden"
    >
      {tab === "graph" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-[220px] flex-1 px-2 pt-2">
          <svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet" className="mx-auto h-full max-h-[400px] w-full" role="img" aria-label="Agent graph state">
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 Z" fill="var(--ink)" />
              </marker>
              <marker id="arrow-muted" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 Z" fill="rgba(28,26,23,0.25)" />
              </marker>
            </defs>
            {EDGES.map(([a, b, label, lx, ly, rotate]) => {
              const on = traversed.has(`${a}-${b}`);
              return (
                <g key={`${a}-${b}`}>
                  <path d={edgePath(a, b)} fill="none" stroke={on ? "var(--ink)" : "rgba(28,26,23,0.22)"} strokeWidth={on ? 1.8 : 1.2} strokeDasharray={on ? undefined : "3 3"} markerEnd={on ? "url(#arrow)" : "url(#arrow-muted)"} />
                  {label && (
                    <text x={lx} y={ly} fontSize={8.5} fill="var(--muted)" textAnchor="middle" className="mono" transform={rotate ? `rotate(-90 ${lx} ${ly})` : undefined}>
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {LAYOUT.map((l) => {
              const v = nodes[l.id];
              const c = nodeFill(v.status);
              const isSel = shown === l.id;
              return (
                <g key={l.id} role="button" tabIndex={0} aria-label={`${l.label}: ${v.status}`} className="cursor-pointer outline-none" onClick={() => setSelected(l.id === selected ? null : l.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(l.id)}>
                  {v.status === "active" && <rect x={l.x - l.w / 2 - 4} y={l.y - H / 2 - 4} width={l.w + 8} height={H + 8} rx={13} fill="none" stroke="var(--signal)" strokeWidth={2} opacity={0.6}>
                    <animate attributeName="opacity" values="0.7;0.1;0.7" dur="1.2s" repeatCount="indefinite" />
                  </rect>}
                  <rect x={l.x - l.w / 2} y={l.y - H / 2} width={l.w} height={H} rx={10} fill={c.fill} stroke={isSel ? "var(--signal-deep)" : c.stroke} strokeWidth={isSel ? 2.4 : 1.4} strokeDasharray={v.status === "waiting" ? "4 3" : undefined} style={{ transition: "fill 200ms ease, stroke 200ms ease" }} />
                  <text x={l.x - l.w / 2 + 12} y={l.y - 2} fontSize={11.5} fontWeight={700} fill={c.text} style={{ fontVariationSettings: '"wdth" 112' }}>
                    {l.label}
                  </text>
                  <text x={l.x - l.w / 2 + 12} y={l.y + 11} fontSize={8.5} fill={c.sub} className="mono">
                    {v.durationMs !== undefined ? `${l.llm && v.badge ? `${v.badge} · ` : ""}${ms(v.durationMs)}` : l.sub}
                  </text>
                  {v.status === "done" && <path d={`M${l.x + l.w / 2 - 20} ${l.y} l4 4 l8 -8`} stroke="var(--signal)" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                  {v.status === "waiting" && <text x={l.x + l.w / 2 - 12} y={l.y + 4} fontSize={12} textAnchor="end" fill="var(--warn)">⏸</text>}
                </g>
              );
            })}
          </svg>
          </div>
          <div className="max-h-[38%] min-h-[96px] shrink-0 overflow-y-auto border-t border-line px-4 py-3 scroll-thin">
            {shown && detail ? (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[0.8rem] font-bold">{pos(shown).label}</p>
                  <div className="flex items-center gap-1.5">
                    {detail.badge && <ModeBadge badge={detail.badge} />}
                    {detail.durationMs !== undefined && <span className="mono text-[0.65rem] text-muted">{ms(detail.durationMs)}</span>}
                  </div>
                </div>
                <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-paper-2 p-2.5 text-[0.66rem] leading-relaxed text-ink-soft">
                  {detail.summary ? JSON.stringify(detail.summary, null, 1) : detail.status === "idle" ? "Not reached in this turn." : "Running…"}
                </pre>
              </div>
            ) : (
              <p className="text-[0.78rem] text-muted">Send a message and watch each node light up. Click any node to see what it produced.</p>
            )}
          </div>
        </div>
      )}

      {tab === "calls" && (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-[0.7rem] text-muted">
            <span>{totals.calls} model calls</span>
            <span className="mono">{totals.tokens.toLocaleString()} tok · ${totals.cost.toFixed(4)} list price</span>
          </div>
          {llm.length === 0 ? (
            <p className="p-4 text-[0.78rem] text-muted">No model calls yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {[...llm].reverse().map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div className="min-w-0">
                    <p className="text-[0.76rem] font-semibold">
                      {c.node}
                      {c.attempt > 0 && <span className="ml-1.5 text-warn">repair {c.attempt}</span>}
                      {!c.ok && <span className="ml-1.5 text-bad">invalid</span>}
                    </p>
                    <p className="mono truncate text-[0.62rem] text-muted">{c.model}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="mono text-[0.62rem] text-muted">{c.inputTokens}+{c.outputTokens} tok</span>
                    <ModeBadge badge={c.badge} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "checkpoints" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scroll-thin">
          {!threadId ? (
            <p className="text-[0.78rem] text-muted">Checkpoints appear once a conversation starts.</p>
          ) : history.length === 0 ? (
            <p className="text-[0.78rem] text-muted">Loading checkpoint history…</p>
          ) : (
            <ol className="relative ml-1.5 border-l border-line">
              {history.map((h) => (
                <li key={h.checkpointId} className="relative pb-3 pl-4">
                  <span className={cn("absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-paper", h.next.length ? "bg-signal" : "bg-ink")} aria-hidden />
                  <p className="text-[0.74rem] font-semibold">
                    step {h.step} · {h.writes.length ? h.writes.join(", ") : h.source}
                  </p>
                  <p className="mono text-[0.6rem] text-muted">
                    {h.next.length ? `next → ${h.next.join(", ")}` : "end of turn"} · {timeOf(h.createdAt)} · {h.checkpointId.slice(0, 13)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Panel>
  );
}
