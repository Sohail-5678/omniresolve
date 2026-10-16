/**
 * Two areas:
 *  (1) structuredCall — the zod-validated LLM call with its bounded repair loop, budget
 *      checks, provider-unavailable propagation and replay-key derivation.
 *  (2) HITL through runTurn/resumeTurn — interrupt persistence, the "busy while awaiting
 *      approval" guard, interrupt-id validation, idempotent concurrent approvals, the
 *      re-gate on a supervisor modification, and cold-start resume on a fresh checkpointer.
 */
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool } from "@/db/client";
import * as s from "@/db/schema";
import { AGENT } from "@/config/agent";
import { structuredCall, replayKeyFor } from "@/lib/agent/structured";
import { TurnBudget, type BudgetLimits } from "@/lib/agent/budget";
import { TriageSchema, planSchema, type Triage } from "@/lib/agent/schemas";
import { ReplayProvider, hasReplay } from "@/lib/llm/replay";
import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse, type ReplayEntry } from "@/lib/llm/types";
import replayJson from "@data/recordings/replay.json";
import { sha256Hex } from "@/lib/util/canonical";
import { runTurn, resumeTurn } from "@/lib/agent/runner";
import { getCheckpointer } from "@/lib/agent/graph";
import type { GraphState } from "@/lib/agent/state";
import { db, freshSandbox, newThread, instant, ScriptedLlm, templateResponder, cite } from "../helpers";

// ---------------------------------------------------------------------------------------
// (1) structuredCall
// ---------------------------------------------------------------------------------------

/**
 * Fake provider that answers from a queue of raw texts (the last one repeats) and keeps a
 * deep copy of every request — structuredCall mutates its conversation array between
 * attempts, so recording by reference would show only the final conversation.
 */
class QueueLlm implements LlmProvider {
  readonly mode = "live" as const;
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly texts: string[],
    private readonly usage = { inputTokens: 120, outputTokens: 40 },
  ) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const text = this.texts[Math.min(this.requests.length - 1, this.texts.length - 1)];
    return { text, provider: "groq", model: "openai/gpt-oss-20b", usage: this.usage, latencyMs: 7, badge: "LIVE" };
  }
}

class ThrowingLlm implements LlmProvider {
  readonly mode = "live" as const;
  calls = 0;
  constructor(private readonly err: unknown) {}
  async complete(): Promise<LlmResponse> {
    this.calls++;
    throw this.err;
  }
}

const VALID_TRIAGE: Triage = {
  intents: ["damaged_item"],
  severity: "medium",
  sentiment: "negative",
  churnRisk: "low",
  orderIdsMentioned: ["ORD-8820"],
  missingInfo: [],
  clarifyingQuestion: null,
  socialEngineeringSignals: [],
  summary: "Pour-over set arrived broken.",
};

const LIMITS: BudgetLimits = { maxLlmCalls: 8, maxRepairs: 2, maxWallMs: 25_000, maxOutputTokens: 6_000 };

function triageCall(provider: LlmProvider, budget = new TurnBudget({ ...LIMITS }), logicalInput: unknown = { message: "My pour-over set ORD-8820 arrived broken." }) {
  return structuredCall({
    provider,
    node: "triage",
    promptVersion: "triage.test",
    system: "You are a triage model. Return JSON.",
    user: "Classify: My pour-over set ORD-8820 arrived broken.",
    logicalInput,
    schema: TriageSchema,
    budget,
  });
}

