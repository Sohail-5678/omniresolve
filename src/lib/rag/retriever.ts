/**
 * N3 — hybrid temporal retriever: temporal filter → BM25 + dense → RRF → top K with every
 * score, rank and citation. Retrieval is for *explaining and citing*; the numbers used for
 * decisions come from rules.json of the same version (a test checks they always agree).
 */
import { AGENT } from "@/config/agent";
import { citationLabel } from "@/lib/policy/clauses";
import { inEffect } from "@/lib/util/dates";
import { Bm25Index } from "./bm25";
import { rankByCosine, lexicalVector } from "./dense";
import { reciprocalRankFusion } from "./rrf";
import { temporalFilter, governingDateForClause, type GoverningDates } from "./temporal-filter";
import { getCorpus, cachedQueryEmbedding, findClause, type IndexedClause } from "./corpus";
import { governingDateFor, policyFor, type PolicyId } from "@/lib/policy/rules";
import { tokenize } from "./tokenize";

export type RetrievalMode = "hybrid" | "bm25" | "dense";
export type DenseMode = "embedding" | "lexical-fallback";

export type RetrievedClause = {
  key: string;
  clauseId: string;
  title: string;
  policyId: string;
  version: string;
  category: string;
  text: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  inEffect: boolean;
  governingDate: string;
  rank: number;
  /** True when included because it states the rules for a triaged intent (not by ranking). */
  pinned?: boolean;
  scores: { bm25: number; bm25Rank: number; dense: number; denseRank: number; rrf: number };
};

export type RetrievalResult = {
  query: string;
  dates: GoverningDates;
  naive: boolean;
  mode: RetrievalMode;
  denseMode: DenseMode;
  results: RetrievedClause[];
  removed: { key: string; clauseId: string; title: string; version: string; reason: string }[];
  candidates: number;
  timingMs: number;
};

export type RetrieveOptions = {
  query: string;
  dates: GoverningDates;
  naive?: boolean;
  topK?: number;
  mode?: RetrievalMode;
  /** A model embedding for the query, if the caller has one (live Gemini or cache). */
  queryEmbedding?: number[] | null;
};

