/**
 * CI check: clause text numbers == rules.json numbers for every version.
 * Usage: npx tsx scripts/validate-policies.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validatePolicies } from "@/lib/policy/validate";

const dir = join(process.cwd(), "data/policies/clauses");
const files: Record<string, string> = {};
for (const f of readdirSync(dir).filter((x) => /^v\d{4}\.\d+\.md$/.test(x))) {
  files[f.replace(/^v|\.md$/g, "")] = readFileSync(join(dir, f), "utf8");
}
const report = validatePolicies(files);
if (report.errors.length) {
  console.error(`✗ ${report.errors.length} policy consistency error(s):`);
  for (const e of report.errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ ${report.clauses} clauses across ${report.versions.join(", ")} match rules.json`);
