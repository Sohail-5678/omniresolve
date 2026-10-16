/**
 * Replay provider for demo mode: plays back REAL model outputs recorded during the build
 * (data/recordings/replay.json), matched by node + input hash + attempt. It cannot answer
 * a message nobody recorded — that is a REPLAY_MISS, surfaced honestly in the UI.
 * The recorder wraps a live provider and captures entries for that file.
 */
import replayJson from "@data/recordings/replay.json";
import type { LlmNodeName } from "@/config/models";
import { LlmUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse, type ReplayEntry } from "./types";

type ReplayFile = { version: number; recordedWith: string[]; entries: ReplayEntry[] };
const file = replayJson as unknown as ReplayFile;

let index: Map<string, ReplayEntry> | null = null;
const keyOf = (node: LlmNodeName, replayKey: string, attempt: number) => `${node}|${replayKey}|${attempt}`;

function getIndex(): Map<string, ReplayEntry> {
  if (!index) {
    index = new Map();
    for (const e of file.entries) index.set(keyOf(e.node, e.replayKey, e.attempt), e);
  }
  return index;
}

export function replayStats() {
  return { entries: file.entries.length, models: [...new Set(file.entries.map((e) => e.model))], recordedWith: file.recordedWith };
}

export function hasReplay(node: LlmNodeName, replayKey: string, attempt = 0): boolean {
  return getIndex().has(keyOf(node, replayKey, attempt));
}

function bindAliases(text: string, aliases?: Record<string, string>): string {
  if (!aliases) return text;
  let out = text;
  for (const [alias, real] of Object.entries(aliases)) out = out.split(alias).join(real);
  return out;
}

export function unbindAliases(text: string, aliases?: Record<string, string>): string {
  if (!aliases) return text;
  let out = text;
  // Longest values first so "CB8800001001" is replaced before any shorter overlapping value.
  for (const [alias, real] of Object.entries(aliases).sort((a, b) => b[1].length - a[1].length)) {
    if (real) out = out.split(real).join(alias);
  }
  return out;
}

export class ReplayProvider implements LlmProvider {
  readonly mode = "replay" as const;
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const hit = getIndex().get(keyOf(req.node, req.replayKey, req.attempt));
    if (!hit) {
      throw new LlmUnavailableError("REPLAY_MISS", `No recorded ${req.node} output for this exact input. Switch to Live mode to use a real model.`);
    }
    return {
      text: bindAliases(hit.text, req.aliases),
      provider: "replay",
      model: hit.model,
      usage: hit.usage,
      latencyMs: 0,
      badge: "REPLAY",
      recordedAt: hit.recordedAt,
    };
  }
}

/**
 * Wraps a live provider and records every call (with aliases unbound) for replay.json.
 * Calls whose input was already recorded in this session are answered from the recording,
 * so paths that share a first turn branch from the same model outputs.
 */
export class RecordingProvider implements LlmProvider {
  readonly mode = "live" as const;
  readonly entries: ReplayEntry[] = [];
  constructor(
    private readonly inner: LlmProvider,
    private readonly scenario?: string,
    private readonly known: Map<string, ReplayEntry> = new Map(),
  ) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const prior = this.known.get(keyOf(req.node, req.replayKey, req.attempt));
    if (prior) {
      return { text: bindAliases(prior.text, req.aliases), provider: prior.provider, model: prior.model, usage: prior.usage, latencyMs: prior.latencyMs, badge: "LIVE", recordedAt: prior.recordedAt };
    }
    const res = await this.inner.complete(req);
    if (res.provider !== "replay") {
      this.entries.push({
        node: req.node,
        replayKey: req.replayKey,
        attempt: req.attempt,
        provider: res.provider,
        model: res.model,
        text: unbindAliases(res.text, req.aliases),
        usage: res.usage,
        latencyMs: res.latencyMs,
        recordedAt: new Date().toISOString(),
        scenario: this.scenario,
      });
      this.known.set(keyOf(req.node, req.replayKey, req.attempt), this.entries[this.entries.length - 1]);
    }
    return res;
  }
}