describe("structuredCall — bounded repair loop", () => {
  it("invalid JSON → repair prompt → valid JSON on the second call (attempts=2)", async () => {
    const garbage = "Sure! The customer has a damaged item, severity medium.";
    const llm = new QueueLlm([garbage, JSON.stringify(VALID_TRIAGE)]);
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(llm, budget);

    expect(res.error).toBeNull();
    expect(res.attempts).toBe(2);
    expect(res.value).toEqual(VALID_TRIAGE);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests.map((r) => r.attempt)).toEqual([0, 1]);
    expect(res.calls.map((c) => c.ok)).toEqual([false, true]);
    expect(res.calls.map((c) => c.attempt)).toEqual([0, 1]);
    expect(res.calls[0].issues).toEqual(["Response was not valid JSON"]);
    expect(res.calls[1].issues).toBeUndefined();

    // The repair turn carries the bad output back plus the validation issues.
    const repair = llm.requests[1].messages;
    expect(repair).toHaveLength(3);
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[1].content).toBe(garbage);
    expect(repair[2].content).toContain("Your JSON did not pass validation:\n- Response was not valid JSON");

    // Each repair has its own replay key derived from the base key and the bad output's hash.
    const baseKey = replayKeyFor("triage", "triage.test", { message: "My pour-over set ORD-8820 arrived broken." });
    expect(llm.requests[0].replayKey).toBe(baseKey);
    expect(llm.requests[1].replayKey).toBe(sha256Hex(`${baseKey}|repair|${sha256Hex(garbage)}`));

    // The repair is counted against the budget — no free calls.
    expect(budget.llmCalls).toBe(2);
    expect(budget.repairs).toBe(1);
    expect(budget.outputTokens).toBe(80);
  });

  it("schema-invalid twice, valid on the third call (3 calls, attempts=3)", async () => {
    const bad1 = JSON.stringify({ ...VALID_TRIAGE, severity: "critical" });
    const bad2 = JSON.stringify({ ...VALID_TRIAGE, orderIdsMentioned: ["8820"] });
    const llm = new QueueLlm([bad1, bad2, "```json\n" + JSON.stringify(VALID_TRIAGE) + "\n```"]);
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(llm, budget);

    expect(res.error).toBeNull();
    expect(res.attempts).toBe(3);
    expect(res.value).toEqual(VALID_TRIAGE);
    expect(llm.requests).toHaveLength(3);
    expect(res.calls).toHaveLength(3);
    expect(res.calls.map((c) => c.ok)).toEqual([false, false, true]);
    expect(res.calls[0].issues).toHaveLength(1);
    expect(res.calls[0].issues![0]).toMatch(/^severity: /);
    expect(res.calls[1].issues).toHaveLength(1);
    expect(res.calls[1].issues![0]).toMatch(/^orderIdsMentioned\.0: /);

    // The third request carries the whole repair history: user, (assistant, user) x 2.
    expect(llm.requests[2].messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(llm.requests[2].messages[3].content).toBe(bad2);
    expect(llm.requests[2].messages[4].content).toContain("- orderIdsMentioned.0: ");
    // Repair keys chain over every bad output so far.
    const baseKey = llm.requests[0].replayKey;
    expect(llm.requests[2].replayKey).toBe(sha256Hex(`${baseKey}|repair|${sha256Hex(bad1)}|${sha256Hex(bad2)}`));
    expect(new Set(llm.requests.map((r) => r.replayKey)).size).toBe(3);
    expect(budget.repairs).toBe(2);
    expect(budget.llmCalls).toBe(3);
  });

  it(`invalid three times → INVALID_AFTER_REPAIRS after exactly ${AGENT.turn.maxRepairs + 1} calls`, async () => {
    const bad = JSON.stringify({ ...VALID_TRIAGE, intents: [] });
    const llm = new QueueLlm([bad]);
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(llm, budget);

    expect(AGENT.turn.maxRepairs).toBe(2);
    expect(res.error).toBe("INVALID_AFTER_REPAIRS");
    expect(res.errorDetail).toBeUndefined();
    expect(res.value).toBeNull();
    expect(res.attempts).toBe(3);
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests.map((r) => r.attempt)).toEqual([0, 1, 2]);
    expect(res.calls).toHaveLength(3);
    expect(res.calls.map((c) => c.ok)).toEqual([false, false, false]);
    expect(res.calls.map((c) => c.issues)).toEqual([0, 1, 2].map(() => [expect.stringMatching(/^intents: /)]));
    // The last request carried two full repair rounds; no fourth call was made.
    expect(llm.requests[2].messages).toHaveLength(5);
    expect(budget.llmCalls).toBe(3);
    expect(budget.repairs).toBe(2);
    expect(budget.outputTokens).toBe(120);
  });

  it("a non-object response fails at (root) and an empty object reports at most 8 issues", async () => {
    const llm = new QueueLlm(["{}", "[]", JSON.stringify(VALID_TRIAGE)]);
    const res = await triageCall(llm);
    expect(res.error).toBeNull();
    expect(res.attempts).toBe(3);
    // `{}` misses all 9 required Triage fields; only the first 8 issues are reported back.
    expect(res.calls[0].issues).toHaveLength(8);
    expect(res.calls[0].issues!.map((i) => i.slice(0, i.indexOf(":")))).toEqual([
      "intents",
      "severity",
      "sentiment",
      "churnRisk",
      "orderIdsMentioned",
      "missingInfo",
      "clarifyingQuestion",
      "socialEngineeringSignals",
    ]);
    expect(llm.requests[1].messages[2].content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(8);
    // `[]` parses as JSON but is not an object: the issue has an empty path, shown as (root).
    expect(res.calls[1].issues).toHaveLength(1);
    expect(res.calls[1].issues![0]).toMatch(/^\(root\): \S/);
  });

  it("a long bad output is truncated to 4000 chars in the repair turn, but the repair key hashes all of it", async () => {
    const long = "x".repeat(5_000);
    const llm = new QueueLlm([long, JSON.stringify(VALID_TRIAGE)]);
    const res = await triageCall(llm);
    expect(res.attempts).toBe(2);
    expect(res.value).toEqual(VALID_TRIAGE);
    expect(llm.requests[1].messages[1]).toEqual({ role: "assistant", content: "x".repeat(4_000) });
    const baseKey = llm.requests[0].replayKey;
    expect(llm.requests[1].replayKey).toBe(sha256Hex(`${baseKey}|repair|${sha256Hex(long)}`));
    expect(llm.requests[1].replayKey).not.toBe(sha256Hex(`${baseKey}|repair|${sha256Hex("x".repeat(4_000))}`));
  });

  // BUG (latent): BudgetLimits.maxRepairs is accepted by TurnBudget and passed by every caller
  // (runner budgetLimits, evals/simulator.ts, scripts/eval-*.ts) but nothing enforces it.
  // TurnBudget.exceeded() never looks at `repairs`, and structuredCall's loop is hard-wired to
  // AGENT.turn.maxRepairs (src/lib/agent/structured.ts:82 and :152). Expected: a budget built
  // with maxRepairs: 0 makes the first invalid response final (1 provider call). Actual: 3 calls.
  it("a TurnBudget with maxRepairs: 0 makes the first invalid response final", async () => {
    const llm = new QueueLlm(["not json"]);
    const budget = new TurnBudget({ ...LIMITS, maxRepairs: 0 });
    const res = await triageCall(llm, budget);
    expect(res.value).toBeNull();
    expect(llm.requests).toHaveLength(1);
    expect(budget.repairs).toBe(0);
  });

  it("onCall sees every attempt's trace in order", async () => {
    const seen: [number, boolean][] = [];
    const llm = new QueueLlm(["nope", JSON.stringify(VALID_TRIAGE)]);
    const res = await structuredCall({
      provider: llm,
      node: "triage",
      promptVersion: "triage.test",
      system: "s",
      user: "u",
      logicalInput: { m: 1 },
      schema: TriageSchema,
      budget: new TurnBudget({ ...LIMITS }),
      onCall: (c) => seen.push([c.attempt, c.ok]),
    });
    expect(res.attempts).toBe(2);
    expect(seen).toEqual([
      [0, false],
      [1, true],
    ]);
    // The trace carries the provider's own usage and identity, not defaults.
    expect(res.calls[1]).toMatchObject({ node: "triage", provider: "groq", model: "openai/gpt-oss-20b", badge: "LIVE", inputTokens: 120, outputTokens: 40, latencyMs: 7 });
  });
});

