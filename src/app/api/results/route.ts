/**
 * GET /api/results — eval result files (data/results/*.json), the source of every number in
 * the UI and README. `?file=name` returns one raw file. Public, read-only.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { json, route } from "@/lib/http";
import { HttpError } from "@/lib/util/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = join(process.cwd(), "data", "results");

export const GET = route(async (req: Request) => {
  const file = new URL(req.url).searchParams.get("file");
  if (file) {
    if (!/^[a-z0-9-]+\.json$/.test(file)) throw new HttpError(400, "Bad file name.");
    try {
      return new Response(await readFile(join(DIR, file), "utf8"), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
    } catch {
      throw new HttpError(404, "No such result file.");
    }
  }
  let names: string[] = [];
  try {
    names = (await readdir(DIR)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  const files = [];
  for (const name of names) {
    try {
      const data = JSON.parse(await readFile(join(DIR, name), "utf8")) as Record<string, unknown>;
      const { items: _items, runs: _runs, ...summary } = data;
      void _items;
      void _runs;
      files.push({ name, ...summary });
    } catch {
      files.push({ name, error: "unreadable" });
    }
  }
  return json({ files }, 200, { "cache-control": "public, max-age=60" });
});
