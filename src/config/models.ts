/**
 * Model lineup per graph node — the only place model IDs live (spec 4.3).
 * Verified against Groq's /models list on 2026-10-16: the spec's Llama 3.x IDs are no
 * longer served, so the lineup uses gpt-oss-20b / gpt-oss-120b with qwen3.8-27b as the
 * backup (a separate rate-limit bucket). See docs/DECISIONS.md.
 */

export type ProviderName = "groq" | "gemini";

export type ModelChoice = { provider: ProviderName; model: string; reasoningEffort?: "low" | "medium" | "high" };

export type LlmNodeName = "triage" | "planner" | "responder" | "simulator" | "judge";

const GPT_OSS_20B: ModelChoice = { provider: "groq", model: "openai/gpt-oss-20b", reasoningEffort: "low" };
const GPT_OSS_120B: ModelChoice = { provider: "groq", model: "openai/gpt-oss-120b", reasoningEffort: "low" };
const QWEN_27B: ModelChoice = { provider: "groq", model: "qwen/qwen3.8-27b" };
const GEMINI_FLASH: ModelChoice = { provider: "gemini", model: "gemini-2.5-flash" };

/** Primary first, then fallbacks (used when the primary is down or rate-limited). */
export const NODE_MODELS: Record<LlmNodeName, ModelChoice[]> = {
  triage: [GPT_OSS_20B, QWEN_27B, GEMINI_FLASH],
  planner: [GPT_OSS_120B, QWEN_27B, GEMINI_FLASH],
  responder: [GPT_OSS_120B, QWEN_27B, GEMINI_FLASH],
  simulator: [QWEN_27B, GPT_OSS_20B],
  judge: [GPT_OSS_120B, QWEN_27B],
};

/** The "small planner" ablation (spec 9.1 #5) swaps the planner to the small model. */
export const SMALL_PLANNER: ModelChoice[] = [GPT_OSS_20B, QWEN_27B];

export const EMBEDDING_MODEL = {
  provider: "gemini" as const,
  model: "gemini-embedding-001",
  dimensions: 768,
};

export const PROVIDER_BASE_URL: Record<ProviderName, string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** Free-tier limits observed from Groq response headers on 2026-10-16 (per model, per key). */
export const OBSERVED_LIMITS = { requestsPerDay: 1000, tokensPerMinute: 8000 };
