/**
 * Gemini generateContent (JSON mime type, thinking disabled for latency) and the
 * embedding endpoint used to precompute clause vectors. Key sent in a header, not the URL.
 */
import { AGENT } from "@/config/agent";
import { EMBEDDING_MODEL, PROVIDER_BASE_URL } from "@/config/models";
import { l2normalize } from "@/lib/rag/dense";
import { LlmUnavailableError, type ChatMessage, type LlmResponse } from "./types";

export async function geminiChat(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  json: boolean;
  maxTokens: number;
}): Promise<LlmResponse> {
  const url = `${PROVIDER_BASE_URL.gemini}/models/${opts.model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: {
      temperature: AGENT.llm.temperature,
      maxOutputTokens: opts.maxTokens,
      responseMimeType: opts.json ? "application/json" : "text/plain",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let lastError = "";
  for (let attempt = 0; attempt <= AGENT.llm.providerRetries; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AGENT.llm.providerTimeoutMs),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new LlmUnavailableError("AUTH", "Gemini rejected the API key.");
    if (res.status === 429 || res.status >= 500) {
      lastError = `Gemini ${res.status}`;
      if (attempt < AGENT.llm.providerRetries) {
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      throw new LlmUnavailableError(res.status === 429 ? "QUOTA" : "PROVIDER_ERROR", `${lastError} after retries`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmUnavailableError("PROVIDER_ERROR", `Gemini ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
      provider: "gemini",
      model: opts.model,
      usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
      latencyMs: Date.now() - t0,
      badge: "LIVE",
    };
  }
  throw new LlmUnavailableError("PROVIDER_ERROR", lastError || "Gemini request failed");
}

/** Batch-embeds texts with the configured Gemini embedding model (normalized vectors). */
export async function geminiEmbed(apiKey: string, texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[][]> {
  const url = `${PROVIDER_BASE_URL.gemini}/models/${EMBEDDING_MODEL.model}:batchEmbedContents`;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    let attempt = 0;
    for (;;) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${EMBEDDING_MODEL.model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: EMBEDDING_MODEL.dimensions,
          })),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        attempt++;
        await new Promise((r) => setTimeout(r, 3_000 * attempt));
        continue;
      }
      if (!res.ok) throw new LlmUnavailableError("PROVIDER_ERROR", `Gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { embeddings?: { values: number[] }[] };
      for (const e of data.embeddings ?? []) out.push(l2normalize(e.values).map((x) => Math.round(x * 1e5) / 1e5));
      break;
    }
  }
  return out;
}
