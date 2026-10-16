/**
 * RAG unit tests: tokenizer + Porter stemmer, BM25 (hand-computed), RRF, dense/lexical
 * similarity, the temporal filter, the hybrid retriever (naive vs temporal) and the intent
 * pinning that guarantees the planner sees the clauses the policy gate will enforce.
 *
 * Pure in-memory code: no sandbox / DB is needed for anything in this file.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { tokenize, stem, normalize } from "@/lib/rag/tokenize";
import { Bm25Index } from "@/lib/rag/bm25";
import { reciprocalRankFusion } from "@/lib/rag/rrf";
import { cosine, l2normalize, lexicalVector, rankByCosine } from "@/lib/rag/dense";
import { temporalFilter, governingDateForClause, type GoverningDates } from "@/lib/rag/temporal-filter";
import { getCorpus, corpusMeta, findClause, queryKey, cachedQueryEmbedding, embeddingModel } from "@/lib/rag/corpus";
import { retrieve, retrieveForIntents, INTENT_FAMILY, INTENT_QUERY_HINTS, type RetrievalMode, type RetrievedClause } from "@/lib/rag/retriever";
import { POLICY_IDS, RULES, policyFor, governingDateFor, formatParamForText, type PolicyId } from "@/lib/policy/rules";
import { citationLabel, type Clause } from "@/lib/policy/clauses";
import { inEffect } from "@/lib/util/dates";
import { AGENT } from "@/config/agent";

// The main suite runs against an index with no model embeddings, whatever `npm run index:build`
// last wrote to data/index (a Gemini key fills these files). The embedding path is tested below
// with its own mocked vectors.
vi.mock("@data/index/embeddings.json", () => ({ default: { model: null, dimensions: 0, builtAt: null, vectors: {} } }));
vi.mock("@data/index/query-embeddings.json", () => ({ default: { model: null, dimensions: 0, vectors: {} } }));

// ------------------------------------------------------------------------------------ helpers

const ORDER_FAMILIES: PolicyId[] = ["RETURNS_STANDARD", "SHIPPING_DELAYS", "DAMAGE_TRANSIT"];
const CLAIM_FAMILIES: PolicyId[] = ["BILLING_DISPUTES", "GOODWILL_RETENTION", "APPROVAL_AUTHORITY"];

const VERSION_WINDOWS = [
  { version: "2024.1", effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31" },
  { version: "2025.1", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" },
  { version: "2026.1", effectiveFrom: "2026-01-01", effectiveTo: null },
] as const;

function clause(policyId: PolicyId, clauseId: string, v: (typeof VERSION_WINDOWS)[number]): Clause {
  return {
    key: `${clauseId}@${v.version}`,
    clauseId,
    title: `Title ${clauseId}`,
    policyId,
    version: v.version,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    category: policyId,
    binds: [],
    text: `text of ${clauseId} ${v.version}`,
  };
}

/** One clause per family per version (18 synthetic clauses). */
function syntheticCorpus(): Clause[] {
  const out: Clause[] = [];
  POLICY_IDS.forEach((p, i) => {
    for (const v of VERSION_WINDOWS) out.push(clause(p, `§${i + 1}.1`, v));
  });
  return out;
}

const versionsFor = (cs: Clause[], p: PolicyId) => [...new Set(cs.filter((c) => c.policyId === p).map((c) => c.version))].sort();

/** The version the gate (rules.ts) enforces for a family on these dates. */
const gateVersion = (p: PolicyId, dates: GoverningDates) =>
  policyFor(p, governingDateFor(p, { orderDate: dates.orderDate ?? null, claimDate: dates.claimDate })).version;

/** retrieve() reports RRF rounded to 5 decimals, BM25 and cosine to 4. */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** The fields of a hit that depend on ranking (everything else is copied from the clause). */
const rankedView = (h: RetrievedClause) => ({
  key: h.key,
  rank: h.rank,
  inEffect: h.inEffect,
  governingDate: h.governingDate,
  scores: h.scores,
});

/**
 * Spec 7.4 recomputed from the primitives tested above: temporal filter (unless naive) ->
 * BM25 and lexical-cosine rankings over the same candidates -> RRF over the lists the mode
 * uses -> drop hits with BM25 = 0 and cosine < floor (except in dense mode) -> sort by RRF,
 * ties by key -> top K.
 */
function expectedRetrieval(query: string, dates: GoverningDates, opts: { naive?: boolean; mode?: RetrievalMode; topK?: number } = {}) {
  const { k1, b } = AGENT.retrieval.bm25;
  const mode = opts.mode ?? "hybrid";
  const candidates = opts.naive ? getCorpus() : temporalFilter(getCorpus(), dates).kept;
  const bm = new Bm25Index(candidates.map((c) => ({ id: c.key, tokens: c.tokens })), k1, b).rank(tokenize(query));
  const dn = rankByCosine(lexicalVector(query), candidates.map((c) => ({ id: c.key, vector: c.lexical })));
  const fused = reciprocalRankFusion(mode === "bm25" ? [bm] : mode === "dense" ? [dn] : [bm, dn], AGENT.retrieval.rrfK);
  const bmById = new Map(bm.map((h) => [h.id, h]));
  const dnById = new Map(dn.map((h) => [h.id, h]));
  const results = candidates
    .map((c) => ({ c, bh: bmById.get(c.key)!, dh: dnById.get(c.key)!, rrf: fused.get(c.key)! }))
    .filter(({ bh, dh }) => mode === "dense" || bh.score > 0 || dh.score >= AGENT.retrieval.denseFloor)
    .sort((x, y) => y.rrf - x.rrf || x.c.key.localeCompare(y.c.key))
    .slice(0, opts.topK ?? AGENT.retrieval.topK)
    .map(({ c, bh, dh, rrf }, i) => {
      const governingDate = governingDateForClause(c, dates);
      return {
        key: c.key,
        rank: i + 1,
        inEffect: inEffect(governingDate, c.effectiveFrom, c.effectiveTo),
        governingDate,
        scores: { bm25: round4(bh.score), bm25Rank: bh.rank, dense: round4(dh.score), denseRank: dh.rank, rrf: round5(rrf) },
      };
    });
  return { candidates: candidates.length, results };
}

const DATES_2024_2026 = [
  "2024-01-01",
  "2024-02-29",
  "2024-06-15",
  "2024-12-31",
  "2025-01-01",
  "2025-07-04",
  "2025-12-31",
  "2026-01-01",
  "2026-10-16",
  "2026-12-31",
];

// ------------------------------------------------------------------------------------ tokenize

