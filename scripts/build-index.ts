/**
 * Builds the retrieval index: parses the clause markdown into data/index/corpus.json and,
 * when GEMINI_API_KEY is set, embeds every clause (and the known demo/eval queries) with
 * the configured Gemini embedding model. Without a key it keeps any existing vectors that
 * still match, otherwise the app uses the labeled lexical fallback.
 * Usage: npx tsx scripts/build-index.ts [--queries-only]
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClauseFile, type Clause } from "@/lib/policy/clauses";
import { EMBEDDING_MODEL } from "@/config/models";
import { geminiEmbed } from "@/lib/llm/gemini";
import { sha256Hex } from "@/lib/util/canonical";

const root = process.cwd();
const clauseDir = join(root, "data/policies/clauses");
const corpusPath = join(root, "data/index/corpus.json");
const embPath = join(root, "data/index/embeddings.json");
const qPath = join(root, "data/index/query-embeddings.json");
const qLogPath = join(root, "data/index/query-log.json");

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

const queryKey = (q: string) => sha256Hex(q.trim().replace(/\s+/g, " ").toLowerCase());

async function main() {
  const queriesOnly = process.argv.includes("--queries-only");
  const clauses: Clause[] = [];
  for (const f of readdirSync(clauseDir).filter((x) => /^v\d{4}\.\d+\.md$/.test(x)).sort()) {
    clauses.push(...parseClauseFile(readFileSync(join(clauseDir, f), "utf8")));
  }
  const corpus = { builtAt: new Date().toISOString().slice(0, 10), source: "data/policies/clauses", clauses };
  if (!queriesOnly) {
    writeFileSync(corpusPath, JSON.stringify(corpus, null, 1) + "\n");
    console.log(`[index] corpus.json: ${clauses.length} clauses`);
  }

  const key = process.env.GEMINI_API_KEY;
  const existing = readJson<{ model: string | null; dimensions: number; builtAt: string | null; vectors: Record<string, number[]>; textHash?: Record<string, string> }>(
    embPath,
    { model: null, dimensions: 0, builtAt: null, vectors: {} },
  );
  const textHash = Object.fromEntries(clauses.map((c) => [c.key, sha256Hex(`${c.title}. ${c.text}`)]));

  if (key && !queriesOnly) {
    const stale = clauses.filter((c) => existing.model !== EMBEDDING_MODEL.model || existing.textHash?.[c.key] !== textHash[c.key] || !existing.vectors[c.key]);
    if (stale.length) {
      const vectors = await geminiEmbed(key, stale.map((c) => `${c.title}. ${c.text}`), "RETRIEVAL_DOCUMENT");
      stale.forEach((c, i) => (existing.vectors[c.key] = vectors[i]));
      console.log(`[index] embedded ${stale.length} clause(s) with ${EMBEDDING_MODEL.model}`);
    } else {
      console.log("[index] clause embeddings already current");
    }
    for (const k of Object.keys(existing.vectors)) if (!textHash[k]) delete existing.vectors[k];
    writeFileSync(
      embPath,
      JSON.stringify({ model: EMBEDDING_MODEL.model, dimensions: EMBEDDING_MODEL.dimensions, builtAt: corpus.builtAt, textHash, vectors: existing.vectors }) + "\n",
    );
  } else if (!key) {
    const allMatch = existing.model && clauses.every((c) => existing.textHash?.[c.key] === textHash[c.key] && existing.vectors[c.key]);
    if (!allMatch) {
      writeFileSync(embPath, JSON.stringify({ model: null, dimensions: 0, builtAt: null, vectors: {} }) + "\n");
      console.log("[index] no GEMINI_API_KEY and no current vectors — dense retrieval will use the labeled lexical fallback");
    } else {
      console.log("[index] no GEMINI_API_KEY; existing clause vectors still match the text");
    }
  }

  // Query embeddings for recorded demo turns and the retrieval eval set.
  if (key) {
    const queries = new Set<string>(readJson<string[]>(qLogPath, []));
    const evalPath = join(root, "data/datasets/retrieval-queries.jsonl");
    if (existsSync(evalPath)) {
      for (const line of readFileSync(evalPath, "utf8").split("\n").filter(Boolean)) queries.add((JSON.parse(line) as { query: string }).query);
    }
    const q = readJson<{ model: string | null; dimensions: number; vectors: Record<string, number[]> }>(qPath, { model: null, dimensions: 0, vectors: {} });
    if (q.model !== EMBEDDING_MODEL.model) q.vectors = {};
    const missing = [...queries].filter((x) => !q.vectors[queryKey(x)]);
    if (missing.length) {
      const vecs = await geminiEmbed(key, missing, "RETRIEVAL_QUERY");
      missing.forEach((x, i) => (q.vectors[queryKey(x)] = vecs[i]));
    }
    writeFileSync(qPath, JSON.stringify({ model: EMBEDDING_MODEL.model, dimensions: EMBEDDING_MODEL.dimensions, vectors: q.vectors }) + "\n");
    console.log(`[index] query embeddings: ${Object.keys(q.vectors).length} (${missing.length} new)`);
  }
}

main().catch((err) => {
  console.error("[index] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