export function retrieve(opts: RetrieveOptions): RetrievalResult {
  const t0 = performance.now();
  const all = getCorpus();
  const mode = opts.mode ?? "hybrid";
  const topK = opts.topK ?? AGENT.retrieval.topK;
  const { kept, removed } = temporalFilter(all, opts.dates);
  const candidates: IndexedClause[] = opts.naive ? all : kept;

  const qTokens = tokenize(opts.query);
  const bm25 = new Bm25Index(
    candidates.map((c) => ({ id: c.key, tokens: c.tokens })),
    AGENT.retrieval.bm25.k1,
    AGENT.retrieval.bm25.b,
  );
  const bmRank = bm25.rank(qTokens);

  const modelVector = opts.queryEmbedding ?? cachedQueryEmbedding(opts.query);
  const useModel = !!modelVector && candidates.every((c) => c.embedding);
  const denseMode: DenseMode = useModel ? "embedding" : "lexical-fallback";
  const qVec = useModel ? modelVector! : lexicalVector(opts.query);
  const denseRank = rankByCosine(
    qVec,
    candidates.map((c) => ({ id: c.key, vector: useModel ? c.embedding! : c.lexical })),
  );

  const bmById = new Map(bmRank.map((h) => [h.id, h]));
  const dnById = new Map(denseRank.map((h) => [h.id, h]));
  const lists = mode === "bm25" ? [bmRank] : mode === "dense" ? [denseRank] : [bmRank, denseRank];
  const fused = reciprocalRankFusion(lists, AGENT.retrieval.rrfK);

  const ranked = candidates
    .map((c) => {
      const b = bmById.get(c.key)!;
      const d = dnById.get(c.key)!;
      return { c, b, d, rrf: fused.get(c.key) ?? 0 };
    })
    .filter(({ b, d }) => (mode === "dense" ? true : b.score > 0) || d.score >= AGENT.retrieval.denseFloor)
    .sort((x, y) => y.rrf - x.rrf || x.c.key.localeCompare(y.c.key))
    .slice(0, topK);

  const results: RetrievedClause[] = ranked.map(({ c, b, d, rrf }, i) => {
    const governingDate = governingDateForClause(c, opts.dates);
    return {
      key: c.key,
      clauseId: c.clauseId,
      title: c.title,
      policyId: c.policyId,
      version: c.version,
      category: c.category,
      text: c.text,
      citation: citationLabel(c),
      effectiveFrom: c.effectiveFrom,
      effectiveTo: c.effectiveTo,
      inEffect: inEffect(governingDate, c.effectiveFrom, c.effectiveTo),
      governingDate,
      rank: i + 1,
      scores: { bm25: round(b.score), bm25Rank: b.rank, dense: round(d.score), denseRank: d.rank, rrf: round(rrf, 5) },
    };
  });

  return {
    query: opts.query,
    dates: opts.dates,
    naive: !!opts.naive,
    mode,
    denseMode,
    results,
    removed: removed.map(({ clause, reason }) => ({ key: clause.key, clauseId: clause.clauseId, title: clause.title, version: clause.version, reason })),
    candidates: candidates.length,
    timingMs: round(performance.now() - t0, 2),
  };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Retrieval hints per intent, prepended to the customer's words for N3 queries. */
export const INTENT_QUERY_HINTS: Record<string, string> = {
  damaged_item: "damage claim reported after delivery remedy replacement or refund of the damaged item broken in transit",
  double_charge: "duplicate charge two captures same amount same order refund the duplicate",
  late_delivery: "late delivery promised date remedy compensation",
  lost_package: "lost package no tracking update replacement or refund",
  return_request: "return window late return outside the window store credit refund unused item return label",
  refund_status: "refund method timing original payment method",
  vip_churn: "goodwill store credit cap eligible tiers churn exception supervisor approval",
  policy_question: "policy rules returns refunds",
  security: "claims of authority executive manager approval instructions inside customer messages code tool calls flagged conversation",
  other: "support policy",
};

/** Policy family whose rules decide each intent (used to pin the clauses that state those rules). */
export const INTENT_FAMILY: Partial<Record<string, PolicyId>> = {
  damaged_item: "DAMAGE_TRANSIT",
  double_charge: "BILLING_DISPUTES",
  late_delivery: "SHIPPING_DELAYS",
  lost_package: "SHIPPING_DELAYS",
  return_request: "RETURNS_STANDARD",
  vip_churn: "GOODWILL_RETENTION",
  security: "APPROVAL_AUTHORITY",
};

/**
 * N3 for the agent: one retrieval per intent, merged, best clauses first — then the clauses
 * that state each intent family's rules (rules.json clauseIds, version in effect) are pinned
 * so the planner always sees the numbers the gate will enforce. Pinned clauses are labeled.
 */
export function retrieveForIntents(
  intents: string[],
  message: string,
  dates: GoverningDates,
  embeddings?: Record<string, number[] | null>,
  opts: { naive?: boolean; pin?: boolean } = {},
) {
  const runs = intents.map((intent) => {
    const query = `${INTENT_QUERY_HINTS[intent] ?? ""} ${message}`.trim();
    return retrieve({ query, dates, topK: 5, queryEmbedding: embeddings?.[query] ?? null, naive: opts.naive });
  });
  const best = new Map<string, RetrievedClause>();
  for (const run of runs) {
    for (const r of run.results) {
      const prev = best.get(r.key);
      if (!prev || r.scores.rrf > prev.scores.rrf) best.set(r.key, r);
    }
  }
  const guaranteed = new Set(runs.map((r) => r.results[0]?.key).filter(Boolean) as string[]);
  const merged = [...best.values()].sort((a, b) => {
    const ga = guaranteed.has(a.key) ? 1 : 0;
    const gb = guaranteed.has(b.key) ? 1 : 0;
    return gb - ga || b.scores.rrf - a.scores.rrf || a.key.localeCompare(b.key);
  });
  const limit = intents.length > 1 ? AGENT.retrieval.topK + 1 : AGENT.retrieval.topK;
  const ranked = merged.slice(0, limit);

  const pinned: RetrievedClause[] = [];
  const have = new Set(ranked.map((r) => r.key));
  for (const intent of opts.pin === false ? [] : intents) {
    const family = INTENT_FAMILY[intent];
    if (!family) continue;
    const version = policyFor(family, governingDateFor(family, { orderDate: dates.orderDate, claimDate: dates.claimDate })).version;
    for (const id of policyFor(family, governingDateFor(family, { orderDate: dates.orderDate, claimDate: dates.claimDate })).clauseIds) {
      const key = `${id}@${version}`;
      if (have.has(key)) continue;
      const c = findClause(key);
      if (!c) continue;
      have.add(key);
      const governingDate = governingDateForClause(c, dates);
      pinned.push({
        key: c.key,
        clauseId: c.clauseId,
        title: c.title,
        policyId: c.policyId,
        version: c.version,
        category: c.category,
        text: c.text,
        citation: citationLabel(c),
        effectiveFrom: c.effectiveFrom,
        effectiveTo: c.effectiveTo,
        inEffect: inEffect(governingDate, c.effectiveFrom, c.effectiveTo),
        governingDate,
        rank: 0,
        pinned: true,
        scores: { bm25: 0, bm25Rank: 0, dense: 0, denseRank: 0, rrf: 0 },
      });
    }
  }
  const results = [...ranked, ...pinned].map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    results,
    queries: runs.map((r) => r.query),
    denseMode: runs.every((r) => r.denseMode === "embedding") ? ("embedding" as const) : ("lexical-fallback" as const),
    timingMs: runs.reduce((s, r) => s + r.timingMs, 0),
    removedCount: runs[0]?.removed.length ?? 0,
    pinnedCount: pinned.length,
  };
}
