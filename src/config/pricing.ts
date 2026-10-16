/**
 * List prices in USD per 1M tokens, used only to *estimate* cost per resolution.
 * Free-tier calls cost $0 in practice; the estimate shows what the same traffic
 * would cost on a paid plan. Checked against provider pricing pages; see docs/DECISIONS.md.
 */

export const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { input: 0.11, output: 0.34 },
  "qwen/qwen3-32b": { input: 0.29, output: 0.59 },
  // Not on the public price list when checked; priced like qwen3-32b and labeled an estimate in docs.
  "qwen/qwen3.8-27b": { input: 0.29, output: 0.59 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
