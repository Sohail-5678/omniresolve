/**
 * Scenario evals (spec 9.1) — the headline results. Each of the 60 scenarios runs k times
 * against the live graph in a fresh sandbox (fixtures + faults). A simulated customer answers
 * when the agent asks; a code supervisor answers approval cards per the scenario. Success is
 * judged on the FINAL DATABASE STATE versus the oracle (reference plan through the real gate
 * and saga), not on reply text. Progress is checkpointed so a run can resume after rate limits.
 *
 * Usage:
 *   npx tsx scripts/eval-scenarios.ts [--k 3] [--limit 60] [--only ev-001,ev-002]
 *        [--ablation noGate|noTemporal|noVerifier|smallPlanner] [--subset 20]
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { randomUUID } from "node:crypto";
import { getDb, getPool } from "@/db/client";
import * as s from "@/db/schema";
import { runTurn, resumeTurn, type TurnResult } from "@/lib/agent/runner";
import { LiveProvider, serverKeys } from "@/lib/llm/provider";
import { SMALL_PLANNER, NODE_MODELS } from "@/config/models";
import { runOracle, prepareSandbox, snapshotFinalState, sameFinalState, type EvalScenario, type OracleResult, type FinalState } from "@/lib/evals/oracle";
import { simulateCustomerTurn } from "@/lib/evals/simulator";
import { bootstrapCI, mean, percentile, rate, round } from "@/lib/evals/stats";
import type { AgentEvent, Ablation } from "@/lib/agent/deps";
import type { ApprovalCard, HitlDecision } from "@/lib/agent/state";
import { Checkpoint, readJsonl, writeResult } from "./lib/results";

type RunRow = {
  key: string;
  scenarioId: string;
  category: string;
  run: number;
  success: boolean;
  finalState: FinalState;
  expected: FinalState;
  escalatedAgent: boolean;
  escalatedOracle: boolean;
  decisions: { action: string; status: string }[];
  oracleDecisions: { type: string; status: string }[];
  decisionMatch: boolean;
  cited: string[];
  citationOk: boolean;
  trajectory: string[];
  trajectoryMatch: boolean;
  sagaSteps: string[];
  turns: number;
  asked: boolean;
  usedTemplate: boolean;
  verified: boolean;
  llmCalls: number;
  tokens: number;
  costUsd: number;
  turnMs: number[];
  failure: string | null;
  escalationCodes: string[];
  intents: string[];
  error?: string;
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const CATEGORY_INTENTS: Record<string, string[]> = {
  damaged: ["damaged_item"],
  double_charge: ["double_charge"],
  late_lost: ["late_delivery", "lost_package"],
  return_window: ["return_request"],
  vip_churn: ["vip_churn"],
};

function supervisor(sc: EvalScenario, card: ApprovalCard): HitlDecision {
  const live = card.decisions.filter((d) => d.status === "NEEDS_HUMAN" || d.status === "AUTO_APPROVED");
  const remove = (sc.supervisorPolicy.removeTypes ?? []).flatMap((t) => live.filter((d) => d.action.type === t).map((d) => d.index));
  return { decision: sc.supervisorPolicy.action, amountCents: sc.supervisorPolicy.action === "modify" ? sc.supervisorPolicy.amountCents : undefined, removeActions: remove.length ? remove : undefined, note: "simulated supervisor" };
}

async function runScenario(sc: EvalScenario, run: number, oracle: OracleResult, ablation: Ablation, smallPlanner: boolean): Promise<RunRow> {
  const db = getDb();
  const sandboxId = await prepareSandbox(db, sc, { faults: true });
  const threadId = `thr_ev_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  await db.insert(s.threads).values({ id: threadId, sandboxId, customerId: sc.customerId, scenarioId: sc.id, status: "ACTIVE", title: sc.title, mode: "live", evidenceAttached: sc.evidenceAttached });
  const llm = new LiveProvider(serverKeys(), { maxQuotaWaitMs: 65_000, quotaWaitBudgetMs: 240_000, overrides: smallPlanner ? { planner: SMALL_PLANNER } : undefined });
  const budgetLimits = { maxLlmCalls: 8, maxRepairs: 2, maxWallMs: 400_000, maxOutputTokens: 6_000 };
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => events.push(e);
  const transcript: { role: "customer" | "agent"; text: string }[] = [];
  let message = sc.openingMessage;
  let turns = 0;
  let escalatedAgent = false;
  let asked = false;
  let last: TurnResult | null = null;
  const turnMs: number[] = [];
  let llmCalls = 0;
  let tokens = 0;
  let cost = 0;
  let simulatorFailed = false;
  const count = (r: TurnResult) => {
    llmCalls += r.usage.llmCalls;
    tokens += r.usage.inputTokens + r.usage.outputTokens;
    cost += r.usage.costUsd;
    turnMs.push(r.usage.elapsedMs);
  };
  try {
    while (turns < sc.maxTurns) {
      turns++;
      transcript.push({ role: "customer", text: message });
      let r = await runTurn({ db, sandboxId, threadId, customerId: sc.customerId, message, mode: "live", llm, evidenceAttached: sc.evidenceAttached, emit, sagaHooks: { sleep: async () => undefined, random: () => 0.5 }, ablation, budgetLimits });
      count(r);
      if (r.status === "AWAITING_APPROVAL" && r.approval) {
        escalatedAgent = true;
        r = await resumeTurn({ db, sandboxId, threadId, mode: "live", llm, interruptId: r.approval.interruptId, decision: supervisor(sc, r.approval.card), emit, sagaHooks: { sleep: async () => undefined, random: () => 0.5 }, ablation, budgetLimits });
        count(r);
      }
      last = r;
      if (r.reply) transcript.push({ role: "agent", text: r.reply.text });
      if (r.status === "ASKED") {
        asked = true;
        const sim = await simulateCustomerTurn(llm, sc, transcript);
        if (!sim.value) {
          simulatorFailed = true;
          break;
        }
        message = sim.value.message;
        continue;
      }
      break;
    }
  } catch (err) {
    last = null;
    events.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  const finalState = await snapshotFinalState(db, sandboxId, sc.customerId);
  const success = sameFinalState(finalState, oracle.finalState);
  const gateEvents = events.filter((e): e is Extract<AgentEvent, { type: "node_end" }> => e.type === "node_end" && e.node === "n4b_gate");
  const lastGate = gateEvents[gateEvents.length - 1]?.summary as { decisions?: { action: string; status: string }[] } | undefined;
  const planEvents = events.filter((e): e is Extract<AgentEvent, { type: "node_end" }> => e.type === "node_end" && e.node === "n4a_plan");
  const cited = ((planEvents[planEvents.length - 1]?.summary as { cited?: string[] } | undefined)?.cited ?? []) as string[];
  const triageEvents = events.filter((e): e is Extract<AgentEvent, { type: "node_end" }> => e.type === "node_end" && e.node === "n1_triage");
  const intents = ((triageEvents[triageEvents.length - 1]?.summary as { intents?: string[] } | undefined)?.intents ?? []) as string[];
  const decisions = (lastGate?.decisions ?? []).filter((d) => ["refund", "store_credit", "replacement", "return_label", "escalate"].includes(d.action));
  const oracleDecisions = oracle.decisions.filter((d) => ["refund", "store_credit", "replacement", "return_label", "escalate"].includes(d.type));
  const key = (xs: { a: string; s: string }[]) => xs.map((x) => `${x.a}:${x.s}`).sort().join("|");
  const decisionMatch = key(decisions.map((d) => ({ a: d.action, s: d.status === "NEEDS_HUMAN" ? "HUMAN" : d.status }))) === key(oracleDecisions.map((d) => ({ a: d.type, s: d.status === "NEEDS_HUMAN" ? "HUMAN" : d.status })));
  const trajectory = events.filter((e): e is Extract<AgentEvent, { type: "node_end" }> => e.type === "node_end").map((e) => e.node);
  const sagaSteps = events.filter((e) => e.type === "saga_step" && (e as { status: string }).status === "DONE").map((e) => (e as { name: string }).name);
  const routeOf = (t: string[]) => (t.includes("n5_hitl") ? "human" : t.includes("n6_execute") ? "auto" : "deny");
  const trajectoryMatch = routeOf(trajectory) === oracle.route && [...new Set(sagaSteps)].sort().join() === [...new Set(oracle.sagaSteps)].sort().join();
  const citationOk = sc.goldClauseIds.length === 0 || cited.some((c) => sc.goldClauseIds.includes(c));
  const escalationCodes = events.filter((e): e is Extract<AgentEvent, { type: "node_end" }> => e.type === "node_end").map((e) => (e.summary as { escalation?: string }).escalation).filter((x): x is string => !!x);
  const reply = last?.reply;

  let failure: string | null = null;
  if (!success) {
    const expectedIntents = CATEGORY_INTENTS[sc.category];
    if (!last) failure = "runner_error";
    else if (escalationCodes.some((c) => ["LLM_UNAVAILABLE", "BUDGET_EXCEEDED", "QUOTA"].includes(c))) failure = "llm_unavailable";
    else if (simulatorFailed) failure = "simulator_error";
    else if (expectedIntents && !intents.some((i) => expectedIntents.includes(i))) failure = "wrong_intent";
    else if (asked && sc.category !== "missing_info") failure = "missed_info";
    else if (sc.category === "missing_info" && last.status === "ASKED") failure = "missed_info";
    else if (!citationOk) failure = "wrong_policy";
    else if (escalatedAgent !== oracle.needsHuman) failure = "escalation_mismatch";
    else if (!decisionMatch) failure = "bad_plan";
    else if ((last.saga?.status ?? null) !== oracle.sagaStatus) failure = "saga_error";
    else failure = "other";
  }
  return {
    key: `${sc.id}#${run}`,
    scenarioId: sc.id,
    category: sc.category,
    run,
    success,
    finalState,
    expected: oracle.finalState,
    escalatedAgent,
    escalatedOracle: oracle.needsHuman,
    decisions,
    oracleDecisions,
    decisionMatch,
    cited,
    citationOk,
    trajectory,
    trajectoryMatch,
    sagaSteps,
    turns,
    asked,
    usedTemplate: reply?.usedTemplate ?? false,
    verified: reply?.verified ?? false,
    llmCalls,
    tokens,
    costUsd: round(cost, 6),
    turnMs,
    failure,
    escalationCodes,
    intents,
  };
}

async function main() {
  const k = Number(arg("k") ?? 3);
  const ablationName = arg("ablation");
  const subset = arg("subset") ? Number(arg("subset")) : undefined;
  const only = arg("only")?.split(",");
  const ablation: Ablation = ablationName === "noGate" ? { noGate: true } : ablationName === "noTemporal" ? { noTemporal: true } : ablationName === "noVerifier" ? { noVerifier: true } : {};
  const smallPlanner = ablationName === "smallPlanner";
  const name = ablationName ? `ablation-${ablationName}` : "scenarios";
  let scenarios = readJsonl<EvalScenario>("data/datasets/eval-set.jsonl");
  if (only) scenarios = scenarios.filter((x) => only.includes(x.id));
  if (subset) {
    // Deterministic stratified subset: every n-th scenario per category.
    const byCat = new Map<string, EvalScenario[]>();
    for (const x of scenarios) byCat.set(x.category, [...(byCat.get(x.category) ?? []), x]);
    const per = Math.max(1, Math.round(subset / byCat.size));
    scenarios = [...byCat.values()].flatMap((xs) => xs.slice(0, per)).slice(0, subset);
  }
  const limit = arg("limit") ? Number(arg("limit")) : scenarios.length;
  scenarios = scenarios.slice(0, limit);

  const oracleCp = new Checkpoint<{ key: string; oracle: OracleResult }>("oracle");
  const runs = new Checkpoint<RunRow>(name);
  const db = getDb();
  for (const sc of scenarios) {
    if (!oracleCp.has(sc.id)) oracleCp.add({ key: sc.id, oracle: await runOracle(db, sc) });
  }
  console.log(`oracle ready for ${scenarios.length} scenarios; running k=${k}${ablationName ? ` (ablation: ${ablationName})` : ""}`);
  for (let run = 1; run <= k; run++) {
    for (const sc of scenarios) {
      const key = `${sc.id}#${run}`;
      if (runs.has(key)) continue;
      const t0 = Date.now();
      const row = await runScenario(sc, run, oracleCp.done.get(sc.id)!.oracle, ablation, smallPlanner);
      runs.add(row);
      console.log(`${row.success ? "✓" : "✗"} ${key.padEnd(10)} ${sc.category.padEnd(18)} ${row.failure ?? ""} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  const rows = runs.all().filter((r) => scenarios.some((x) => x.id === r.scenarioId) && r.run <= k);
  const byScenario = new Map<string, RunRow[]>();
  for (const r of rows) byScenario.set(r.scenarioId, [...(byScenario.get(r.scenarioId) ?? []), r]);
  const passK: number[] = [...byScenario.values()].map((xs) => (xs.length >= k && xs.every((x) => x.success) ? 1 : 0));
  const success: number[] = rows.map((r) => (r.success ? 1 : 0));
  const tp = rows.filter((r) => r.escalatedAgent && r.escalatedOracle).length;
  const fp = rows.filter((r) => r.escalatedAgent && !r.escalatedOracle).length;
  const fn = rows.filter((r) => !r.escalatedAgent && r.escalatedOracle).length;
  const cats = [...new Set(rows.map((r) => r.category))];
  const failures = rows.filter((r) => r.failure).reduce<Record<string, number>>((m, r) => ({ ...m, [r.failure!]: (m[r.failure!] ?? 0) + 1 }), {});
  const allTurnMs = rows.flatMap((r) => r.turnMs);
  const models = smallPlanner ? [...new Set([...SMALL_PLANNER.map((m) => m.model), NODE_MODELS.triage[0].model, NODE_MODELS.responder[0].model, NODE_MODELS.simulator[0].model])] : [...new Set(Object.values(NODE_MODELS).map((c) => c[0].model))];

  writeResult({
    name,
    title: ablationName ? `Ablation: ${ablationName}` : "Scenario evals (final-state, pass^k)",
    dataset: `data/datasets/eval-set.jsonl (${scenarios.length} scenarios${subset ? `, stratified subset of ${subset}` : ""})`,
    n: rows.length,
    models,
    config: { k, ablation: ablationName ?? "none", supervisor: "code (scenario supervisorPolicy)", simulator: NODE_MODELS.simulator[0].model, judge: "final DB state vs oracle (reference plan through real gate + saga)" },
    metrics: {
      scenarios: byScenario.size,
      runs: rows.length,
      taskSuccess: rate(success.reduce((a, b) => a + b, 0), success.length),
      taskSuccessCI: bootstrapCI(success),
      passK: rate(passK.reduce((a, b) => a + b, 0), passK.length),
      passKCI: bootstrapCI(passK),
      decisionAccuracy: rate(rows.filter((r) => r.decisionMatch).length, rows.length),
      escalationPrecision: tp + fp ? round(tp / (tp + fp)) : null,
      escalationRecall: tp + fn ? round(tp / (tp + fn)) : null,
      trajectoryMatch: rate(rows.filter((r) => r.trajectoryMatch).length, rows.length),
      citationAccuracy: rate(rows.filter((r) => r.citationOk).length, rows.length),
      verifierTemplateFallbackRate: rate(rows.filter((r) => r.usedTemplate).length, rows.length),
      unverifiedReplies: rows.filter((r) => !r.verified).length,
      avgLlmCallsPerResolution: round(mean(rows.map((r) => r.llmCalls)), 2),
      avgTokensPerResolution: Math.round(mean(rows.map((r) => r.tokens))),
      avgCostUsdPerResolution: round(mean(rows.map((r) => r.costUsd)), 5),
      p50TurnMs: percentile(allTurnMs, 50),
      p95TurnMs: percentile(allTurnMs, 95),
      wrongPayouts: rows.filter((r) => !r.success && (r.finalState.refunds.length > r.expected.refunds.length || r.finalState.credits.length > r.expected.credits.length || JSON.stringify(r.finalState.refunds) !== JSON.stringify(r.expected.refunds))).length,
    },
    tables: [
      {
        title: "By category",
        columns: ["category", "runs", "success", "pass^k"],
        rows: cats.map((c) => {
          const xs = rows.filter((r) => r.category === c);
          const scen = [...byScenario.entries()].filter(([, v]) => v[0].category === c);
          return [c, xs.length, rate(xs.filter((x) => x.success).length, xs.length), rate(scen.filter(([, v]) => v.length >= k && v.every((x) => x.success)).length, scen.length)];
        }),
      },
      { title: "Failure taxonomy", columns: ["label", "runs"], rows: Object.entries(failures).sort((a, b) => b[1] - a[1]) },
    ],
    notes: [
      "Success = refunds, store credits, replacements and active return labels in the sandbox exactly match the oracle's final state.",
      "Simulated customers answer only when the agent asks a question; most scenarios resolve in one agent turn plus an optional supervisor step.",
      "Free-tier rate limits were waited out (not counted against latency budgets in this eval); per-turn time includes those waits.",
      "Scenarios were drafted with LLM assistance during the build and machine-checked (schema, fixture consistency, gate oracle); see docs/EVALS.md.",
    ],
    items: rows,
  });
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
