/**
 * Live provider: round-robins Groq calls across every configured key (separate free-tier
 * buckets), waits out a short retry-after when all keys are rate-limited, and only then
 * falls back to the next model in the node's chain (src/config/models.ts).
 * Keys come from server env (quota-protected) or the visitor's own keys (BYOK, one request).
 */
import { AGENT } from "@/config/agent";
import { env } from "@/config/env";
import { NODE_MODELS, type ModelChoice, type LlmNodeName } from "@/config/models";
import { groqChat } from "./groq";
import { geminiChat } from "./gemini";
import { ReplayProvider } from "./replay";
import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

export type ProviderKeys = { groq?: string | string[]; gemini?: string };

export type LiveProviderOptions = {
  /** Longest single retry-after we will wait for before trying a fallback model. */
  maxQuotaWaitMs?: number;
  /** Total time we may spend waiting on rate limits across one call. */
  quotaWaitBudgetMs?: number;
  /** Use fallback models when the primary stays rate-limited. */
  fallback?: boolean;
  overrides?: Partial<Record<LlmNodeName, ModelChoice[]>>;
};

function groqKeys(keys: ProviderKeys): string[] {
  const k = keys.groq;
  return (Array.isArray(k) ? k : k ? [k] : []).filter(Boolean);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveProvider implements LlmProvider {
  readonly mode = "live" as const;
  private static cursor = 0;
  private readonly opts: Required<Omit<LiveProviderOptions, "overrides">> & Pick<LiveProviderOptions, "overrides">;

  constructor(
    private readonly keys: ProviderKeys,
    opts: LiveProviderOptions = {},
  ) {
    this.opts = { maxQuotaWaitMs: 6_000, quotaWaitBudgetMs: 8_000, fallback: true, ...opts };
  }

  private chain(node: LlmNodeName): ModelChoice[] {
    const all = this.opts.overrides?.[node] ?? NODE_MODELS[node];
    const usable = all.filter((c) => (c.provider === "groq" ? groqKeys(this.keys).length > 0 : !!this.keys.gemini));
    return this.opts.fallback ? usable : usable.slice(0, 1);
  }

  private async tryGroq(choice: ModelChoice, req: LlmRequest): Promise<LlmResponse> {
    const keys = groqKeys(this.keys);
    let waited = 0;
    let last: unknown;
    for (;;) {
      let minRetryAfter = Number.POSITIVE_INFINITY;
      const start = LiveProvider.cursor++;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[(start + i) % keys.length];
        try {
          return await groqChat({
            apiKey: key,
            model: choice.model,
            system: req.system,
            messages: req.messages,
            json: req.json,
            maxTokens: req.maxTokens ?? AGENT.llm.maxTokensPerCall,
            reasoningEffort: choice.reasoningEffort,
            baseUrl: env().LLM_BASE_URL,
          });
        } catch (err) {
          last = err;
          if (err instanceof LlmUnavailableError && err.code === "QUOTA") {
            const ra = (err as LlmUnavailableError & { retryAfterMs?: number }).retryAfterMs ?? 2_000;
            minRetryAfter = Math.min(minRetryAfter, Math.max(ra, 500));
            continue;
          }
          throw err;
        }
      }
      // Every key is rate-limited on this model: wait if the window is short, else give up on it.
      if (minRetryAfter <= this.opts.maxQuotaWaitMs && waited + minRetryAfter <= this.opts.quotaWaitBudgetMs) {
        await sleep(minRetryAfter + 250);
        waited += minRetryAfter + 250;
        continue;
      }
      throw last;
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const chain = this.chain(req.node);
    if (!chain.length) throw new LlmUnavailableError("NO_KEY", "No LLM API key is configured for live mode.");
    let last: unknown;
    for (const choice of chain) {
      try {
        if (choice.provider === "gemini") {
          return await geminiChat({
            apiKey: this.keys.gemini!,
            model: choice.model,
            system: req.system,
            messages: req.messages,
            json: req.json,
            maxTokens: req.maxTokens ?? AGENT.llm.maxTokensPerCall,
          });
        }
        return await this.tryGroq(choice, req);
      } catch (err) {
        last = err;
        if (err instanceof LlmUnavailableError && err.code === "AUTH" && chain.length === 1) throw err;
      }
    }
    throw last instanceof Error ? last : new LlmUnavailableError("PROVIDER_ERROR", "All providers failed");
  }
}

export function serverKeys(): ProviderKeys {
  const groq = [env().GROQ_API_KEY, process.env.GROQ_API_KEY_2].filter((k): k is string => !!k);
  return { groq, gemini: env().GEMINI_API_KEY };
}

export function hasServerKeys(): boolean {
  const k = serverKeys();
  return groqKeys(k).length > 0 || !!k.gemini;
}

export function providerFor(mode: "replay" | "live", byok?: ProviderKeys): LlmProvider {
  if (mode === "replay") return new ReplayProvider();
  const keys = byok && (groqKeys(byok).length || byok.gemini) ? byok : serverKeys();
  return new LiveProvider(keys);
}
