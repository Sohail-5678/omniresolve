/**
 * Okapi BM25 (k1 = 1.2, b = 0.75 by default) over pre-tokenized documents.
 * IDF uses the Lucene form ln(1 + (N - df + 0.5) / (df + 0.5)), which is never negative.
 * Built per query over the temporally filtered clauses (~40 docs), so it costs ~1 ms.
 */

export type Bm25Doc = { id: string; tokens: string[] };
export type RankedHit = { id: string; score: number; rank: number };

export class Bm25Index {
  private readonly tf = new Map<string, Map<string, number>>();
  private readonly df = new Map<string, number>();
  private readonly len = new Map<string, number>();
  private readonly avgdl: number;
  readonly size: number;

  constructor(
    docs: Bm25Doc[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.size = docs.length;
    let total = 0;
    for (const d of docs) {
      const counts = new Map<string, number>();
      for (const t of d.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.set(d.id, counts);
      this.len.set(d.id, d.tokens.length);
      total += d.tokens.length;
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = docs.length ? total / docs.length : 0;
  }

  idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
  }

  score(queryTokens: string[], docId: string): number {
    const counts = this.tf.get(docId);
    if (!counts) return 0;
    const dl = this.len.get(docId) ?? 0;
    let s = 0;
    for (const term of new Set(queryTokens)) {
      const f = counts.get(term) ?? 0;
      if (!f) continue;
      const denom = f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1));
      s += this.idf(term) * ((f * (this.k1 + 1)) / denom);
    }
    return s;
  }

  /** All documents ranked by score (desc), ties broken by id for determinism. Rank starts at 1. */
  rank(queryTokens: string[]): RankedHit[] {
    const hits = [...this.tf.keys()].map((id) => ({ id, score: this.score(queryTokens, id) }));
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.map((h, i) => ({ ...h, rank: i + 1 }));
  }
}
