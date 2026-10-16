/**
 * Merges the reviewed dataset partitions (data/datasets/.parts/*.jsonl) into the five
 * datasets, sorted by id, and reports counts. Run the checker afterwards:
 *   npx tsx scripts/merge-datasets.ts && npx tsx scripts/check-datasets.ts data/datasets/*.jsonl
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "data", "datasets");
const parts = join(dir, ".parts");
const targets = ["retrieval-queries", "redteam-single", "redteam-multi", "benign-tricky", "eval-set"];
for (const t of targets) {
  const files = readdirSync(parts).filter((f) => f.startsWith(`${t}.part`) && f.endsWith(".jsonl")).sort();
  const rows: { id: string; line: string }[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(parts, f), "utf8").split("\n").filter((l) => l.trim())) {
      const obj = JSON.parse(line) as { id: string };
      rows.push({ id: obj.id, line: JSON.stringify(obj) });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const ids = new Set(rows.map((r) => r.id));
  writeFileSync(join(dir, `${t}.jsonl`), rows.map((r) => r.line).join("\n") + "\n");
  console.log(`${t}: ${rows.length} rows from ${files.length} part(s)${ids.size !== rows.length ? ` — ${rows.length - ids.size} DUPLICATE ids` : ""}`);
}
