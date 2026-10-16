/**
 * Server-side reader for eval result files (data/results/*.json). Every number the UI shows
 * comes from here, with its N, date and commit — or the UI says the eval has not run.
 */
import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ResultMeta = {
  name: string;
  title?: string;
  date?: string;
  commit?: string;
  dataset?: string;
  n?: number;
  models?: string[];
  metrics?: Record<string, unknown>;
  config?: Record<string, unknown>;
  notes?: string[];
};

export function loadResults(): Record<string, ResultMeta> {
  const dir = join(process.cwd(), "data", "results");
  const out: Record<string, ResultMeta> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as ResultMeta & { items?: unknown; runs?: unknown };
      const { items: _i, runs: _r, ...meta } = data;
      void _i;
      void _r;
      out[name.replace(/\.json$/, "")] = { ...meta, name };
    } catch {
      /* unreadable file: ignored, the UI shows "not run" */
    }
  }
  return out;
}