describe("planSchema — cited clauses must be ones retrieval returned", () => {
  const plan = (cited: string[]) => ({
    actions: [{ type: "refund", orderId: "ORD-8820", amountCents: 700, reason: "damaged" }],
    rationale: "Shipping refund for a damaged item.",
    citedClauseIds: cited,
  });

  it("rejects an unretrieved clause id with a message naming the allowed ids", () => {
    const parsed = planSchema(["§2.1", "§4.2"]).safeParse(plan(["§4.2", "§9.9"]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].path).toEqual(["citedClauseIds", 1]);
    expect(parsed.error.issues[0].message).toBe('clause "§9.9" was not in the retrieved clauses; cite only: §2.1, §4.2');
    expect(planSchema(["§2.1", "§4.2"]).safeParse(plan(["§4.2", "§2.1"])).success).toBe(true);
  });

  it("says (none) when retrieval returned nothing", () => {
    const parsed = planSchema([]).safeParse(plan(["§1.1"]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].message).toBe('clause "§1.1" was not in the retrieved clauses; cite only: (none)');
  });

  it("structuredCall repairs a hallucinated citation: the repair prompt lists the allowed ids", async () => {
    const llm = new QueueLlm([JSON.stringify(plan(["§9.9"])), JSON.stringify(plan(["§4.2"]))]);
    const res = await structuredCall({
      provider: llm,
      node: "planner",
      promptVersion: "planner.test",
      system: "Plan.",
      user: "Plan a resolution.",
      logicalInput: { case: "ORD-8820" },
      schema: planSchema(["§2.1", "§4.2"]),
      budget: new TurnBudget({ ...LIMITS }),
    });
    expect(res.error).toBeNull();
    expect(res.attempts).toBe(2);
    expect(res.value?.citedClauseIds).toEqual(["§4.2"]);
    expect(res.calls[0].issues).toEqual(['citedClauseIds.0: clause "§9.9" was not in the retrieved clauses; cite only: §2.1, §4.2']);
    expect(llm.requests[1].messages[2].content).toContain("cite only: §2.1, §4.2");
  });

  it("a plan that keeps citing an unretrieved clause fails after the repair budget", async () => {
    const llm = new QueueLlm([JSON.stringify(plan(["§7.7"]))]);
    const res = await structuredCall({
      provider: llm,
      node: "planner",
      promptVersion: "planner.test",
      system: "Plan.",
      user: "Plan a resolution.",
      logicalInput: { case: "ORD-8820" },
      schema: planSchema(["§4.2"]),
      budget: new TurnBudget({ ...LIMITS }),
    });
    expect(res.error).toBe("INVALID_AFTER_REPAIRS");
    expect(llm.requests).toHaveLength(3);
    expect(res.attempts).toBe(3);
    expect(res.value).toBeNull();
    expect(res.calls.map((c) => c.issues)).toEqual([0, 1, 2].map(() => ['citedClauseIds.0: clause "§7.7" was not in the retrieved clauses; cite only: §4.2']));
  });
});

