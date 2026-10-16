/**
 * The policy corpus as the running app sees it: clauses parsed at build time
 * (data/index/corpus.json), their precomputed embeddings, and cached query embeddings
 * for the recorded demo queries. Imported statically so serverless bundles include them.
 */
import corpusJson from "@data/index/corpus.json";
import embeddingsJson from "@data/index/embeddings.json";
import queryEmbeddingsJson from "@data/index/query-embeddings.json";
import type { Clause } from "@/lib/policy/clauses";
import { sha256Hex } from "@/lib/util/canonical";
import { tokenize } from "./tokenize";
import { lexicalVector } from "./dense";

type CorpusFile = { builtAt: string | null; source: string; clauses: Clause[] };
type EmbeddingsFile = { model: string | null; dimensions: number; builtAt: string | null; vectors: Record<string, number[]> };
type QueryEmbeddingsFile = { model: string | null; dimensions: number; vectors: Record<string, number[]> };

const corpus = corpusJson as unknown as CorpusFile;
const embeddings = embeddingsJson as unknown as EmbeddingsFile;
const queryEmbeddings = queryEmbeddingsJson as unknown as QueryEmbeddingsFile;

export type IndexedClause = Clause & { tokens: string[]; lexical: number[]; embedding: number[] | null };

let indexed: IndexedClause[] | null = null;

export function getCorpus(): IndexedClause[] {
  if (!indexed) {
    indexed = corpus.clauses.map((c) => {
      const text = `${c.title}. ${c.text}`;
      return { ...c, tokens: tokenize(text), lexical: lexicalVector(text), embedding: embeddings.vectors[c.key] ?? null };
    });
  }
  return indexed;
}

export function corpusMeta() {
  return {
    builtAt: corpus.builtAt,
    clauses: corpus.clauses.length,
    embeddingModel: embeddings.model,
    embeddingDims: embeddings.dimensions,
    embeddedClauses: Object.keys(embeddings.vectors).length,
  };
}

export function queryKey(query: string): string {
  return sha256Hex(query.trim().replace(/\s+/g, " ").toLowerCase());
}

export function cachedQueryEmbedding(query: string): number[] | null {
  if (!embeddings.model || queryEmbeddings.model !== embeddings.model) return null;
  return queryEmbeddings.vectors[queryKey(query)] ?? null;
}

export function embeddingModel(): string | null {
  return embeddings.model;
}

export function findClause(key: string): IndexedClause | undefined {
  return getCorpus().find((c) => c.key === key);
}
