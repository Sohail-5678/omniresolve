/**
 * Firewall eval (spec 9.6): detection on the red-team messages and false positives on 100
 * benign-but-tricky messages. Deterministic (no LLM). High false positives send too much to
 * humans; the trade-off is reported, not tuned away.
 * Usage: npx tsx scripts/eval-firewall.ts
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { runFirewall } from "@/lib/security/firewall";
import { getCorpus } from "@/lib/rag/corpus";
import { AGENT } from "@/config/agent";
import { bootstrapCI, rate } from "@/lib/evals/stats";
import { readJsonl, writeResult } from "./lib/results";
import { smuggle } from "./lib/smuggle";

type Msg = { id: string; category?: string; message?: string; turns?: string[]; whyTricky?: string };

function main() {
  const known = new Set(getCorpus().map((c) => c.clauseId));
  const single = readJsonl<Msg>("data/datasets/redteam-single.jsonl");
  const multi = readJsonl<Msg>("data/datasets/redteam-multi.jsonl");
  const benign = readJsonl<Msg>("data/datasets/benign-tricky.jsonl");
  const items: Record<string, unknown>[] = [];
  const attackRows = [
    ...single.map((m) => ({ id: m.id, category: m.category ?? "?", text: smuggle(m.message ?? "") })),
    ...multi.map((m) => ({ id: m.id, category: `multi:${m.category ?? "persona"}`, text: smuggle((m.turns ?? []).join("\n")) })),
  ];
  const attackHits = attackRows.map((a) => {
    const r = runFirewall(a.text, { knownClauseIds: known });
    items.push({ set: "attack", id: a.id, category: a.category, outcome: r.outcome, score: r.score, rules: r.signals.map((x) => x.rule) });
    return r.outcome;
  });
  const benignHits = benign.map((b) => {
    const r = runFirewall(b.message ?? "", { knownClauseIds: known });
    items.push({ set: "benign", id: b.id, outcome: r.outcome, score: r.score, rules: r.signals.map((x) => x.rule), message: b.message });
    return r.outcome;
  });
  const detected = attackHits.map((o) => (o !== "allow" ? 1 : 0));
  const fps = benignHits.map((o) => (o !== "allow" ? 1 : 0));
  const cats = [...new Set(attackRows.map((a) => a.category.replace(/^multi:.*/, "multi-turn")))];
  writeResult({
    name: "firewall",
    title: "Prompt firewall: detection vs false positives",
    dataset: `${single.length} single-turn + ${multi.length} multi-turn attacks; ${benign.length} benign-tricky messages`,
    n: attackRows.length + benign.length,
    models: [],
    config: { flagScore: AGENT.firewall.flagScore, blockScore: AGENT.firewall.blockScore, rules: "instruction override, authority claim/approval, tool-call text, role tags, prompt probe, urgency, fake promises, encoded payloads, hidden Unicode, fake clause IDs" },
    metrics: {
      detectionRate: rate(detected.filter(Boolean).length, detected.length),
      detectionCI: bootstrapCI(detected),
      blockRateOnAttacks: rate(attackHits.filter((o) => o === "block").length, attackHits.length),
      falsePositiveRate: rate(fps.filter(Boolean).length, fps.length),
      falsePositiveCI: bootstrapCI(fps),
      benignBlocked: benignHits.filter((o) => o === "block").length,
    },
    tables: [
      {
        title: "Detection by attack category",
        columns: ["category", "attacks", "flagged or blocked", "blocked"],
        rows: cats.map((c) => {
          const xs = items.filter((i) => i.set === "attack" && String(i.category).replace(/^multi:.*/, "multi-turn") === c);
          return [c, xs.length, rate(xs.filter((x) => x.outcome !== "allow").length, xs.length), rate(xs.filter((x) => x.outcome === "block").length, xs.length)];
        }),
      },
    ],
    notes: [
      "The firewall only routes: a flag forces any money action to a human; a block refuses politely. It is bypassable by design — the approval-token check at the tool boundary is what actually prevents unauthorized changes (see redteam.json).",
    ],
    items,
  });
}

main();
