/**
 * zod-validated LLM calls with a bounded repair loop (spec 7.2). On a parse or schema
 * failure the model gets the zod issues (path + message, no stack trace) and one more try,
 * up to AGENT.turn.maxRepairs (or the budget's lower maxRepairs). Validation takes well under a millisecond; each repair costs
 * one extra LLM call, which is counted and reported — there is no "free" repair.
 */
import type { z } from "zod";
import { AGENT } from "@/config/agent";
import type { LlmNodeName } from "@/config/models";
import { estimateCostUsd } from "@/config/pricing";
import { canonicalize, sha256Hex } from "@/lib/util/canonical";
import type { ChatMessage, LlmProvider, LlmResponse } from "@/lib/llm/types";
import { LlmUnavailableError } from "@/lib/llm/types";
import type { TurnBudget } from "./budget";

export type LlmCallTrace = {
  node: LlmNodeName;
  attempt: number;
  provider: string;
  model: string;
  badge: "LIVE" | "REPLAY";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  ok: boolean;
  validationMs: number;
  issues?: string[];
  recordedAt?: string;
};

export type StructuredResult<T> = {
  value: T | null;
  attempts: number;
  calls: LlmCallTrace[];
  error: null | "INVALID_AFTER_REPAIRS" | "BUDGET_EXCEEDED" | "LLM_UNAVAILABLE";
  errorDetail?: string;
  unavailableCode?: string;
};

/** Volatile, run-specific IDs are normalized out of replay keys (models still see real values). */
const VOLATILE = /\b(?:TCK|RF|SC|RPL|LBL|HLD|NTE|NTF|OBX)-1\d{3}\b|\b(?:CA|CB)88\d{8}\b|\bSAG-[0-9A-F]{8}\b/g;

export function replayKeyFor(node: LlmNodeName, promptVersion: string, logicalInput: unknown): string {
  return sha256Hex(`${node}|${promptVersion}|${canonicalize(logicalInput).replace(VOLATILE, "§ID")}`);
}

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Response was not valid JSON");
  }
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

export async function structuredCall<T>(opts: {
  provider: LlmProvider;
  node: LlmNodeName;
  promptVersion: string;
  system: string;
  user: string;
  logicalInput: unknown;
  schema: z.ZodType<T>;
  budget: TurnBudget;
  maxTokens?: number;
  aliases?: Record<string, string>;
  onCall?: (c: LlmCallTrace) => void;
}): Promise<StructuredResult<T>> {
  const baseKey = replayKeyFor(opts.node, opts.promptVersion, opts.logicalInput);
  const calls: LlmCallTrace[] = [];
  const conversation: ChatMessage[] = [{ role: "user", content: opts.user }];
  const history: string[] = [];

  const maxRepairs = Math.min(AGENT.turn.maxRepairs, opts.budget.maxRepairsPerCall);
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const over = opts.budget.exceeded();
    if (over) return { value: null, attempts: attempt, calls, error: "BUDGET_EXCEEDED", errorDetail: over };

    const replayKey = attempt === 0 ? baseKey : sha256Hex(`${baseKey}|repair|${history.join("|")}`);
    let res: LlmResponse;
    try {
      res = await opts.provider.complete({
        node: opts.node,
        system: opts.system,
        messages: conversation,
        json: true,
        maxTokens: opts.maxTokens,
        replayKey,
        attempt,
        aliases: opts.aliases,
      });
    } catch (err) {
      const code = err instanceof LlmUnavailableError ? err.code : "PROVIDER_ERROR";
      return {
        value: null,
        attempts: attempt,
        calls,
        error: "LLM_UNAVAILABLE",
        errorDetail: err instanceof Error ? err.message : String(err),
        unavailableCode: code,
      };
    }
    opts.budget.record(res.usage);
    if (attempt > 0) opts.budget.repairs++;

    const v0 = performance.now();
    let issues: string[] = [];
    let value: T | null = null;
    try {
      const parsed = opts.schema.safeParse(parseJsonLoose(res.text));
      if (parsed.success) value = parsed.data;
      else issues = formatIssues(parsed.error);
    } catch (err) {
      issues = [err instanceof Error ? err.message : "Response was not valid JSON"];
    }
    const validationMs = performance.now() - v0;
    const trace: LlmCallTrace = {
      node: opts.node,
      attempt,
      provider: res.provider,
      model: res.model,
      badge: res.badge,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      latencyMs: res.latencyMs,
      costUsd: estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens),
      ok: value !== null,
      validationMs: Math.round(validationMs * 1000) / 1000,
      issues: issues.length ? issues : undefined,
      recordedAt: res.recordedAt,
    };
    calls.push(trace);
    opts.onCall?.(trace);
    if (value !== null) return { value, attempts: attempt + 1, calls, error: null };

    history.push(sha256Hex(res.text));
    conversation.push(
      { role: "assistant", content: res.text.slice(0, 4_000) },
      {
        role: "user",
        content: `Your JSON did not pass validation:\n${issues.map((i) => `- ${i}`).join("\n")}\nReturn only the corrected JSON object, with the same keys and no commentary.`,
      },
    );
  }
  return { value: null, attempts: calls.length, calls, error: "INVALID_AFTER_REPAIRS" };
}
