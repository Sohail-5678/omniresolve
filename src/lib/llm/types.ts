/**
 * Provider-agnostic LLM types. Every call carries a `replayKey` (hash of the logical
 * input, never of random delimiters) so demo mode can play back the exact output a real
 * model produced for the same input during recording.
 */
import type { LlmNodeName, ProviderName } from "@/config/models";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LlmRequest = {
  node: LlmNodeName;
  system: string;
  messages: ChatMessage[];
  json: boolean;
  maxTokens?: number;
  replayKey: string;
  attempt: number;
  /** alias -> real value; recordings store aliases so replays re-bind to this run's IDs. */
  aliases?: Record<string, string>;
};

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmResponse = {
  text: string;
  provider: ProviderName | "replay";
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  badge: "LIVE" | "REPLAY";
  recordedAt?: string;
};

export interface LlmProvider {
  readonly mode: "live" | "replay";
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorCode = "REPLAY_MISS" | "NO_KEY" | "PROVIDER_ERROR" | "QUOTA" | "AUTH";

export class LlmUnavailableError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export type ReplayEntry = {
  node: LlmNodeName;
  replayKey: string;
  attempt: number;
  provider: ProviderName;
  model: string;
  text: string;
  usage: LlmUsage;
  latencyMs: number;
  recordedAt: string;
  scenario?: string;
};