describe("structuredCall — budget and provider failures", () => {
  it("BUDGET_EXCEEDED before any call when the LLM-call limit is already reached", async () => {
    const budget = new TurnBudget({ ...LIMITS, maxLlmCalls: 2 });
    budget.record({ inputTokens: 1, outputTokens: 1 });
    budget.record({ inputTokens: 1, outputTokens: 1 });
    const llm = new QueueLlm([JSON.stringify(VALID_TRIAGE)]);
    const res = await triageCall(llm, budget);
    expect(res.error).toBe("BUDGET_EXCEEDED");
    expect(res.errorDetail).toBe("LLM call limit (2) reached");
    expect(res.attempts).toBe(0);
    expect(res.calls).toEqual([]);
    expect(res.value).toBeNull();
    expect(llm.requests).toHaveLength(0);
  });

  it("BUDGET_EXCEEDED mid-repair: the budget is checked before every attempt", async () => {
    const budget = new TurnBudget({ ...LIMITS, maxLlmCalls: 2 });
    const llm = new QueueLlm(["not json"]);
    const res = await triageCall(llm, budget);
    expect(res.error).toBe("BUDGET_EXCEEDED");
    expect(res.errorDetail).toBe("LLM call limit (2) reached");
    expect(res.value).toBeNull();
    expect(res.attempts).toBe(2);
    expect(llm.requests).toHaveLength(2);
    expect(res.calls).toHaveLength(2);
    expect(res.calls.map((c) => c.ok)).toEqual([false, false]);
    expect(budget.llmCalls).toBe(2);
    expect(budget.repairs).toBe(1);
  });

  it("BUDGET_EXCEEDED on the wall-clock limit, checked before each attempt (boundary is inclusive)", async () => {
    let clock = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const budget = new TurnBudget({ ...LIMITS, maxWallMs: 25_000 });
      // First call takes 24.999 s (still inside the budget, so a repair is attempted);
      // the repair takes 1 ms, landing exactly on the 25 s limit, so attempt 3 is refused.
      const advance = [24_999, 1, 0];
      const requests: LlmRequest[] = [];
      const slow: LlmProvider = {
        mode: "live",
        async complete(req) {
          clock += advance[requests.length];
          requests.push(req);
          return { text: "still not json", provider: "groq", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, badge: "LIVE" };
        },
      };
      const res = await triageCall(slow, budget);
      expect(requests).toHaveLength(2);
      expect(res.error).toBe("BUDGET_EXCEEDED");
      expect(res.errorDetail).toBe("turn time limit (25s) reached");
      expect(res.attempts).toBe(2);
      expect(res.calls).toHaveLength(2);
      expect(budget.llmCalls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("BUDGET_EXCEEDED on the output-token ceiling", async () => {
    const budget = new TurnBudget({ ...LIMITS, maxOutputTokens: 100 });
    const llm = new QueueLlm(["garbage"], { inputTokens: 10, outputTokens: 100 });
    const res = await triageCall(llm, budget);
    expect(res.error).toBe("BUDGET_EXCEEDED");
    expect(res.errorDetail).toBe("output token limit (100) reached");
    expect(llm.requests).toHaveLength(1);
    expect(res.attempts).toBe(1);
  });

  it("LLM_UNAVAILABLE propagates REPLAY_MISS from ReplayProvider for an unrecorded input", async () => {
    const input = { message: "structured-hitl test: this input was never recorded" };
    expect(hasReplay("triage", replayKeyFor("triage", "triage.test", input), 0)).toBe(false);
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(new ReplayProvider(), budget, input);
    expect(res.error).toBe("LLM_UNAVAILABLE");
    expect(res.unavailableCode).toBe("REPLAY_MISS");
    expect(res.errorDetail).toBe("No recorded triage output for this exact input. Switch to Live mode to use a real model.");
    expect(res.attempts).toBe(0);
    expect(res.calls).toEqual([]);
    expect(res.value).toBeNull();
    expect(budget.llmCalls).toBe(0);
  });

  it("control: a recorded replay key is served through structuredCall with the REPLAY badge and recordedAt", async () => {
    const entries = (replayJson as unknown as { entries: ReplayEntry[] }).entries;
    const entry = entries.find((e) => e.node === "triage" && e.attempt === 0 && e.scenario === "s1-damaged-double-charge")!;
    expect(entry).toBeDefined();
    const replay = new ReplayProvider();
    // Same provider, but pointed at a key that exists: proves the miss above is about the key.
    const pinned: LlmProvider = { mode: "replay", complete: (req) => replay.complete({ ...req, replayKey: entry.replayKey }) };
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(pinned, budget);
    expect(res.error).toBeNull();
    expect(res.attempts).toBe(1);
    expect(res.value).toEqual(JSON.parse(entry.text));
    expect(res.calls[0]).toMatchObject({ badge: "REPLAY", provider: "replay", model: entry.model, recordedAt: entry.recordedAt, ok: true });
    expect(budget.outputTokens).toBe(entry.usage.outputTokens);
  });

  it("LLM_UNAVAILABLE keeps the provider's own code (QUOTA) and maps unknown errors to PROVIDER_ERROR", async () => {
    const quota = await triageCall(new ThrowingLlm(new LlmUnavailableError("QUOTA", "Groq daily quota exhausted")));
    expect(quota.error).toBe("LLM_UNAVAILABLE");
    expect(quota.unavailableCode).toBe("QUOTA");
    expect(quota.errorDetail).toBe("Groq daily quota exhausted");

    const boom = new ThrowingLlm(new TypeError("fetch failed"));
    const generic = await triageCall(boom);
    expect(generic.error).toBe("LLM_UNAVAILABLE");
    expect(generic.unavailableCode).toBe("PROVIDER_ERROR");
    expect(generic.errorDetail).toBe("fetch failed");
    expect(boom.calls).toBe(1);
  });

  it("LLM_UNAVAILABLE on a repair attempt reports the attempts already made", async () => {
    let n = 0;
    const flaky: LlmProvider = {
      mode: "live",
      async complete() {
        n++;
        if (n === 1) return { text: "bad", provider: "groq", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, badge: "LIVE" };
        throw new LlmUnavailableError("AUTH", "key revoked");
      },
    };
    const budget = new TurnBudget({ ...LIMITS });
    const res = await triageCall(flaky, budget);
    expect(res.error).toBe("LLM_UNAVAILABLE");
    expect(res.unavailableCode).toBe("AUTH");
    expect(res.errorDetail).toBe("key revoked");
    expect(res.value).toBeNull();
    expect(res.attempts).toBe(1);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].ok).toBe(false);
    expect(n).toBe(2);
    // The failed call is not billed against the budget; the first (bad) one is.
    expect(budget.llmCalls).toBe(1);
    expect(budget.repairs).toBe(0);
  });
});

describe("replayKeyFor", () => {
  it("is stable for equal inputs regardless of key order", () => {
    const a = replayKeyFor("planner", "planner.v2", { order: "ORD-9941", facts: { paid: 64000, tier: "platinum" }, msgs: ["hi", "there"] });
    const b = replayKeyFor("planner", "planner.v2", { msgs: ["hi", "there"], facts: { tier: "platinum", paid: 64000 }, order: "ORD-9941" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TCK-1001 and TCK-1002 produce the same key; a real content change does not", () => {
    const key = (ticket: string, text = "Thanks, we opened a ticket.") => replayKeyFor("responder", "responder.v1", { ticket, text });
    expect(key("TCK-1001")).toBe(key("TCK-1002"));
    expect(key("TCK-1001", "Thanks, we opened a ticket!")).not.toBe(key("TCK-1001"));
    // Normalization is a substitution, not a deletion: an empty ticket is a different input.
    expect(key("")).not.toBe(key("TCK-1001"));
  });

  it("normalizes volatile run IDs (tickets, refunds, labels, tracking numbers, sagas)", () => {
    const k = (ticket: string, refund: string, tracking: string, saga: string) =>
      replayKeyFor("responder", "responder.v1", { ticket, refund, tracking, saga, note: `Ticket ${ticket} opened` });
    expect(k("TCK-1001", "RF-1001", "CA8800001001", "SAG-0A1B2C3D")).toBe(k("TCK-1002", "RF-1999", "CB8812345678", "SAG-FFFFFFFF"));
  });

  it("does NOT normalize business IDs or ignore node/prompt version", () => {
    const base = replayKeyFor("triage", "triage.v3", { message: "ORD-9941 arrived broken" });
    expect(replayKeyFor("triage", "triage.v3", { message: "ORD-9942 arrived broken" })).not.toBe(base);
    expect(replayKeyFor("planner", "triage.v3", { message: "ORD-9941 arrived broken" })).not.toBe(base);
    expect(replayKeyFor("triage", "triage.v4", { message: "ORD-9941 arrived broken" })).not.toBe(base);
  });

  it("structuredCall sends exactly replayKeyFor(...) on the first attempt", async () => {
    const llm = new QueueLlm([JSON.stringify(VALID_TRIAGE)]);
    await triageCall(llm, new TurnBudget({ ...LIMITS }), { ticket: "TCK-1001", text: "hello" });
    expect(llm.requests[0].replayKey).toBe(replayKeyFor("triage", "triage.test", { text: "hello", ticket: "TCK-1077" }));
  });
});

// ---------------------------------------------------------------------------------------
// (2) HITL through runTurn / resumeTurn
// ---------------------------------------------------------------------------------------

const SHOWCASE1_MSG = "My Aurora glass panel kit (ORD-9941) arrived shattered, and I was charged twice for it. Please fix this.";

function showcase1Llm() {
  return new ScriptedLlm({
    triage: () => ({
      intents: ["damaged_item", "double_charge"],
      severity: "high",
      sentiment: "negative",
      churnRisk: "medium",
      orderIdsMentioned: ["ORD-9941"],
      missingInfo: [],
      clarifyingQuestion: null,
      socialEngineeringSignals: [],
      summary: "Glass kit arrived shattered and the order was charged twice.",
    }),
    planner: (req) => ({
      actions: [
        { type: "refund", orderId: "ORD-9941", amountCents: 32000, reason: "duplicate_charge" },
        { type: "replacement", orderId: "ORD-9941", sku: "GLS-AUR-01", qty: 1, reason: "damaged" },
        { type: "return_label", orderId: "ORD-9941", reason: "damaged" },
      ],
      rationale: "Ledger shows a duplicate capture; carrier scan confirms transit damage.",
      citedClauseIds: cite(req, ["§2.1", "§4.2"]),
    }),
    responder: templateResponder,
  });
}

async function startShowcase1(llm = showcase1Llm()) {
  const sb = await freshSandbox();
  const thread = await newThread(sb, "CUS-1001");
  const first = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: SHOWCASE1_MSG, evidenceAttached: false, sagaHooks: instant });
  expect(first.status).toBe("AWAITING_APPROVAL");
  return { sb, thread, llm, first, interruptId: first.approval!.interruptId };
}

async function threadRow(sb: string, thread: string) {
  const rows = await db().select().from(s.threads).where(and(eq(s.threads.id, thread), eq(s.threads.sandboxId, sb)));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function checkpointValues(thread: string, saver: PostgresSaver = getCheckpointer()): Promise<Partial<GraphState>> {
  const tuple = await saver.getTuple({ configurable: { thread_id: thread } });
  return (tuple?.checkpoint.channel_values ?? {}) as Partial<GraphState>;
}

const refundsFor = (sb: string, orderId: string) =>
  db().select().from(s.refunds).where(and(eq(s.refunds.sandboxId, sb), eq(s.refunds.orderId, orderId)));

describe("HITL — interrupt and resume", () => {
  it("an interrupt checkpoints the run and marks the thread AWAITING_APPROVAL with the interrupt id", async () => {
    const { sb, thread, llm, first, interruptId } = await startShowcase1();
    expect(interruptId).toBeTruthy();
    expect(interruptId).not.toBe("interrupt");
    expect(first.outcome).toBe("AWAITING_APPROVAL");
    expect(first.approval!.card.threadId).toBe(thread);
    expect(first.approval!.card.humanReasons).toContain("AMOUNT_ABOVE_AUTO_LIMIT");
    expect(first.approval!.card.maxRefundableCents["ORD-9941"]).toBe(64000);
    expect(first.approval!.card.decisions.map((d) => d.action.type).sort()).toEqual(["refund", "replacement", "return_label"]);
    expect(first.approval!.card.decisions.every((d) => d.status === "NEEDS_HUMAN")).toBe(true);
    expect(first.approval!.card.totalExposureCents).toBeGreaterThan(first.approval!.card.autoLimitCents);
    expect(first.reply).toBeUndefined();
    expect(first.saga).toBeUndefined();
    expect(llm.calls.map((c) => c.node)).toEqual(["triage", "planner"]);

    const row = await threadRow(sb, thread);
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.interruptId).toBe(interruptId);

    // State is persisted: plan and gate are in the checkpoint, nothing has executed yet.
    const values = await checkpointValues(thread);
    expect(values.plan?.actions.map((a) => a.type)).toEqual(["refund", "replacement", "return_label"]);
    expect(values.gate?.route).toBe("human");
    expect(values.tokens).toEqual([]);
    expect(values.saga ?? null).toBeNull();
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);
    const tokens = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb));
    expect(tokens).toHaveLength(0);
    const sagas = await db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, sb));
    expect(sagas).toHaveLength(0);

    // The interrupt is in the persisted trace for this turn, with the same id.
    const trace = await db().select().from(s.traceEvents).where(and(eq(s.traceEvents.sandboxId, sb), eq(s.traceEvents.turnId, first.turnId)));
    const intr = trace.filter((t) => t.kind === "interrupt");
    expect(intr).toHaveLength(1);
    expect(intr[0].data.interruptId).toBe(interruptId);
  });

  it("a new customer message while awaiting approval returns AWAITING_APPROVAL without running the graph", async () => {
    const { sb, thread, llm, interruptId } = await startShowcase1();
    const before = await checkpointValues(thread);
    const callsBefore = llm.calls.length;

    const again = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: "Hello?? Any update on ORD-9941?", evidenceAttached: false, sagaHooks: instant });
    expect(again.status).toBe("AWAITING_APPROVAL");
    expect(again.error?.code).toBe("AWAITING_APPROVAL");
    expect(again.approval?.interruptId).toBe(interruptId);
    expect(again.usage.llmCalls).toBe(0);
    expect(llm.calls.length).toBe(callsBefore);

    const after = await checkpointValues(thread);
    expect(after.messages?.length).toBe(before.messages?.length);
    expect(after.messages?.some((m) => m.text.includes("Any update"))).toBe(false);
    const row = await threadRow(sb, thread);
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.interruptId).toBe(interruptId);

    // The pending interrupt was left intact: the original approval still resumes it, and the
    // message sent while waiting never enters the conversation.
    const ok = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "approve" }, sagaHooks: instant });
    expect(ok.status).toBe("REPLIED");
    expect(ok.saga?.status).toBe("DONE");
    const final = await checkpointValues(thread);
    expect(final.messages?.filter((m) => m.role === "customer").map((m) => m.text)).toEqual([SHOWCASE1_MSG]);
  });

  it("resumeTurn with a wrong interruptId → NO_SUCH_INTERRUPT and the real approval still works afterwards", async () => {
    const { sb, thread, llm, interruptId } = await startShowcase1();
    const callsBefore = llm.calls.length;
    const wrong = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: "not-the-real-interrupt", decision: { decision: "approve" }, sagaHooks: instant });
    expect(wrong.status).toBe("ERROR");
    expect(wrong.error?.code).toBe("NO_SUCH_INTERRUPT");
    expect(wrong.duplicate).toBeUndefined();
    expect(wrong.usage.llmCalls).toBe(0);
    expect(llm.calls.length).toBe(callsBefore);
    expect((await checkpointValues(thread)).approval ?? null).toBeNull();

    const decisionRows = await db().select().from(s.hitlDecisions).where(and(eq(s.hitlDecisions.threadId, thread), eq(s.hitlDecisions.interruptId, "not-the-real-interrupt")));
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].status).toBe("failed");
    expect(decisionRows[0].result).toEqual({ error: "NO_SUCH_INTERRUPT" });

    // Nothing ran and the thread still waits on the real interrupt.
    const row = await threadRow(sb, thread);
    expect(row.status).toBe("AWAITING_APPROVAL");
    expect(row.interruptId).toBe(interruptId);
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);

    const ok = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "approve" }, sagaHooks: instant });
    expect(ok.status).toBe("REPLIED");
    expect(ok.duplicate).toBeUndefined();
    expect(ok.saga?.status).toBe("DONE");
    expect(ok.outcome).toBe("RESOLVED");
    expect((await refundsFor(sb, "ORD-9941")).map((r) => r.amountCents)).toEqual([32000]);
    const done = await threadRow(sb, thread);
    expect(done.interruptId).toBeNull();
    expect(done.status).toBe("RESOLVED");
  });

  it("concurrent duplicate approvals run the saga at most once; the loser reports duplicate/ALREADY_PROCESSING", async () => {
    const { sb, thread, llm, interruptId } = await startShowcase1();
    const call = () => resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "approve" }, sagaHooks: instant });
    const results = await Promise.all([call(), call()]);

    const winners = results.filter((r) => !r.duplicate);
    const losers = results.filter((r) => r.duplicate === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].status).toBe("REPLIED");
    expect(winners[0].saga?.status).toBe("DONE");
    expect(winners[0].saga?.sagaId).toMatch(/^SAG-[0-9A-F]{8}$/);
    // The loser either saw the winner still processing, or (if the winner already finished) its stored result.
    if (losers[0].status === "ERROR") {
      expect(losers[0].error?.code).toBe("ALREADY_PROCESSING");
      expect(losers[0].usage.llmCalls).toBe(0);
    } else {
      expect(losers[0].status).toBe("REPLIED");
      expect(losers[0].saga?.sagaId).toBe(winners[0].saga?.sagaId);
    }

    const sagas = await db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, sb));
    expect(sagas.map((x) => x.id)).toEqual([winners[0].saga!.sagaId]);
    const refunds = await refundsFor(sb, "ORD-9941");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountCents).toBe(32000);
    // The HITL node ran once: exactly one set of approval tokens was minted (and consumed).
    const tokens = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb));
    expect(tokens.map((t) => t.action).sort()).toEqual(["refund", "replacement", "return_label"]);
    expect(tokens.every((t) => t.status === "consumed")).toBe(true);
    // Triage + planner ran once (first turn); only the winning resume reached the responder.
    expect(llm.calls.map((c) => c.node)).toEqual(["triage", "planner", "responder"]);

    const decisionRows = await db().select().from(s.hitlDecisions).where(and(eq(s.hitlDecisions.threadId, thread), eq(s.hitlDecisions.interruptId, interruptId)));
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].status).toBe("done");

    // A later retry gets the stored result and still does not re-run anything — even if it
    // carries a different decision: the first decision for an interrupt is final.
    const late = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "reject" }, sagaHooks: instant });
    expect(late.duplicate).toBe(true);
    expect(late.status).toBe("REPLIED");
    expect(late.outcome).toBe("RESOLVED");
    expect(late.saga?.sagaId).toBe(winners[0].saga?.sagaId);
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(1);
    expect(llm.calls).toHaveLength(3);
    expect((await checkpointValues(thread)).approval?.decision).toBe("approve");
  });

  it("reject: no tokens, no saga, no refund; the customer is told and the thread is REJECTED", async () => {
    const { sb, thread, llm, interruptId } = await startShowcase1();
    const r = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "reject", note: "needs a closer look" }, sagaHooks: instant });
    expect(r.status).toBe("REPLIED");
    expect(r.outcome).toBe("REJECTED");
    expect(r.saga).toBeNull();
    expect(r.facts?.actions.map((a) => [a.type, a.status])).toEqual([
      ["refund", "REJECTED"],
      ["replacement", "REJECTED"],
      ["return_label", "REJECTED"],
    ]);
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);
    expect(await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb))).toHaveLength(0);
    expect(await db().select().from(s.sagaRuns).where(eq(s.sagaRuns.sandboxId, sb))).toHaveLength(0);
    const approval = (await checkpointValues(thread)).approval!;
    expect(approval.decision).toBe("reject");
    expect(approval.finalActions).toEqual([]);
    expect(approval.droppedActions.map((d) => d.reasonCodes)).toEqual([["REJECTED_BY_SUPERVISOR"], ["REJECTED_BY_SUPERVISOR"], ["REJECTED_BY_SUPERVISOR"]]);
    const row = await threadRow(sb, thread);
    expect(row.status).toBe("REJECTED");
    expect(row.interruptId).toBeNull();
  });

  it("a second HITL cycle on the same thread gets a fresh interrupt id and its approval is not swallowed by the first", async () => {
    const { sb, thread, llm, interruptId: first } = await startShowcase1();
    const rejected = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first, decision: { decision: "reject" }, sagaHooks: instant });
    expect(rejected.outcome).toBe("REJECTED");

    const again = await runTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, customerId: "CUS-1001", message: SHOWCASE1_MSG, evidenceAttached: false, sagaHooks: instant });
    expect(again.status).toBe("AWAITING_APPROVAL");
    const second = again.approval!.interruptId;
    expect(second).not.toBe(first);
    expect((await threadRow(sb, thread)).interruptId).toBe(second);

    // The old interrupt id is spent; replaying it returns the stored reject, not a new run.
    const stale = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: first, decision: { decision: "approve" }, sagaHooks: instant });
    expect(stale.duplicate).toBe(true);
    expect(stale.outcome).toBe("REJECTED");
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);

    const approved = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId: second, decision: { decision: "approve" }, sagaHooks: instant });
    expect(approved.duplicate).toBeUndefined();
    expect(approved.status).toBe("REPLIED");
    expect(approved.outcome).toBe("RESOLVED");
    expect((await refundsFor(sb, "ORD-9941")).map((r) => r.amountCents)).toEqual([32000]);
  });

  it("modify with an amount above what was paid is denied by the re-gate — no refund executes", async () => {
    const { sb, thread, llm, first, interruptId } = await startShowcase1();
    const paidLeft = first.approval!.card.maxRefundableCents["ORD-9941"];
    expect(paidLeft).toBe(64000);

    const r = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "modify", amountCents: paidLeft + 1 }, sagaHooks: instant });
    expect(r.status).toBe("REPLIED");

    // The re-gate denied the inflated refund on the ledger check; nothing moved money.
    const values = await checkpointValues(thread);
    const approval = values.approval!;
    expect(approval.decision).toBe("modify");
    expect(approval.finalActions.some((a) => a.type === "refund")).toBe(false);
    const droppedRefund = approval.droppedActions.find((d) => d.action.type === "refund");
    expect(droppedRefund).toBeDefined();
    expect(droppedRefund!.action).toMatchObject({ type: "refund", orderId: "ORD-9941", amountCents: 64001 });
    expect(droppedRefund!.reasonCodes).toContain("AMOUNT_WITHIN_PAID");
    const regateRefund = values.gate!.decisions.find((d) => d.action.type === "refund" && d.index < 1_000);
    expect(regateRefund?.status).toBe("DENIED");
    expect(regateRefund?.action).toMatchObject({ amountCents: 64001 });
    expect(regateRefund?.checks.find((c) => c.code === "AMOUNT_WITHIN_PAID")).toMatchObject({ pass: false, hard: true });
    expect(regateRefund?.exposureCents).toBe(0);
    expect(approval.finalActions.map((a) => a.type)).toEqual(["replacement", "return_label"]);

    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);
    const tokens = await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb));
    expect(tokens.filter((t) => t.action === "refund")).toHaveLength(0);
    expect(r.facts?.actions.find((a) => a.type === "refund")).toMatchObject({ status: "DENIED", amountCents: 64001 });
    // The non-money actions the supervisor kept still execute through the saga.
    expect(r.saga?.status).toBe("DONE");
    expect(r.facts?.actions.find((a) => a.type === "replacement")?.status).toBe("DONE");
    expect(r.facts?.actions.find((a) => a.type === "return_label")?.status).toBe("DONE");
    expect(tokens.map((t) => t.action).sort()).toEqual(["replacement", "return_label"]);
  });

  it("the paid ceiling is inclusive: modify to exactly what was paid passes AMOUNT_WITHIN_PAID (still capped by the duplicate amount)", async () => {
    const { sb, thread, llm, first, interruptId } = await startShowcase1();
    const paidLeft = first.approval!.card.maxRefundableCents["ORD-9941"];
    await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "modify", amountCents: paidLeft }, sagaHooks: instant });
    const values = await checkpointValues(thread);
    const regateRefund = values.gate!.decisions.find((d) => d.action.type === "refund" && d.index < 1_000)!;
    expect(regateRefund.action).toMatchObject({ amountCents: paidLeft });
    expect(regateRefund.checks.find((c) => c.code === "AMOUNT_WITHIN_PAID")?.pass).toBe(true);
    // The ledger shows one duplicate capture of $320, so the re-gate still caps this refund at that.
    expect(regateRefund.status).toBe("DENIED");
    expect(regateRefund.reasonCodes).toEqual(["AMOUNT_MATCHES_DUPLICATE"]);
    expect(await refundsFor(sb, "ORD-9941")).toHaveLength(0);
  });

  it("control: modify to a LOWER amount is honoured — the re-gate approves it and exactly that refund executes", async () => {
    const { sb, thread, llm, interruptId } = await startShowcase1();
    const r = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm, interruptId, decision: { decision: "modify", amountCents: 25000 }, sagaHooks: instant });
    expect(r.status).toBe("REPLIED");
    expect(r.saga?.status).toBe("DONE");
    const values = await checkpointValues(thread);
    expect(values.approval?.finalActions.find((a) => a.type === "refund")).toMatchObject({ amountCents: 25000 });
    expect(values.approval?.droppedActions).toEqual([]);
    const refunds = await refundsFor(sb, "ORD-9941");
    expect(refunds.map((x) => x.amountCents)).toEqual([25000]);
    const refundToken = (await db().select().from(s.approvalTokens).where(eq(s.approvalTokens.sandboxId, sb))).filter((t) => t.action === "refund");
    expect(refundToken).toHaveLength(1);
    expect(refundToken[0].payload.amountCents).toBe(25000);
    expect(refunds[0].tokenId).toBe(refundToken[0].tokenId);
  });

  it("a fresh PostgresSaver on a new pool resumes the same thread (cold start) without re-running upstream nodes", async () => {
    const { sb, thread, llm: warmLlm, interruptId } = await startShowcase1();

    const pool = createPool(process.env.DATABASE_URL!, 2);
    try {
      const cold = new PostgresSaver(pool);
      // The cold saver sees the paused run.
      const values = await checkpointValues(thread, cold);
      expect(values.plan?.actions).toHaveLength(3);
      expect(values.threadId).toBe(thread);

      // A brand-new LLM instance stands in for a different serverless instance.
      const coldLlm = showcase1Llm();
      const resumed = await resumeTurn({ db: db(), sandboxId: sb, threadId: thread, mode: "live", llm: coldLlm, interruptId, decision: { decision: "approve" }, checkpointer: cold, sagaHooks: instant });
      expect(resumed.status).toBe("REPLIED");
      expect(resumed.saga?.status).toBe("DONE");
      expect(resumed.reply?.verified).toBe(true);
      expect(resumed.reply?.text).toContain("ORD-9941");
      // Only the responder ran after resume: triage and planner were restored from the checkpoint.
      expect(coldLlm.calls.map((c) => c.node)).toEqual(["responder"]);
      expect(warmLlm.calls.map((c) => c.node)).toEqual(["triage", "planner"]);
      // The restored plan (from the first instance's planner) is what the saga executed.
      expect(resumed.facts?.actions.map((a) => [a.type, a.status])).toEqual([
        ["refund", "DONE"],
        ["replacement", "DONE"],
        ["return_label", "DONE"],
      ]);

      const refunds = await refundsFor(sb, "ORD-9941");
      expect(refunds.map((x) => x.amountCents)).toEqual([32000]);
      const row = await threadRow(sb, thread);
      expect(row.interruptId).toBeNull();
      expect(row.status).toBe("RESOLVED");

      // Both the cold saver and the default (warm) one read the same final state from Postgres.
      for (const saver of [cold, getCheckpointer()]) {
        const v = await checkpointValues(thread, saver);
        expect(v.saga?.status).toBe("DONE");
        expect(v.saga?.sagaId).toBe(resumed.saga?.sagaId);
        expect(v.approval?.decision).toBe("approve");
      }
    } finally {
      await pool.end();
    }
  });
});
