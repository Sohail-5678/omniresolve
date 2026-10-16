/**
 * Per-turn budget (spec 7.1): max LLM calls, output tokens and wall time per turn.
 * Nodes check it before every LLM call; exceeding it escalates with BUDGET_EXCEEDED
 * instead of letting a confused loop burn the shared free-tier quota.
 */
import { AGENT } from "@/config/agent";

export type BudgetLimits = { maxLlmCalls: number; maxRepairs: number; maxWallMs: number; maxOutputTokens: number };

export class TurnBudget {
  llmCalls = 0;
  outputTokens = 0;
  inputTokens = 0;
  repairs = 0;
  readonly startedAt: number;
  constructor(private readonly limits: BudgetLimits = AGENT.turn) {
    this.startedAt = Date.now();
  }
  exceeded(): string | null {
    if (this.llmCalls >= this.limits.maxLlmCalls) return `LLM call limit (${this.limits.maxLlmCalls}) reached`;
    if (this.outputTokens >= this.limits.maxOutputTokens) return `output token limit (${this.limits.maxOutputTokens}) reached`;
    if (Date.now() - this.startedAt >= this.limits.maxWallMs) return `turn time limit (${this.limits.maxWallMs / 1000}s) reached`;
    return null;
  }
  /** Repair calls each structured call may make after its first attempt. */
  get maxRepairsPerCall(): number {
    return Math.max(0, this.limits.maxRepairs);
  }
  record(usage: { inputTokens: number; outputTokens: number }) {
    this.llmCalls++;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }
  snapshot() {
    return {
      llmCalls: this.llmCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      repairs: this.repairs,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}
