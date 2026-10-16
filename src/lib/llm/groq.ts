/**
 * Groq chat completions (OpenAI-compatible) with JSON mode. Retries 5xx inside the call;
 * a 429 is surfaced as QUOTA so the provider can rotate to another key or model. Keys come
 * from server env or the visitor's own key for one request (BYOK) and are never logged.
 * gpt-oss models get reasoning_effort "low" to keep reasoning tokens (billed as output) small.
 */
import { AGENT } from "@/config/agent";
import { PROVIDER_BASE_URL } from "@/config/models";
import { LlmUnavailableError, type ChatMessage, type LlmResponse } from "./types";

export async function groqChat(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  json: boolean;
  maxTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
  baseUrl?: string;
}): Promise<LlmResponse> {
  const url = `${opts.baseUrl ?? PROVIDER_BASE_URL.groq}/chat/completions`;
  const body = {
    model: opts.model,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    temperature: AGENT.llm.temperature,
    max_completion_tokens: opts.maxTokens,
    seed: 7,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  };
  let lastError = "";
  for (let attempt = 0; attempt <= AGENT.llm.providerRetries; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AGENT.llm.providerTimeoutMs),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new LlmUnavailableError("AUTH", "Groq rejected the API key.");
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "0");
      throw Object.assign(new LlmUnavailableError("QUOTA", `Groq 429 (rate limited) on ${opts.model}`), { retryAfterMs: retryAfter * 1000 });
    }
    if (res.status >= 500) {
      lastError = `Groq ${res.status}`;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // json_object mode returns 400 json_validate_failed when the model emits invalid JSON; surface the text for repair.
      const failed = /"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (res.status === 400 && failed) {
        return {
          text: JSON.parse(`"${failed[1]}"`) as string,
          provider: "groq",
          model: opts.model,
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - t0,
          badge: "LIVE",
        };
      }
      throw new LlmUnavailableError("PROVIDER_ERROR", `Groq ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      provider: "groq",
      model: opts.model,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      latencyMs: Date.now() - t0,
      badge: "LIVE",
    };
  }
  throw new LlmUnavailableError("PROVIDER_ERROR", lastError || "Groq request failed");
}