describe("tokenize / stem", () => {
  it("lowercases, strips accents, splits on non-alphanumerics and drops stopwords", () => {
    expect(tokenize("The item was REFUNDED to my card")).toEqual(["item", "refund", "card"]);
    expect(tokenize("I have been charged twice for my order!")).toEqual(["charg", "twice", "order"]);
    expect(tokenize("Café custom-cut glass")).toEqual(["cafe", "custom", "cut", "glass"]);
    expect(normalize("Crème BRÛLÉE")).toBe("creme brulee");
    // Only stopwords / punctuation -> nothing left.
    expect(tokenize("the and of to it is, was; with")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("keeps numbers unstemmed (leading zeros removed) so '90' matches '90 days'", () => {
    expect(tokenize("within 90 days")).toEqual(["within", "90", "dai"]);
    expect(tokenize("order 007 total 0 or 00")).toEqual(["order", "7", "total", "0", "0"]);
    expect(tokenize("$25.00 store credit")).toEqual(["25", "0", "store", "credit"]);
    expect(tokenize("ORD-9941 1500")).toEqual(["ord", "9941", "1500"]);
  });

  it("maps inflections to one stem (refunded / refunds / refunding -> refund)", () => {
    for (const w of ["refund", "refunded", "refunds", "refunding"]) expect(stem(w)).toBe("refund");
    expect(stem("charges")).toBe("charg");
    expect(stem("charged")).toBe("charg");
    expect(stem("damaged")).toBe("damag");
    expect(stem("damages")).toBe("damag");
    expect(stem("delivered")).toBe("deliv");
    expect(stem("delivery")).toBe("deliveri");
    expect(stem("replacement")).toBe("replac");
    expect(stem("days")).toBe("dai");
    // Words of length <= 2 are returned untouched.
    expect(stem("as")).toBe("as");
    expect(stem("is")).toBe("is");
  });

  it("matches the Porter (1980) reference vocabulary across every step", () => {
    const reference: [string, string][] = [
      // step 1a
      ["caresses", "caress"], ["ponies", "poni"], ["ties", "ti"], ["caress", "caress"], ["cats", "cat"],
      // step 1b
      ["feed", "feed"], ["agreed", "agre"], ["plastered", "plaster"], ["bled", "bled"], ["motoring", "motor"],
      ["sing", "sing"], ["conflated", "conflat"], ["troubled", "troubl"], ["sized", "size"], ["hopping", "hop"],
      ["tanned", "tan"], ["falling", "fall"], ["hissing", "hiss"], ["fizzed", "fizz"], ["failing", "fail"],
      ["filing", "file"],
      // step 1c
      ["happy", "happi"], ["sky", "sky"],
      // step 2
      ["relational", "relat"], ["conditional", "condit"], ["rational", "ration"], ["valenci", "valenc"],
      ["hesitanci", "hesit"], ["digitizer", "digit"], ["conformabli", "conform"], ["radicalli", "radic"],
      ["differentli", "differ"], ["vileli", "vile"], ["analogousli", "analog"], ["vietnamization", "vietnam"],
      ["predication", "predic"], ["operator", "oper"], ["feudalism", "feudal"], ["decisiveness", "decis"],
      ["hopefulness", "hope"], ["callousness", "callous"], ["formaliti", "formal"], ["sensitiviti", "sensit"],
      ["sensibiliti", "sensibl"],
      // step 3
      ["triplicate", "triplic"], ["formative", "form"], ["formalize", "formal"], ["electriciti", "electr"],
      ["electrical", "electr"], ["hopeful", "hope"], ["goodness", "good"],
      // step 4
      ["revival", "reviv"], ["allowance", "allow"], ["inference", "infer"], ["airliner", "airlin"],
      ["gyroscopic", "gyroscop"], ["adjustable", "adjust"], ["defensible", "defens"], ["irritant", "irrit"],
      ["replacement", "replac"], ["adjustment", "adjust"], ["dependent", "depend"], ["adoption", "adopt"],
      ["homologou", "homolog"], ["communism", "commun"], ["activate", "activ"], ["angulariti", "angular"],
      ["homologous", "homolog"], ["effective", "effect"], ["bowdlerize", "bowdler"],
      // step 5
      ["probate", "probat"], ["rate", "rate"], ["cease", "ceas"], ["controll", "control"], ["roll", "roll"],
      // multi-step
      ["generalizations", "gener"], ["oscillators", "oscil"],
      // step 1b "at" -> "ate" restored, then kept by step 5a's *o rule / stripped by step 4
      ["rated", "rate"], ["activated", "activ"], ["generated", "gener"],
      // step 4 drops "ion" only after s or t
      ["communion", "communion"],
      // y as a vowel after a consonant
      ["playing", "plai"], ["toys", "toi"],
    ];
    const mismatches = reference.filter(([w, s]) => stem(w) !== s).map(([w, s]) => `${w}: got ${stem(w)}, want ${s}`);
    expect(mismatches).toEqual([]);
  });

  it("tokenizes a typical policy sentence", () => {
    const text = "Refunds for damaged deliveries are processed to the original payment method";
    expect(tokenize(text)).toEqual(["refund", "damag", "deliveri", "process", "origin", "payment", "method"]);
    // Stopwords are matched after lowercasing, before stemming.
    expect(tokenize("YOURS WOULD THEIR Yours")).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ BM25

describe("Bm25Index (k1=1.2, b=0.75, Lucene idf)", () => {
  // Tiny corpus. avgdl = (3 + 2 + 4) / 3 = 3.
  const docs = [
    { id: "d1", tokens: ["refund", "order", "refund"] }, // dl = 3
    { id: "d2", tokens: ["order", "ship"] }, // dl = 2
    { id: "d3", tokens: ["damag", "glass", "order", "ship"] }, // dl = 4
  ];
  const idx = new Bm25Index(docs, 1.2, 0.75);

  it("uses the Lucene idf ln(1 + (N - df + 0.5) / (df + 0.5))", () => {
    expect(idx.size).toBe(3);
    // refund: df=1 -> ln(1 + 2.5/1.5) = ln(8/3)
    expect(idx.idf("refund")).toBeCloseTo(0.9808292530117262, 12);
    // order: df=3 -> ln(1 + 0.5/3.5) = ln(8/7)
    expect(idx.idf("order")).toBeCloseTo(0.13353139262452257, 12);
    // ship: df=2 -> ln(1 + 1.5/2.5) = ln(1.6)
    expect(idx.idf("ship")).toBeCloseTo(0.47000362924573563, 12);
    // unseen: df=0 -> ln(1 + 3.5/0.5) = ln(8)
    expect(idx.idf("zzz")).toBeCloseTo(2.0794415416798357, 12);
    // never negative even when every doc contains the term
    expect(idx.idf("order")).toBeGreaterThan(0);
  });

  it("scores a single-term query exactly as hand-computed", () => {
    // d1: f=2, dl=3=avgdl -> denom = 2 + 1.2*(0.25 + 0.75) = 3.2; tf = 2*2.2/3.2 = 1.375
    expect(idx.score(["refund"], "d1")).toBeCloseTo(1.375 * Math.log(8 / 3), 12);
    expect(idx.score(["refund"], "d1")).toBeCloseTo(1.3486402228911234, 12);
    expect(idx.score(["refund"], "d2")).toBe(0);
    expect(idx.score(["refund"], "d3")).toBe(0);
  });

  it("scores a two-term query with length normalisation exactly as hand-computed", () => {
    const q = ["order", "ship"];
    const idfSum = Math.log(8 / 7) + Math.log(1.6);
    // d2: dl=2 -> denom = 1 + 1.2*(0.25 + 0.75*2/3) = 1.9 ; tf = 2.2/1.9 per term
    expect(idx.score(q, "d2")).toBeCloseTo((2.2 / 1.9) * idfSum, 12);
    expect(idx.score(q, "d2")).toBeCloseTo(0.698830025323457, 12);
    // d3: dl=4 -> denom = 1 + 1.2*(0.25 + 0.75*4/3) = 2.5 ; tf = 2.2/2.5 = 0.88 per term
    expect(idx.score(q, "d3")).toBeCloseTo(0.5311108192458273, 12);
    // d1: only "order", dl=3 -> denom = 2.2 ; tf = 1
    expect(idx.score(q, "d1")).toBeCloseTo(Math.log(8 / 7), 12);
  });

  it("counts a repeated query term once and returns 0 for an unknown doc", () => {
    expect(idx.score(["refund", "refund", "refund"], "d1")).toBeCloseTo(idx.score(["refund"], "d1"), 15);
    expect(idx.score(["refund"], "nope")).toBe(0);
    expect(idx.score([], "d1")).toBe(0);
  });

  it("defaults to k1 = 1.2 and b = 0.75", () => {
    const byDefault = new Bm25Index(docs);
    for (const q of [["refund"], ["order", "ship"], ["damag", "refund"], ["glass"]]) {
      for (const d of ["d1", "d2", "d3"]) expect(byDefault.score(q, d)).toBe(idx.score(q, d));
    }
    // A k1 / b change would move this hand-computed value (d3: dl=4, f=1 -> tf 0.88).
    expect(byDefault.score(["glass"], "d3")).toBeCloseTo(0.88 * Math.log(8 / 3), 12);
  });

  it("honours custom k1 / b (b=0 disables length normalisation)", () => {
    const flat = new Bm25Index(docs, 1.2, 0);
    // With b=0 every single-occurrence term gets tf = 2.2 / (1 + 1.2) = 1 regardless of length.
    expect(flat.score(["order"], "d2")).toBeCloseTo(Math.log(8 / 7), 12);
    expect(flat.score(["order"], "d3")).toBeCloseTo(Math.log(8 / 7), 12);
    // k1 = 0 -> pure idf (term frequency saturates immediately)
    const binary = new Bm25Index(docs, 0, 0.75);
    expect(binary.score(["refund"], "d1")).toBeCloseTo(Math.log(8 / 3), 12);
  });

  it("ranks by score descending with 1-based ranks", () => {
    const ranked = idx.rank(["order", "ship"]);
    expect(ranked.map((h) => h.id)).toEqual(["d2", "d3", "d1"]);
    expect(ranked.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(ranked[0].score).toBeCloseTo(0.698830025323457, 12);
    expect(ranked[2].score).toBeCloseTo(Math.log(8 / 7), 12);

    const r2 = idx.rank(["refund"]);
    expect(r2.map((h) => [h.id, h.rank])).toEqual([["d1", 1], ["d2", 2], ["d3", 3]]);
    expect(r2[1].score).toBe(0);
  });

  it("breaks ties by id so ranking is deterministic regardless of insertion order", () => {
    const tie = new Bm25Index([
      { id: "c", tokens: ["x", "y"] },
      { id: "a", tokens: ["x", "y"] },
      { id: "b", tokens: ["x", "y"] },
    ]);
    expect(tie.rank(["x"]).map((h) => h.id)).toEqual(["a", "b", "c"]);
    // No match at all: every score is 0 and order falls back to id.
    expect(idx.rank(["nothing"]).map((h) => [h.id, h.score])).toEqual([["d1", 0], ["d2", 0], ["d3", 0]]);
  });

  it("handles an empty index", () => {
    const empty = new Bm25Index([]);
    expect(empty.size).toBe(0);
    expect(empty.rank(["refund"])).toEqual([]);
    expect(empty.score(["refund"], "d1")).toBe(0);
  });
});

// ------------------------------------------------------------------------------------ RRF

describe("reciprocalRankFusion", () => {
  it("sums 1/(60 + rank) across lists (hand-calculated)", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a", rank: 1 }, { id: "b", rank: 2 }, { id: "c", rank: 3 }],
      [{ id: "b", rank: 1 }, { id: "c", rank: 2 }, { id: "a", rank: 3 }, { id: "d", rank: 4 }],
    ]);
    expect(fused.size).toBe(4);
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 63, 15);
    expect(fused.get("a")).toBeCloseTo(0.032266458495966696, 15);
    expect(fused.get("b")).toBeCloseTo(0.03252247488101534, 15);
    expect(fused.get("c")).toBeCloseTo(0.03200204813108039, 15);
    expect(fused.get("d")).toBe(1 / 64);
    const order = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order).toEqual(["b", "a", "c", "d"]);
  });

  it("uses the given k and handles single / empty inputs", () => {
    const fused = reciprocalRankFusion([[{ id: "a", rank: 1 }], [{ id: "a", rank: 1 }]], 1);
    expect(fused.get("a")).toBe(1); // 1/2 + 1/2
    expect(reciprocalRankFusion([]).size).toBe(0);
    expect(reciprocalRankFusion([[{ id: "z", rank: 5 }]]).get("z")).toBe(1 / 65);
  });
});

// ------------------------------------------------------------------------------------ dense

describe("dense similarity", () => {
  it("cosine: parallel = 1, orthogonal = 0, opposite = -1, zero vector = 0", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-3, 0])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([3, 4], [4, 3])).toBeCloseTo(24 / 25, 12);
    // Different lengths compare the common prefix only.
    expect(cosine([1, 0, 99], [1, 0])).toBeCloseTo(1, 12);
    expect(cosine(new Float32Array([1, 1]), [1, 1])).toBeCloseTo(1, 6);
  });

  it("l2normalize returns a unit vector and leaves the zero vector alone", () => {
    expect(l2normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("lexicalVector is 512-d, L2-normalised and deterministic", () => {
    const v = lexicalVector("Refund for a damaged order");
    expect(v).toHaveLength(512);
    expect(v.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 12);
    expect(lexicalVector("Refund for a damaged order")).toEqual(v);
    expect(cosine(v, v)).toBeCloseTo(1, 12);
    // Empty text has neither words nor trigrams -> zero vector (cosine 0, never NaN).
    const empty = lexicalVector("");
    expect(empty.every((x) => x === 0)).toBe(true);
    expect(cosine(empty, v)).toBe(0);
  });

  it("lexicalVector weights a stemmed word 1 and each padded character trigram 0.5", () => {
    const nonZero = (v: number[]) => v.filter((x) => x !== 0).sort((a, b) => a - b);
    // "ab": word "ab" (1) + trigrams " ab", "ab " (0.5 each) -> [0.5, 0.5, 1] / sqrt(1.5).
    const ab = lexicalVector("ab");
    expect(nonZero(ab)).toHaveLength(3);
    nonZero(ab).forEach((x, i) => expect(x).toBeCloseTo([0.5, 0.5, 1][i] / Math.sqrt(1.5), 12));
    // A stopword contributes no word bucket, only its trigrams " th", "the", "he ".
    const the = lexicalVector("the");
    expect(nonZero(the)).toHaveLength(3);
    for (const x of nonZero(the)) expect(x).toBeCloseTo(1 / Math.sqrt(3), 12);
    // Repeating the text doubles every count, which normalisation cancels out.
    lexicalVector("ab AB").forEach((x, i) => expect(x).toBeCloseTo(ab[i], 12));
    // Word and trigram buckets are hashed separately: "ab" and "the" share nothing.
    expect(cosine(ab, the)).toBe(0);
  });

  it("puts similar texts closer than unrelated ones", () => {
    const q = lexicalVector("refund for a damaged order");
    const similar = lexicalVector("refunds on damaged orders");
    const unrelated = lexicalVector("carrier tracking scan delayed at the hub");
    expect(cosine(q, similar)).toBeGreaterThan(cosine(q, unrelated));
    expect(cosine(q, similar)).toBeGreaterThan(0.5);
    // Inflections share a stem bucket, so "refunded" is much closer to "refund" than "glass" is.
    expect(cosine(lexicalVector("refunded"), lexicalVector("refund"))).toBeGreaterThan(cosine(lexicalVector("glass"), lexicalVector("refund")));
    // Case and accents do not matter.
    expect(cosine(lexicalVector("CAFÉ Order"), lexicalVector("cafe order"))).toBeCloseTo(1, 12);
  });

  it("rankByCosine sorts by similarity with id tie-break and 1-based ranks", () => {
    const hits = rankByCosine([1, 0], [
      { id: "z", vector: [0, 1] },
      { id: "m", vector: [1, 1] },
      { id: "b", vector: [2, 0] },
      { id: "a", vector: [0, 5] },
    ]);
    expect(hits.map((h) => h.id)).toEqual(["b", "m", "a", "z"]);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
    expect(hits[0].score).toBeCloseTo(1, 12);
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 12);
    expect(hits[2].score).toBe(0);
  });
});

// ------------------------------------------------------------------------------------ temporal filter

describe("temporalFilter / governingDateForClause", () => {
  it("routes order-date families to the order date and the rest to the claim date", () => {
    const dates = { claimDate: "2026-03-01", orderDate: "2024-07-07" };
    for (const p of ORDER_FAMILIES) expect(governingDateForClause({ policyId: p }, dates)).toBe("2024-07-07");
    for (const p of CLAIM_FAMILIES) expect(governingDateForClause({ policyId: p }, dates)).toBe("2026-03-01");
    // No order date (or empty) -> every family falls back to the claim date.
    for (const p of POLICY_IDS) {
      expect(governingDateForClause({ policyId: p }, { claimDate: "2025-05-05" })).toBe("2025-05-05");
      expect(governingDateForClause({ policyId: p }, { claimDate: "2025-05-05", orderDate: null })).toBe("2025-05-05");
      expect(governingDateForClause({ policyId: p }, { claimDate: "2025-05-05", orderDate: "" })).toBe("2025-05-05");
    }
  });

  it("agrees with rules.json on which families are order-date governed", () => {
    for (const p of POLICY_IDS) {
      const dates = { claimDate: "2026-02-02", orderDate: "2024-03-03" };
      expect(governingDateForClause({ policyId: p }, dates)).toBe(governingDateFor(p, dates));
      expect(RULES.families[p].governingDate).toBe(ORDER_FAMILIES.includes(p) ? "order_date" : "claim_date");
    }
  });

  it.each([
    ["2024-01-01", "2024.1"],
    ["2024-12-31", "2024.1"],
    ["2025-01-01", "2025.1"],
    ["2025-12-31", "2025.1"],
    ["2026-01-01", "2026.1"],
    ["2030-06-30", "2026.1"],
  ])("boundary day %s keeps exactly version %s (inclusive effective dates)", (day, version) => {
    const cs = syntheticCorpus();
    const { kept, removed } = temporalFilter(cs, { claimDate: day, orderDate: day });
    expect(kept).toHaveLength(6);
    expect(kept.every((c) => c.version === version)).toBe(true);
    expect(removed).toHaveLength(12);
    expect(removed.every((r) => r.clause.version !== version && r.reason === `not in effect on ${day}`)).toBe(true);
  });

  it("removes every clause before the first version took effect", () => {
    const { kept, removed } = temporalFilter(syntheticCorpus(), { claimDate: "2023-12-31", orderDate: "2023-12-31" });
    expect(kept).toEqual([]);
    expect(removed).toHaveLength(18);
  });

  it("filters order-date and claim-date families on different dates", () => {
    const cs = syntheticCorpus();
    // Order placed on the last day of 2024, claim filed on the first day of 2026.
    const dates = { claimDate: "2026-01-01", orderDate: "2024-12-31" };
    const { kept, removed } = temporalFilter(cs, dates);
    for (const p of ORDER_FAMILIES) expect(versionsFor(kept, p)).toEqual(["2024.1"]);
    for (const p of CLAIM_FAMILIES) expect(versionsFor(kept, p)).toEqual(["2026.1"]);
    const reasons = new Set(removed.map((r) => `${r.clause.policyId}:${r.reason}`));
    expect(reasons.has("RETURNS_STANDARD:not in effect on 2024-12-31")).toBe(true);
    expect(reasons.has("BILLING_DISPUTES:not in effect on 2026-01-01")).toBe(true);
    expect(reasons.has("RETURNS_STANDARD:not in effect on 2026-01-01")).toBe(false);

    // Same claim date, order on 2025-01-01: order families flip to 2025.1.
    const k2 = temporalFilter(cs, { claimDate: "2026-01-01", orderDate: "2025-01-01" }).kept;
    for (const p of ORDER_FAMILIES) expect(versionsFor(k2, p)).toEqual(["2025.1"]);
    for (const p of CLAIM_FAMILIES) expect(versionsFor(k2, p)).toEqual(["2026.1"]);
  });

  it("partitions the real corpus: 126 clauses -> 42 kept (7 per family) + 84 removed", () => {
    const all = getCorpus();
    const { kept, removed } = temporalFilter(all, { claimDate: "2026-10-16", orderDate: "2024-12-31" });
    expect(all).toHaveLength(126);
    expect(kept).toHaveLength(42);
    expect(removed).toHaveLength(84);
    const keptKeys = new Set(kept.map((c) => c.key));
    expect(removed.some((r) => keptKeys.has(r.clause.key))).toBe(false);
    for (const p of POLICY_IDS) expect(kept.filter((c) => c.policyId === p)).toHaveLength(7);
    for (const p of ORDER_FAMILIES) expect(versionsFor(kept, p)).toEqual(["2024.1"]);
    for (const p of CLAIM_FAMILIES) expect(versionsFor(kept, p)).toEqual(["2026.1"]);
  });
});

// ------------------------------------------------------------------------------------ consistency with the gate

describe("temporal filter <-> policy gate consistency", () => {
  it("for every family and date pair in 2024-2026, the kept clause version equals policyFor(family, governingDate).version", () => {
    const all = getCorpus();
    const mismatches: string[] = [];
    let checked = 0;
    for (const claimDate of DATES_2024_2026) {
      for (const orderDate of [null, ...DATES_2024_2026]) {
        const dates: GoverningDates = { claimDate, orderDate };
        const { kept } = temporalFilter(all, dates);
        for (const family of POLICY_IDS) {
          const gov = governingDateFor(family, { claimDate, orderDate });
          const gate = policyFor(family, gov);
          const keptVersions = versionsFor(kept, family);
          if (keptVersions.length !== 1 || keptVersions[0] !== gate.version) {
            mismatches.push(`${family} claim=${claimDate} order=${orderDate}: kept ${keptVersions.join(",")} gate ${gate.version}`);
          }
          // Every clause the gate's rules cite is present in what the retriever is allowed to see.
          for (const id of gate.clauseIds) {
            if (!kept.some((c) => c.key === `${id}@${gate.version}`)) mismatches.push(`${family} missing ${id}@${gate.version}`);
          }
          expect(governingDateForClause({ policyId: family }, dates)).toBe(gov);
          checked++;
        }
      }
    }
    expect(checked).toBe(DATES_2024_2026.length * (DATES_2024_2026.length + 1) * POLICY_IDS.length);
    expect(mismatches).toEqual([]);
  });

  it("corpus clause effective windows match the rules.json version windows", () => {
    for (const c of getCorpus()) {
      const gate = policyFor(c.policyId, c.effectiveFrom);
      expect(gate.version).toBe(c.version);
      expect(gate.effectiveFrom).toBe(c.effectiveFrom);
      expect(gate.effectiveTo).toBe(c.effectiveTo);
    }
  });
});

// ------------------------------------------------------------------------------------ corpus

describe("corpus", () => {
  it("indexes title + text with tokens and lexical vectors, memoised", () => {
    const a = getCorpus();
    expect(getCorpus()).toBe(a);
    const c = findClause("§1.4@2026.1")!;
    expect(c.clauseId).toBe("§1.4");
    expect(c.version).toBe("2026.1");
    expect(c.title).toBe("Return window");
    expect(c.text).toContain("30 days");
    expect(c.tokens).toEqual(tokenize(`${c.title}. ${c.text}`));
    expect(c.lexical).toEqual(lexicalVector(`${c.title}. ${c.text}`));
    expect(c.embedding).toBeNull();
    expect(findClause("§9.9@2026.1")).toBeUndefined();
    expect(new Set(a.map((x) => x.key)).size).toBe(a.length);
  });

  it("reports metadata and normalises query keys", () => {
    const meta = corpusMeta();
    expect(meta.clauses).toBe(126);
    expect(meta.embeddingModel).toBeNull();
    expect(meta.embeddedClauses).toBe(0);
    expect(embeddingModel()).toBeNull();
    expect(queryKey("  Where is   my REFUND? ")).toBe(queryKey("where is my refund?"));
    expect(queryKey("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(queryKey("refund")).not.toBe(queryKey("refunds"));
    // No embedding model in the (mocked, empty) index -> no cached query vectors.
    expect(cachedQueryEmbedding("where is my refund?")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------ retrieve()

describe("retrieve() — naive vs temporal", () => {
  const RETURN_Q = "how many days is the return window after the order date";
  const dates = { claimDate: "2026-10-16", orderDate: "2025-06-01" };

  it("naive retrieval can cite clauses that were not in effect; temporal never does", () => {
    const naive = retrieve({ query: RETURN_Q, dates, naive: true });
    const temporal = retrieve({ query: RETURN_Q, dates });

    expect(naive.naive).toBe(true);
    expect(naive.candidates).toBe(126);
    expect(temporal.naive).toBe(false);
    expect(temporal.candidates).toBe(42);
    expect(naive.removed).toHaveLength(84);
    expect(temporal.removed).toHaveLength(84);

    // Every version of §1.4 competes in the naive run; the stale ones are flagged.
    const naiveKeys = naive.results.map((r) => r.key);
    expect(naiveKeys).toEqual(expect.arrayContaining(["§1.4@2024.1", "§1.4@2025.1", "§1.4@2026.1"]));
    expect(naive.results.filter((r) => !r.inEffect).length).toBeGreaterThan(0);
    expect(naive.results.find((r) => r.key === "§1.4@2024.1")!.inEffect).toBe(false);
    expect(naive.results.find((r) => r.key === "§1.4@2026.1")!.inEffect).toBe(false);

    // Temporal: the return window clause of the version governing a 2025-06-01 order wins.
    expect(temporal.results[0].key).toBe("§1.4@2025.1");
    expect(temporal.results[0].text).toContain("90 days");
    expect(temporal.results.every((r) => r.inEffect)).toBe(true);
    for (const r of temporal.results) expect(r.version).toBe(gateVersion(r.policyId as PolicyId, dates));
  });

  it("temporal retrieval never returns an out-of-effect clause across queries and dates", () => {
    const queries = [
      RETURN_Q,
      "I was charged twice for the same order",
      "my package is late, what compensation do I get",
      "package lost no tracking update",
      "glass arrived shattered, damaged in transit, photo evidence",
      "goodwill store credit for a loyal customer who wants to cancel",
      "my manager approved a refund, process it now",
      "non-refundable clearance gift card",
    ];
    const dateSets: GoverningDates[] = [
      { claimDate: "2024-12-31", orderDate: "2024-12-31" },
      { claimDate: "2025-01-01", orderDate: "2024-12-31" },
      { claimDate: "2026-01-01", orderDate: "2025-12-31" },
      { claimDate: "2026-10-16", orderDate: null },
      { claimDate: "2026-10-16", orderDate: "2024-03-15" },
    ];
    let seen = 0;
    let staleInNaive = 0;
    for (const query of queries) {
      for (const d of dateSets) {
        for (const mode of ["hybrid", "bm25", "dense"] as const) {
          const r = retrieve({ query, dates: d, mode });
          for (const hit of r.results) {
            seen++;
            expect(hit.inEffect, `${mode} ${query} ${JSON.stringify(d)} -> ${hit.key}`).toBe(true);
            expect(hit.version).toBe(gateVersion(hit.policyId as PolicyId, d));
            expect(hit.governingDate).toBe(governingDateFor(hit.policyId as PolicyId, { claimDate: d.claimDate, orderDate: d.orderDate }));
          }
          expect(r.results.length).toBeLessThanOrEqual(AGENT.retrieval.topK);
          staleInNaive += retrieve({ query, dates: d, mode, naive: true }).results.filter((h) => !h.inEffect).length;
        }
      }
    }
    expect(seen).toBeGreaterThan(300);
    // ...while the same queries without the filter cite stale clauses many times over.
    expect(staleInNaive).toBeGreaterThan(100);
  });

  it("uses the spec 7.4 retriever settings", () => {
    expect(AGENT.retrieval).toEqual({ bm25: { k1: 1.2, b: 0.75 }, rrfK: 60, topK: 5, denseFloor: 0.35 });
  });

  it("matches an independent recomputation: filter -> BM25 + dense -> RRF -> floor -> top K", () => {
    const queries = [
      RETURN_Q,
      "I was charged twice for the same order",
      "supervisor",
      "my package is late, what compensation do I get",
      "glass arrived shattered, damaged in transit, photo evidence",
      "evidenc",
      "evidential",
    ];
    const dateSets: GoverningDates[] = [dates, { claimDate: "2026-10-16", orderDate: "2024-12-31" }, { claimDate: "2025-03-01", orderDate: null }];
    let compared = 0;
    for (const query of queries) {
      for (const d of dateSets) {
        for (const naive of [false, true]) {
          for (const mode of ["hybrid", "bm25", "dense"] as const) {
            for (const topK of [undefined, 3]) {
              const actual = retrieve({ query, dates: d, naive, mode, topK });
              const expected = expectedRetrieval(query, d, { naive, mode, topK });
              const label = `${query} ${JSON.stringify(d)} naive=${naive} ${mode} k=${topK}`;
              expect(actual.candidates, label).toBe(expected.candidates);
              expect(actual.results.map(rankedView), label).toEqual(expected.results);
              compared += expected.results.length;
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("breaks equal RRF scores by clause key", () => {
    // §2.1 is 1st by BM25 / 2nd by cosine, §4.7 the reverse: identical RRF, so the key decides.
    const r = retrieve({ query: "I was charged twice for the same order", dates });
    const [first, second] = r.results;
    expect([first.key, first.scores.bm25Rank, first.scores.denseRank]).toEqual(["§2.1@2026.1", 1, 2]);
    expect([second.key, second.scores.bm25Rank, second.scores.denseRank]).toEqual(["§4.7@2025.1", 2, 1]);
    expect(first.scores.rrf).toBe(second.scores.rrf);
    expect(first.scores.rrf).toBe(round5(1 / 61 + 1 / 62));

    // Same again further down: §5.4 is (3, 5) and §6.2 is (5, 3).
    const sup = retrieve({ query: "supervisor", dates }).results;
    const i = sup.findIndex((h) => h.key === "§5.4@2026.1");
    expect(i).toBeGreaterThan(0);
    expect(sup[i + 1].key).toBe("§6.2@2026.1");
    expect([sup[i].scores.bm25Rank, sup[i].scores.denseRank, sup[i + 1].scores.bm25Rank, sup[i + 1].scores.denseRank]).toEqual([3, 5, 5, 3]);
  });

  it("keeps a clause with no lexical match only when its cosine reaches the 0.35 floor", () => {
    const kept = temporalFilter(getCorpus(), dates).kept;
    const topCosine = (q: string) => rankByCosine(lexicalVector(q), kept.map((c) => ({ id: c.key, vector: c.lexical })))[0];

    // A misspelling shares no stem with any clause, but its trigrams pull the evidence clause over the floor.
    const saved = retrieve({ query: "evidenc", dates });
    expect(saved.results.map((h) => h.key)).toEqual(["§4.3@2025.1"]);
    const hit = saved.results[0];
    expect(hit.scores.bm25).toBe(0);
    expect(hit.scores.dense).toBeGreaterThanOrEqual(AGENT.retrieval.denseFloor);
    expect(hit.scores.denseRank).toBe(1);
    // Every BM25 score is 0, so BM25 rank is the key order: 7 clauses each of §1-§3, then §4.1, §4.2, §4.3.
    expect(hit.scores.bm25Rank).toBe(24);
    expect(hit.scores.rrf).toBe(round5(1 / 84 + 1 / 61));

    // Same situation just under the floor: nothing survives.
    const best = topCosine("evidential");
    expect(best.score).toBeLessThan(AGENT.retrieval.denseFloor);
    expect(best.score).toBeGreaterThan(0.2);
    expect(tokenize("evidential").some((t) => kept.some((c) => c.tokens.includes(t)))).toBe(false);
    expect(retrieve({ query: "evidential", dates }).results).toEqual([]);
  });

  it("reports wall time from performance.now, rounded to 2 decimals", () => {
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(1000).mockReturnValueOnce(1003.14159);
      expect(retrieve({ query: RETURN_Q, dates }).timingMs).toBe(3.14);
      // retrieveForIntents adds up the per-intent runs.
      now.mockReturnValueOnce(0).mockReturnValueOnce(1.234).mockReturnValueOnce(10).mockReturnValueOnce(12.5);
      expect(retrieveForIntents(["return_request", "double_charge"], "refund please", dates).timingMs).toBeCloseTo(1.23 + 2.5, 10);
    } finally {
      now.mockRestore();
    }
  });

  it("returns fully populated hits: ranks, rounded scores, RRF = sum of 1/(60+rank), citation", () => {
    const r = retrieve({ query: RETURN_Q, dates });
    expect(r.mode).toBe("hybrid");
    expect(r.denseMode).toBe("lexical-fallback");
    expect(r.query).toBe(RETURN_Q);
    expect(r.dates).toEqual(dates);
    expect(r.results).toHaveLength(AGENT.retrieval.topK);
    expect(r.results.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < r.results.length; i++) expect(r.results[i - 1].scores.rrf).toBeGreaterThanOrEqual(r.results[i].scores.rrf);
    for (const h of r.results) {
      const expected = 1 / (AGENT.retrieval.rrfK + h.scores.bm25Rank) + 1 / (AGENT.retrieval.rrfK + h.scores.denseRank);
      expect(h.scores.rrf).toBe(round5(expected));
      expect(h.scores.bm25).toBe(Math.round(h.scores.bm25 * 1e4) / 1e4);
      expect(h.citation).toBe(citationLabel(h));
      expect(h.citation).toBe(`${h.clauseId} ${h.title} — v${h.version}`);
      expect(h.key).toBe(`${h.clauseId}@${h.version}`);
      expect(h.pinned).toBeUndefined();
    }
    // Top hit is rank 1 in both lists here: 2/61 rounded to 5 places.
    expect(r.results[0].scores.bm25Rank).toBe(1);
    expect(r.results[0].scores.denseRank).toBe(1);
    expect(r.results[0].scores.rrf).toBe(0.03279);
    // Removed entries carry the reason with the governing date that excluded them.
    const stale = r.removed.find((x) => x.key === "§1.4@2026.1")!;
    expect(stale.reason).toBe("not in effect on 2025-06-01");
    expect(r.removed.find((x) => x.key === "§2.1@2025.1")!.reason).toBe("not in effect on 2026-10-16");
  });

  it("respects topK and single-list modes (bm25 / dense)", () => {
    expect(retrieve({ query: RETURN_Q, dates, topK: 2 }).results).toHaveLength(2);
    const bm = retrieve({ query: RETURN_Q, dates, mode: "bm25" });
    expect(bm.mode).toBe("bm25");
    for (const h of bm.results) expect(h.scores.rrf).toBe(round5(1 / (60 + h.scores.bm25Rank)));
    expect(bm.results.map((h) => h.scores.bm25Rank)).toEqual([...bm.results.map((h) => h.scores.bm25Rank)].sort((a, b) => a - b));
    const dn = retrieve({ query: RETURN_Q, dates, mode: "dense" });
    expect(dn.mode).toBe("dense");
    expect(dn.results.map((h) => h.scores.denseRank)).toEqual([1, 2, 3, 4, 5]);
    for (const h of dn.results) expect(h.scores.rrf).toBe(round5(1 / (60 + h.scores.denseRank)));
  });

  it("drops candidates with no lexical match and dense similarity below the floor", () => {
    const gib = retrieve({ query: "zzzz qqqq xylophone", dates });
    expect(gib.results).toEqual([]);
    expect(gib.candidates).toBe(42);
    // Dense mode has no floor on BM25, so it always fills topK.
    expect(retrieve({ query: "zzzz qqqq xylophone", dates, mode: "dense" }).results).toHaveLength(5);
    // Every surviving hybrid hit passed the floor.
    for (const h of retrieve({ query: "charged twice", dates }).results) {
      expect(h.scores.bm25 > 0 || h.scores.dense >= AGENT.retrieval.denseFloor).toBe(true);
    }
  });

  it("stays on the lexical fallback when the corpus has no model embeddings, even if a query vector is given", () => {
    const r = retrieve({ query: RETURN_Q, dates, queryEmbedding: new Array(768).fill(0.1) });
    expect(r.denseMode).toBe("lexical-fallback");
    expect(r.results[0].key).toBe("§1.4@2025.1");
  });
});

// ------------------------------------------------------------------------------------ retrieveForIntents

describe("retrieveForIntents — pins the rules.json clauses for each intent family", () => {
  const dateSets: GoverningDates[] = [
    { claimDate: "2026-10-16", orderDate: "2024-11-20" },
    { claimDate: "2026-10-16", orderDate: "2025-06-01" },
    { claimDate: "2026-10-16", orderDate: "2026-10-01" },
    { claimDate: "2025-01-01", orderDate: "2024-12-31" },
    { claimDate: "2024-12-31", orderDate: null },
  ];

  it.each(Object.entries(INTENT_FAMILY) as [string, PolicyId][])("intent %s always carries every %s clauseId at the gate's version", (intent, family) => {
    for (const dates of dateSets) {
      const r = retrieveForIntents([intent], "please help with my order", dates);
      const gate = policyFor(family, governingDateFor(family, { claimDate: dates.claimDate, orderDate: dates.orderDate }));
      const keys = r.results.map((x) => x.key);
      for (const id of gate.clauseIds) expect(keys, `${intent} ${JSON.stringify(dates)}`).toContain(`${id}@${gate.version}`);

      // No other version of the family's clauses leaks in.
      for (const x of r.results.filter((x) => x.policyId === family)) expect(x.version).toBe(gate.version);
      expect(r.results.every((x) => x.inEffect)).toBe(true);

      // Unique keys, contiguous ranks, pinned entries come after ranked ones with zero scores.
      expect(new Set(keys).size).toBe(keys.length);
      expect(r.results.map((x) => x.rank)).toEqual(keys.map((_, i) => i + 1));
      const pinned = r.results.filter((x) => x.pinned);
      expect(r.pinnedCount).toBe(pinned.length);
      const firstPinned = r.results.findIndex((x) => x.pinned);
      if (firstPinned >= 0) expect(r.results.slice(firstPinned).every((x) => x.pinned)).toBe(true);
      for (const p of pinned) {
        expect(gate.clauseIds).toContain(p.clauseId);
        expect(p.scores).toEqual({ bm25: 0, bm25Rank: 0, dense: 0, denseRank: 0, rrf: 0 });
        expect(p.governingDate).toBe(governingDateFor(family, { claimDate: dates.claimDate, orderDate: dates.orderDate }));
      }
      // Exactly the rules.json clauses the ranking missed, in rules.json order.
      const rankedKeys = new Set(r.results.filter((x) => !x.pinned).map((x) => x.key));
      expect(pinned.map((x) => x.key)).toEqual(gate.clauseIds.map((id) => `${id}@${gate.version}`).filter((k) => !rankedKeys.has(k)));
      expect(r.results.length - pinned.length).toBeLessThanOrEqual(AGENT.retrieval.topK);
      expect(r.removedCount).toBe(84);
      expect(r.queries).toEqual([`${INTENT_QUERY_HINTS[intent]} please help with my order`]);
      expect(r.denseMode).toBe("lexical-fallback");
    }
  });

  it("pinned clauses state the exact numbers the gate enforces", () => {
    const dates = { claimDate: "2026-10-16", orderDate: "2024-11-20" };
    const r = retrieveForIntents(["return_request"], "can I send this back", dates);
    const gate = policyFor("RETURNS_STANDARD", "2024-11-20");
    expect(gate.version).toBe("2024.1");
    expect(gate.params.returnWindowDays).toBe(45);
    for (const id of gate.clauseIds) {
      const hit = r.results.find((x) => x.key === `${id}@2024.1`)!;
      expect(hit.governingDate).toBe("2024-11-20");
      const c = findClause(hit.key)!;
      for (const param of c.binds) {
        for (const shown of formatParamForText(param, (gate.params as Record<string, unknown>)[param])) expect(hit.text).toContain(shown);
      }
    }
    expect(r.results.find((x) => x.key === "§1.4@2024.1")!.text).toContain("45 days");
  });

  it("intents without a family pin nothing", () => {
    for (const intent of ["refund_status", "policy_question", "other", "unknown_intent"]) {
      const r = retrieveForIntents([intent], "where is my refund", { claimDate: "2026-10-16", orderDate: "2026-10-01" });
      expect(r.pinnedCount).toBe(0);
      expect(r.results.some((x) => x.pinned)).toBe(false);
      expect(r.results.length).toBeLessThanOrEqual(AGENT.retrieval.topK);
      expect(r.results.every((x) => x.inEffect)).toBe(true);
    }
    expect(retrieveForIntents(["unknown_intent"], "hello", { claimDate: "2026-10-16" }).queries).toEqual(["hello"]);
  });

  it("merges multiple intents: topK+1 ranked, each run's best hit guaranteed, both families pinned", () => {
    const msg = "My glass panel arrived shattered and I was charged twice";
    const dates = { claimDate: "2026-10-16", orderDate: "2024-12-31" };
    const r = retrieveForIntents(["damaged_item", "double_charge"], msg, dates);
    const ranked = r.results.filter((x) => !x.pinned);
    expect(ranked.length).toBeLessThanOrEqual(AGENT.retrieval.topK + 1);
    expect(r.queries).toHaveLength(2);

    for (const [i, intent] of ["damaged_item", "double_charge"].entries()) {
      const best = retrieve({ query: `${INTENT_QUERY_HINTS[intent]} ${msg}`, dates, topK: 5 }).results[0];
      expect(r.queries[i]).toBe(`${INTENT_QUERY_HINTS[intent]} ${msg}`);
      expect(ranked.map((x) => x.key)).toContain(best.key);
    }
    const keys = r.results.map((x) => x.key);
    // DAMAGE_TRANSIT is order-date governed (2024.1); BILLING_DISPUTES is claim-date governed (2026.1).
    for (const k of ["§4.2@2024.1", "§4.3@2024.1", "§2.1@2026.1", "§2.2@2026.1"]) expect(keys).toContain(k);
    expect(keys.some((k) => k.startsWith("§4.") && !k.endsWith("@2024.1"))).toBe(false);
    expect(keys.some((k) => k.startsWith("§2.") && !k.endsWith("@2026.1"))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([
    ["damaged_item", "return_request", "My glass panel arrived shattered and I was charged twice"],
    ["return_request", "policy_question", "please help with my order"],
    ["late_delivery", "other", "my package is late and I want to cancel my account"],
  ])("merges %s + %s: best score per clause, each run's top hit first, then by RRF, topK + 1 kept", (a, b, msg) => {
    const dates = { claimDate: "2026-10-16", orderDate: "2024-12-31" };
    const r = retrieveForIntents([a, b], msg, dates, undefined, { pin: false });
    const runs = [a, b].map((intent) => retrieve({ query: `${INTENT_QUERY_HINTS[intent]} ${msg}`, dates, topK: 5 }).results);

    // Each clause appears once, carrying the best (highest RRF) of its per-run hits.
    const bestRrf = new Map<string, number>();
    for (const run of runs) for (const h of run) bestRrf.set(h.key, Math.max(bestRrf.get(h.key) ?? 0, h.scores.rrf));
    for (const h of r.results) expect(h.scores.rrf, h.key).toBe(bestRrf.get(h.key));

    // Each run's top hit is guaranteed a slot and sorts first; everything else by RRF, ties by key.
    const tops = new Set(runs.map((run) => run[0].key));
    const byRrf = (x: { key: string }, y: { key: string }) => bestRrf.get(y.key)! - bestRrf.get(x.key)! || x.key.localeCompare(y.key);
    const rest = [...bestRrf.keys()].filter((k) => !tops.has(k)).map((key) => ({ key })).sort(byRrf);
    const expected = [...[...tops].map((key) => ({ key })).sort(byRrf), ...rest].slice(0, AGENT.retrieval.topK + 1).map((x) => x.key);
    expect(bestRrf.size).toBeGreaterThan(AGENT.retrieval.topK + 1);
    expect(r.results.map((h) => h.key)).toEqual(expected);
    expect(r.results.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6]);

    // These cases really exercise both rules: a clause hit by both runs with different scores,
    // and a pure RRF sort that would put some other clause above a run's top hit.
    expect(runs[0].some((h) => runs[1].some((g) => g.key === h.key && g.scores.rrf !== h.scores.rrf))).toBe(true);
    const pureRrf = [...bestRrf.keys()].map((key) => ({ key })).sort(byRrf).slice(0, AGENT.retrieval.topK + 1).map((x) => x.key);
    expect(pureRrf).not.toEqual(expected);
  });

  it("reports the temporal filter's removals and stops pinning before the first policy version", () => {
    // No intent family -> no pins; a claim date before 2024 leaves no candidates at all.
    const early = retrieveForIntents(["other"], "where is my refund", { claimDate: "2023-06-01" });
    expect(early.results).toEqual([]);
    expect(early.removedCount).toBe(126);
    expect(early.pinnedCount).toBe(0);
    expect(retrieve({ query: "refund", dates: { claimDate: "2023-06-01" } }).candidates).toBe(0);
    // Pinning asks rules.json for the governing version, which (like the gate) has none before 2024.
    expect(() => retrieveForIntents(["return_request"], "send it back", { claimDate: "2026-10-16", orderDate: "2023-12-31" })).toThrow(
      "No RETURNS_STANDARD policy in effect on 2023-12-31",
    );
  });

  it("ablation options: naive retrieval without pins can surface stale clauses; pin:false pins nothing", () => {
    const msg = "how many days is the return window after the order date";
    const dates = { claimDate: "2026-10-16", orderDate: "2025-06-01" };
    const ablated = retrieveForIntents(["return_request"], msg, dates, undefined, { naive: true, pin: false });
    expect(ablated.pinnedCount).toBe(0);
    expect(ablated.results.some((x) => x.pinned)).toBe(false);
    expect(ablated.results.some((x) => !x.inEffect)).toBe(true);
    expect(ablated.results.length).toBeLessThanOrEqual(AGENT.retrieval.topK);

    const unpinned = retrieveForIntents(["return_request"], msg, dates, undefined, { pin: false });
    expect(unpinned.pinnedCount).toBe(0);
    expect(unpinned.results.every((x) => x.inEffect)).toBe(true);

    // Defaults (no opts) are temporal + pinned.
    const full = retrieveForIntents(["return_request"], msg, dates);
    for (const id of ["§1.4", "§1.5", "§1.6"]) expect(full.results.map((x) => x.key)).toContain(`${id}@2025.1`);
    expect(full.results.every((x) => x.inEffect)).toBe(true);
  });

  it("does not duplicate pins when an intent is repeated", () => {
    const dates = { claimDate: "2026-10-16", orderDate: "2026-10-01" };
    const once = retrieveForIntents(["lost_package"], "no tracking update for weeks", dates);
    const twice = retrieveForIntents(["lost_package", "lost_package"], "no tracking update for weeks", dates);
    const k2 = twice.results.map((x) => x.key);
    expect(new Set(k2).size).toBe(k2.length);
    for (const id of ["§3.2", "§3.3", "§3.4"]) expect(k2).toContain(`${id}@2026.1`);
    // Identical runs merge to the same list, so repeating the intent changes nothing.
    expect(k2).toEqual(once.results.map((x) => x.key));
    expect(twice.pinnedCount).toBe(once.pinnedCount);
  });
});

// ------------------------------------------------------------------------------------ embedding path (mocked index)

describe("retrieve() with model embeddings (mocked index files)", () => {
  afterEach(() => {
    vi.doUnmock("@data/index/embeddings.json");
    vi.doUnmock("@data/index/query-embeddings.json");
    vi.resetModules();
  });

  async function loadWithEmbeddings(
    opts: { omitKey?: string; cachedQuery?: string; queryModel?: string; vectorFor?: (key: string) => number[] } = {},
  ) {
    vi.resetModules();
    const corpusJson = (await import("@data/index/corpus.json")).default as unknown as { clauses: Clause[] };
    const vectors: Record<string, number[]> = {};
    for (const c of corpusJson.clauses) {
      if (c.key === opts.omitKey) continue;
      // By default §2.1@2026.1 points along axis 0, everything else along axis 1.
      vectors[c.key] = opts.vectorFor ? opts.vectorFor(c.key) : c.key === "§2.1@2026.1" ? [1, 0, 0, 0] : [0, 1, 0, 0];
    }
    vi.doMock("@data/index/embeddings.json", () => ({ default: { model: "test-embed", dimensions: 4, builtAt: null, vectors } }));
    const corpusMod = await import("@/lib/rag/corpus");
    const qVectors: Record<string, number[]> = {};
    if (opts.cachedQuery) qVectors[corpusMod.queryKey(opts.cachedQuery)] = [1, 0, 0, 0];
    vi.doMock("@data/index/query-embeddings.json", () => ({ default: { model: opts.queryModel ?? "test-embed", dimensions: 4, vectors: qVectors } }));
    vi.resetModules();
    return {
      retriever: await import("@/lib/rag/retriever"),
      corpus: await import("@/lib/rag/corpus"),
    };
  }

  it("uses the model vectors for the dense list when every candidate has one", async () => {
    const { retriever, corpus } = await loadWithEmbeddings();
    expect(corpus.embeddingModel()).toBe("test-embed");
    expect(corpus.corpusMeta().embeddedClauses).toBe(126);
    const r = retriever.retrieve({ query: "zzzz unrelated words", dates: { claimDate: "2026-10-16" }, mode: "dense", queryEmbedding: [1, 0, 0, 0] });
    expect(r.denseMode).toBe("embedding");
    expect(r.results[0].key).toBe("§2.1@2026.1");
    expect(r.results[0].scores.dense).toBe(1);
    expect(r.results[0].scores.denseRank).toBe(1);
    // Everything else is orthogonal (cosine 0) -> ties broken by key.
    expect(r.results[1].scores.dense).toBe(0);
  });

  it("falls back to lexical vectors when any temporal candidate lacks an embedding", async () => {
    const { retriever } = await loadWithEmbeddings({ omitKey: "§1.1@2026.1" });
    const r = retriever.retrieve({ query: "charged twice", dates: { claimDate: "2026-10-16" }, queryEmbedding: [1, 0, 0, 0] });
    expect(r.denseMode).toBe("lexical-fallback");
    // §1.1@2026.1 is one of the 42 in-effect candidates, so one missing vector forces the fallback.
    expect(r.candidates).toBe(42);
    // A missing vector on a clause the temporal filter removed does not matter.
    const { retriever: r2 } = await loadWithEmbeddings({ omitKey: "§1.1@2024.1" });
    expect(r2.retrieve({ query: "charged twice", dates: { claimDate: "2026-10-16" }, queryEmbedding: [1, 0, 0, 0] }).denseMode).toBe("embedding");
  });

  it("uses a cached query embedding keyed by the normalised query", async () => {
    const q = "Where is my duplicate charge refund?";
    const { retriever, corpus } = await loadWithEmbeddings({ cachedQuery: q });
    expect(corpus.cachedQueryEmbedding(`  ${q.toUpperCase()}  `)).toEqual([1, 0, 0, 0]);
    const r = retriever.retrieve({ query: q, dates: { claimDate: "2026-10-16" }, mode: "dense" });
    expect(r.denseMode).toBe("embedding");
    expect(r.results[0].key).toBe("§2.1@2026.1");
  });

  it("the dense floor is inclusive: cosine exactly 0.35 survives without any lexical match", async () => {
    // [7, 18, 5, 1, 1] has norm exactly 20, so its cosine with the unit query axis is 7 / 20 = 0.35 exactly.
    const { retriever } = await loadWithEmbeddings({
      vectorFor: (key) => (key === "§6.3@2026.1" ? [7, 18, 5, 1, 1] : key === "§6.1@2026.1" ? [6.9, 18, 5, 1, 1] : [0, 1, 0, 0, 0]),
    });
    const r = retriever.retrieve({ query: "zzzz qqqq xylophone", dates: { claimDate: "2026-10-16" }, queryEmbedding: [1, 0, 0, 0, 0] });
    expect(r.denseMode).toBe("embedding");
    expect(r.results.map((h) => [h.key, h.scores.bm25, h.scores.dense])).toEqual([["§6.3@2026.1", 0, 0.35]]);
  });

  it("ignores cached query vectors made with a different model than the clause vectors", async () => {
    const q = "Where is my duplicate charge refund?";
    const { retriever, corpus } = await loadWithEmbeddings({ cachedQuery: q, queryModel: "older-embed" });
    expect(corpus.embeddingModel()).toBe("test-embed");
    expect(corpus.cachedQueryEmbedding(q)).toBeNull();
    expect(retriever.retrieve({ query: q, dates: { claimDate: "2026-10-16" }, mode: "dense" }).denseMode).toBe("lexical-fallback");
  });

  it("retrieveForIntents passes each intent's query vector through and reports embedding only when every run had one", async () => {
    const { retriever } = await loadWithEmbeddings();
    const msg = "I see two charges";
    const dates = { claimDate: "2026-10-16", orderDate: "2026-10-01" };
    const qCharge = `${retriever.INTENT_QUERY_HINTS.double_charge} ${msg}`;
    const qLate = `${retriever.INTENT_QUERY_HINTS.late_delivery} ${msg}`;

    const both = retriever.retrieveForIntents(["double_charge", "late_delivery"], msg, dates, { [qCharge]: [1, 0, 0, 0], [qLate]: [0, 0, 1, 0] });
    expect(both.denseMode).toBe("embedding");
    // The double-charge vector points at §2.1@2026.1 only, so it is that run's dense #1 with cosine 1.
    const billing = both.results.find((h) => h.key === "§2.1@2026.1")!;
    expect(billing.scores.dense).toBe(1);
    expect(billing.scores.denseRank).toBe(1);

    const oneMissing = retriever.retrieveForIntents(["double_charge", "late_delivery"], msg, dates, { [qCharge]: [1, 0, 0, 0], [qLate]: null });
    expect(oneMissing.denseMode).toBe("lexical-fallback");
    expect(retriever.retrieveForIntents(["double_charge"], msg, dates).denseMode).toBe("lexical-fallback");
  });
});
