/**
 * Dense similarity. Primary vectors are Gemini embeddings precomputed at build time
 * (data/index/embeddings.json). When no model vector is available for a query, both
 * sides fall back to a local *lexical* vector (hashed word + character-trigram counts),
 * and the result is labeled "lexical-fallback" — it is not a semantic embedding.
 */
import { normalize, tokenize } from "./tokenize";

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function l2normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

const DIMS = 512;

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Lexical fallback vector: stemmed words (weight 1) + character trigrams (weight 0.5). */
export function lexicalVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const t of tokenize(text)) v[hash(`w:${t}`) % DIMS] += 1;
  const norm = normalize(text).replace(/[^a-z0-9]+/g, " ");
  for (const word of norm.split(" ")) {
    const w = ` ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) v[hash(`c:${w.slice(i, i + 3)}`) % DIMS] += 0.5;
  }
  return l2normalize(v);
}

export function rankByCosine(query: ArrayLike<number>, docs: { id: string; vector: ArrayLike<number> }[]) {
  const hits = docs.map((d) => ({ id: d.id, score: cosine(query, d.vector) }));
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.map((h, i) => ({ ...h, rank: i + 1 }));
}
