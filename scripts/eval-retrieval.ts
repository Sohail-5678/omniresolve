/**
 * Retrieval eval (spec 9.2): 120 queries with gold clause keys and governing dates. Systems:
 * BM25, dense, RRF — each with and without the temporal filter. Metrics: Recall@3, MRR@10 and
 * the stale-clause rate (share of top-3 results not in effect on the governing date).
 * Dense uses Gemini embeddings when available; otherwise the labeled local lexical fallback.
 * Usage: npx tsx scripts/eval-retrieval.ts
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { retrieve, type RetrievalMode } from "@/lib/rag/retriever";
import { corpusMeta } from "@/lib/rag/corpus";
import { bootstrapCI, mean, rate, round } from "@/lib/evals/stats";
import { readJsonl, writeResult } from "./lib/results";

type Q = { id: string; query: string; family: string; orderDate: string; claimDate: string; goldKeys: string[]; boundary: boolean };

function main() {
  const qs = readJsonl<Q>("data/datasets/retrieval-queries.jsonl");
  const systems: { name: string; mode: RetrievalMode; naive: boolean }[] = [];
  for (const mode of ["bm25", "dense", "hybrid"] as RetrievalMode[]) for (const naive of [true, false]) systems.push({ name: `${mode === "hybrid" ? "RRF" : mode.toUpperCase()}${naive ? " · naive" : " · temporal"}`, mode, naive });
  const items: Record<string, unknown>[] = [];
  const summary = systems.map((sys) => {
    const recall: number[] = [];
    const rr: number[] = [];
    const stale: number[] = [];
    const boundaryRecall: number[] = [];
    let denseMode = "";
    let ms = 0;
    for (const q of qs) {
      const r = retrieve({ query: q.query, dates: { claimDate: q.claimDate, orderDate: q.orderDate }, naive: sys.naive, mode: sys.mode, topK: 10 });
      denseMode = r.denseMode;
      ms += r.timingMs;
      const keys = r.results.map((x) => x.key);
      const top3 = r.results.slice(0, 3);
      const hit = top3.some((x) => q.goldKeys.includes(x.key)) ? 1 : 0;
      const firstRank = keys.findIndex((k) => q.goldKeys.includes(k));
      recall.push(hit);
      rr.push(firstRank >= 0 ? 1 / (firstRank + 1) : 0);
      stale.push(top3.length ? top3.filter((x) => !x.inEffect).length / top3.length : 0);
      if (q.boundary) boundaryRecall.push(hit);
      items.push({ system: sys.name, id: q.id, hit, rank: firstRank + 1, staleTop3: top3.filter((x) => !x.inEffect).length, top3: top3.map((x) => x.key) });
    }
    return { sys, recall: mean(recall), recallCI: bootstrapCI(recall), mrr: mean(rr), stale: mean(stale), boundaryRecall: mean(boundaryRecall), denseMode, avgMs: ms / qs.length };
  });
  const get = (name: string) => summary.find((x) => x.sys.name === name)!;
  const meta = corpusMeta();
  writeResult({
    name: "retrieval",
    title: "Temporal hybrid retrieval",
    dataset: `data/datasets/retrieval-queries.jsonl (${qs.length} queries, ${qs.filter((q) => q.boundary).length} near version boundaries)`,
    n: qs.length,
    models: meta.embeddingModel ? [meta.embeddingModel] : [],
    config: { bm25: "k1=1.2, b=0.75", rrfK: 60, dense: get("RRF · temporal").denseMode === "embedding" ? `${meta.embeddingModel} (${meta.embeddingDims}d)` : "local lexical vectors (hashed words + char trigrams) — no embedding key at build time", corpus: `${meta.clauses} clauses` },
    metrics: {
      recallAt3Temporal: round(get("RRF · temporal").recall),
      recallAt3TemporalCI: get("RRF · temporal").recallCI,
      recallAt3Naive: round(get("RRF · naive").recall),
      mrrTemporal: round(get("RRF · temporal").mrr),
      mrrNaive: round(get("RRF · naive").mrr),
      staleTemporal: round(get("RRF · temporal").stale),
      staleNaive: round(get("RRF · naive").stale),
      boundaryRecallTemporal: round(get("RRF · temporal").boundaryRecall),
      boundaryRecallNaive: round(get("RRF · naive").boundaryRecall),
      avgRetrievalMs: round(get("RRF · temporal").avgMs, 2),
    },
    tables: [
      {
        title: "Systems",
        columns: ["system", "recall@3", "MRR@10", "stale top-3", "boundary recall@3", "avg ms"],
        rows: summary.map((x) => [x.sys.name, rate(x.recall * qs.length, qs.length), round(x.mrr), round(x.stale), round(x.boundaryRecall), round(x.avgMs, 2)]),
      },
    ],
    notes: [
      "Stale-clause rate = share of the top-3 results whose version was not in effect on the governing date (order date for returns/shipping/damage, claim date for billing/goodwill/approvals).",
      get("RRF · temporal").denseMode === "embedding" ? "Dense scores use precomputed model embeddings." : "No embedding API key was available, so 'dense' is a local lexical vector, not a semantic embedding; it is labeled as such everywhere.",
      "The agent additionally pins the rules.json clauses for each triaged intent; that is NOT counted here — this measures ranking alone.",
    ],
    items,
  });
}

main();
