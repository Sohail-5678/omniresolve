/**
 * Test helpers: a fresh sandbox per test (isolation makes tests independent), instant
 * saga sleeps, and a scripted LLM that answers each node from a test-supplied function —
 * so graph/HITL/saga integration tests run without any network or API key.
 */
import { getDb } from "@/db/client";
import { createSandbox } from "@/lib/security/sandbox";
import { setFault, type FaultMode, type ServiceName } from "@/lib/services/fault-injector";
import { templateReply } from "@/lib/verify/grounding";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/lib/llm/types";
import type { VerifiedFacts } from "@/lib/agent/state";
import * as s from "@/db/schema";

export const db = () => getDb();

export async function freshSandbox(): Promise<string> {
  const { id } = await createSandbox(getDb(), { ipHash: "test" });
  return id;
}

export const instant = { sleep: async () => undefined, random: () => 0.5 };

export async function fault(sandboxId: string, service: ServiceName, operation: string, mode: FaultMode, n?: number) {
  await setFault(getDb(), sandboxId, service, operation, mode, n);
}

export async function newThread(sandboxId: string, customerId: string, threadId = `thr_${Math.random().toString(36).slice(2, 10)}`) {
  await getDb().insert(s.threads).values({ id: threadId, sandboxId, customerId, status: "ACTIVE", title: "test", mode: "live" });
  return threadId;
}

type Handler = (req: LlmRequest) => unknown;

/** A deterministic stand-in for Groq/Gemini: returns JSON from per-node handlers. */
export class ScriptedLlm implements LlmProvider {
  readonly mode = "live" as const;
  calls: LlmRequest[] = [];
  constructor(private readonly handlers: Partial<Record<LlmRequest["node"], Handler>>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const h = this.handlers[req.node];
    const out = h ? h(req) : {};
    return {
      text: typeof out === "string" ? out : JSON.stringify(out),
      provider: "groq",
      model: "scripted-test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 1,
      badge: "LIVE",
    };
  }
}

/** Pulls the VERIFIED FACTS JSON out of a responder prompt. */
export function factsFromPrompt(req: LlmRequest): VerifiedFacts {
  const user = req.messages[0].content;
  const start = user.indexOf("{");
  const end = user.indexOf("\n\nCONVERSATION");
  return JSON.parse(user.slice(start, end)) as VerifiedFacts;
}

export const templateResponder: Handler = (req) => ({ reply: templateReply(factsFromPrompt(req)) });

/** Clause IDs offered to the planner in this prompt (so scripted plans cite only retrieved clauses). */
export function offeredClauses(req: LlmRequest): string[] {
  return [...req.messages[0].content.matchAll(/^\[(§\d+\.\d+) ·/gm)].map((m) => m[1]);
}

export function cite(req: LlmRequest, wanted: string[]): string[] {
  const offered = offeredClauses(req);
  const hit = wanted.filter((w) => offered.includes(w));
  return hit.length ? hit : offered.slice(0, 1);
}
