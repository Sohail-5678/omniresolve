/**
 * Records REAL model outputs for demo (replay) mode. Runs every showcase path — and each
 * supervisor choice where a run pauses — against the live provider in a fresh local sandbox,
 * captures every LLM call, and merges them into data/recordings/replay.json. Also logs every
 * retrieval query to data/index/query-log.json so build-index can cache their embeddings.
 * Then replays each path with the ReplayProvider to prove the recordings are complete.
 * Usage: npx tsx scripts/record-replays.ts [--only s1,s3] [--verify-only]
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDb, getPool } from "@/db/client";
import { createSandbox } from "@/lib/security/sandbox";
import { setFault } from "@/lib/services/fault-injector";
import { runTurn, resumeTurn, type TurnResult } from "@/lib/agent/runner";
import { LiveProvider, serverKeys } from "@/lib/llm/provider";
import { RecordingProvider, ReplayProvider } from "@/lib/llm/replay";
import { SCENARIOS, type Scenario, type SupervisorPreset } from "@/lib/scenarios";
import type { HitlDecision } from "@/lib/agent/state";
import type { ReplayEntry } from "@/lib/llm/types";
import * as s from "@/db/schema";

const REPLAY_PATH = "data/recordings/replay.json";
const QUERY_LOG = "data/index/query-log.json";
const instant = { sleep: async () => undefined, random: () => 0.5 };

type Path = { label: string; scenario: Scenario; message: string; customerId: string; preset?: SupervisorPreset; followUp?: string };

function paths(only: string[] | null): Path[] {
  const out: Path[] = [];
  for (const sc of SCENARIOS) {
    if (only && !only.some((o) => sc.id.startsWith(o))) continue;
    if (sc.message) {
      const presets = sc.supervisorPresets?.length ? sc.supervisorPresets : [{ label: "Approve as proposed", decision: { decision: "approve" as const } }, { label: "Reject", decision: { decision: "reject" as const, note: "Not supported by policy." } }];
      for (const preset of presets) out.push({ label: `${sc.id} :: ${preset.label}`, scenario: sc, message: sc.message, customerId: sc.customerId, preset });
    }
    for (const reply of sc.suggestedReplies) {
      if (sc.id !== "free-play") continue;
      out.push({ label: `${sc.id} :: ${reply.slice(0, 40)}`, scenario: sc, message: reply, customerId: sc.customerId, preset: { label: "Approve as proposed", decision: { decision: "approve" } } });
    }
  }
  return out;
}

function decisionFor(preset: SupervisorPreset, result: TurnResult): HitlDecision {
  const d = preset.decision;
  const remove = (d.removeActionsOfType ?? []).flatMap((t) => (result.approval?.card.decisions ?? []).filter((x) => x.action.type === t).map((x) => x.index));
  return { decision: d.decision, note: d.note, amountCents: d.amountCents, removeActions: remove.length ? remove : undefined };
}

async function runPath(p: Path, llm: RecordingProvider | ReplayProvider, mode: "live" | "replay", onQuery?: (q: string) => void) {
  const db = getDb();
  const { id: sandboxId } = await createSandbox(db, { ipHash: "recorder" });
  for (const f of p.scenario.faults) await setFault(db, sandboxId, f.service, f.operation, f.mode, f.n);
  const threadId = `thr_rec${Math.random().toString(36).slice(2, 12)}`;
  await db.insert(s.threads).values({ id: threadId, sandboxId, customerId: p.customerId, scenarioId: p.scenario.id, status: "ACTIVE", title: p.label, mode });
  const first = await runTurn({ db, sandboxId, threadId, customerId: p.customerId, message: p.message, mode, llm, evidenceAttached: p.scenario.evidenceAttached, sagaHooks: instant, onQuery });
  let final = first;
  let hitl: string | null = null;
  if (first.status === "AWAITING_APPROVAL" && first.approval && p.preset) {
    const decision = decisionFor(p.preset, first);
    hitl = decision.decision;
    final = await resumeTurn({ db, sandboxId, threadId, mode, llm, interruptId: first.approval.interruptId, decision, sagaHooks: instant });
  }
  return { first, final, hitl };
}

function brief(r: TurnResult) {
  return `${r.status}${r.outcome ? `/${r.outcome}` : ""}${r.saga ? ` saga=${r.saga.status}` : ""}${r.reply ? ` verified=${r.reply.verified} template=${r.reply.usedTemplate}` : ""}${r.error ? ` error=${r.error.code}` : ""}`;
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only"));
  const only = onlyArg ? (process.argv[process.argv.indexOf(onlyArg) + 1] ?? "").split(",").filter(Boolean) : null;
  const verifyOnly = process.argv.includes("--verify-only");
  const list = paths(only);
  const file = existsSync(REPLAY_PATH) ? (JSON.parse(readFileSync(REPLAY_PATH, "utf8")) as { version: number; recordedWith: string[]; entries: ReplayEntry[] }) : { version: 1, recordedWith: [], entries: [] };
  const queries = new Set<string>(existsSync(QUERY_LOG) ? (JSON.parse(readFileSync(QUERY_LOG, "utf8")) as string[]) : []);

  if (!verifyOnly) {
    const keys = serverKeys();
    if (!keys.groq || (Array.isArray(keys.groq) && !keys.groq.length)) throw new Error("GROQ_API_KEY missing — put it in .env.local");
    const fresh: ReplayEntry[] = [];
    // Identical inputs (e.g. the first turn shared by three supervisor choices) are recorded once.
    const seen = new Map<string, ReplayEntry>();
    for (const p of list) {
      // Scripts can afford to wait out free-tier windows instead of degrading to a fallback model.
      const recorder = new RecordingProvider(new LiveProvider(keys, { maxQuotaWaitMs: 65_000, quotaWaitBudgetMs: 150_000 }), p.scenario.id, seen);
      const r = await runPath(p, recorder, "live", (q) => queries.add(q));
      fresh.push(...recorder.entries);
      console.log(`● ${p.label}\n    first: ${brief(r.first)}${r.hitl ? `\n    after ${r.hitl}: ${brief(r.final)}` : ""}\n    reply: ${(r.final.reply?.text ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
    }
    const freshKeys = new Set(fresh.map((e) => `${e.node}|${e.replayKey}|${e.attempt}`));
    const kept = file.entries.filter((e) => !freshKeys.has(`${e.node}|${e.replayKey}|${e.attempt}`));
    const entries = [...kept, ...fresh];
    const models = [...new Set(entries.map((e) => e.model))].sort();
    writeFileSync(REPLAY_PATH, JSON.stringify({ version: 1, recordedWith: models, entries }, null, 1) + "\n");
    writeFileSync(QUERY_LOG, JSON.stringify([...queries].sort(), null, 1) + "\n");
    console.log(`\nrecorded ${fresh.length} calls (${entries.length} total) with ${models.join(", ")}`);
  }

  // Verify: every path must replay without a miss. (Replay index is loaded at import time,
  // so verification runs in a separate process: npm run record -- --verify-only.)
  if (verifyOnly) {
    let misses = 0;
    for (const p of list) {
      const r = await runPath(p, new ReplayProvider(), "replay");
      const miss = [r.first, r.final].some((x) => x.facts?.outcome === "UNAVAILABLE");
      if (miss) misses++;
      console.log(`${miss ? "✗" : "✓"} ${p.label} → ${brief(r.final)}`);
    }
    console.log(misses ? `\n✗ ${misses} path(s) hit a replay miss` : "\n✓ every recorded path replays");
    if (misses) process.exitCode = 1;
  }
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
