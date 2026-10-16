/**
 * Writes eval result files (data/results/<name>.json) with the metadata every number needs:
 * date, commit, dataset, N, models and config — plus the per-item raw results.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function gitCommit(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "uncommitted";
  }
}

export type ResultTable = { title: string; columns: string[]; rows: (string | number | null)[][] };

export type ResultFile = {
  name: string;
  title: string;
  dataset: string;
  n: number;
  models: string[];
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  tables?: ResultTable[];
  notes?: string[];
  items?: unknown[];
};

export function writeResult(r: ResultFile) {
  const out = { ...r, date: new Date().toISOString().slice(0, 10), commit: gitCommit(), generatedAt: new Date().toISOString() };
  const path = join(process.cwd(), "data", "results", `${r.name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
  console.log(`\n✓ wrote ${path}`);
  return out;
}

/** Append-only progress log so long LLM evals can resume after a 429 storm or a crash. */
export class Checkpoint<T extends { key: string }> {
  private readonly path: string;
  readonly done = new Map<string, T>();
  constructor(name: string) {
    this.path = join(process.cwd(), "data", "results", ".partial", `${name}.jsonl`);
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as T;
        this.done.set(row.key, row);
      }
    }
  }
  has(key: string) {
    return this.done.has(key);
  }
  add(row: T) {
    this.done.set(row.key, row);
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }
  all(): T[] {
    return [...this.done.values()];
  }
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
