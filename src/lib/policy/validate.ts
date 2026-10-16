/**
 * Policy consistency check: every number written in a clause must equal the value in
 * rules.json for that version (formatted the same way), bound params must actually appear,
 * and every clause a rule lists must exist. Prose that disagrees with the gate fails CI.
 */
import { parseClauseFile, type Clause } from "./clauses";
import { RULES, formatParamForText, type PolicyVersion } from "./rules";

export type ValidationReport = { errors: string[]; clauses: number; versions: string[] };

export function validatePolicies(filesByVersion: Record<string, string>, rules = RULES): ValidationReport {
  const errors: string[] = [];
  const clausesByVersion = new Map<string, Clause[]>();
  for (const [version, md] of Object.entries(filesByVersion)) {
    try {
      const clauses = parseClauseFile(md);
      if (clauses[0] && clauses[0].version !== version) errors.push(`${version}: front matter says ${clauses[0].version}`);
      clausesByVersion.set(version, clauses);
    } catch (err) {
      errors.push(`${version}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const v of rules.versions) {
    const clauses = clausesByVersion.get(v.version);
    if (!clauses) {
      errors.push(`missing clause file for version ${v.version}`);
      continue;
    }
    for (const c of clauses) {
      if (c.effectiveFrom !== v.effectiveFrom || c.effectiveTo !== v.effectiveTo) {
        errors.push(`${c.key}: effective dates ${c.effectiveFrom}..${c.effectiveTo} differ from rules.json ${v.effectiveFrom}..${v.effectiveTo}`);
      }
    }
  }

  for (const [version, clauses] of clausesByVersion) {
    const seen = new Set<string>();
    for (const c of clauses) {
      if (seen.has(c.clauseId)) errors.push(`${c.key}: duplicate clause id`);
      seen.add(c.clauseId);
      const policy = rules.policies.find((p) => p.policyId === c.policyId && p.version === version) as PolicyVersion | undefined;
      if (!policy) {
        errors.push(`${c.key}: no ${c.policyId} rule for version ${version}`);
        continue;
      }
      if (/\d/.test(c.title)) errors.push(`${c.key}: title contains a digit`);

      let remaining = c.text;
      for (const param of c.binds) {
        if (!(param in policy.params)) {
          errors.push(`${c.key}: binds "${param}" but ${c.policyId} ${version} has no such param`);
          continue;
        }
        const expected = formatParamForText(param, (policy.params as Record<string, unknown>)[param], rules);
        if (!expected.length) errors.push(`${c.key}: param "${param}" has no text format`);
        for (const str of expected) {
          // Whole tokens only: "1" must not match inside "11" or "$100.00".
          const token = new RegExp(`(?<![\\w$.,])${escapeRegExp(str)}(?![\\w]|[.,]\\d)`, "g");
          if (!token.test(remaining)) errors.push(`${c.key}: expected "${str}" (${param}) in text`);
          remaining = remaining.replace(token, " ");
        }
      }
      const stray = remaining.match(/\$?\d[\d,.]*%?/g);
      if (stray) errors.push(`${c.key}: number(s) not backed by rules.json: ${stray.join(", ")}`);
    }

    for (const p of rules.policies.filter((x) => x.version === version)) {
      for (const id of p.clauseIds) {
        const c = clauses.find((x) => x.clauseId === id);
        if (!c) errors.push(`rules ${p.policyId} ${version}: clause ${id} not found`);
        else if (c.policyId !== p.policyId) errors.push(`rules ${p.policyId} ${version}: clause ${id} belongs to ${c.policyId}`);
      }
      const formats = rules.paramFormats;
      for (const param of Object.keys(p.params)) {
        if (!(param in formats)) continue; // booleans/enums are not stated as numbers
        const bound = clauses.some((c) => c.policyId === p.policyId && c.binds.includes(param));
        if (!bound) errors.push(`rules ${p.policyId} ${version}: param "${param}" is not stated in any clause`);
      }
    }
  }

  return {
    errors,
    clauses: [...clausesByVersion.values()].reduce((s, c) => s + c.length, 0),
    versions: [...clausesByVersion.keys()],
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
