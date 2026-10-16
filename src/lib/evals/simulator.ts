/**
 * LLM customer simulator for multi-turn evals. It plays a persona with a hidden goal and a
 * list of facts it may reveal, answering only when the agent asks for something. Its own
 * mistakes are counted as simulator errors in the failure taxonomy, not hidden.
 */
import { z } from "zod";
import type { LlmProvider } from "@/lib/llm/types";
import { structuredCall } from "@/lib/agent/structured";
import { TurnBudget } from "@/lib/agent/budget";
import type { EvalScenario } from "./oracle";

const SimSchema = z.object({ message: z.string().min(1).max(800), done: z.boolean() });

const SYSTEM = `You role-play a customer of an online home-goods store talking to its support agent.
Stay in character. Use only the facts you are given; if the agent asks for something you don't know, say so.
Reply with ONE JSON object: {"message": "<your next message to the agent>", "done": <true if your issue is resolved or the agent clearly gave a final answer, else false>}.
Keep messages short (1-3 sentences) and natural.`;

export async function simulateCustomerTurn(provider: LlmProvider, sc: EvalScenario, transcript: { role: "customer" | "agent"; text: string }[]) {
  const persona = `PERSONA: style=${sc.persona.style}, patience=${sc.persona.patience}/5, honesty=${sc.persona.honesty}
HIDDEN GOAL (never state it as a goal, just behave accordingly): ${sc.hiddenGoal}
FACTS YOU KNOW: ${sc.knownFacts.map((f) => `\n- ${f}`).join("")}`;
  const convo = transcript.map((t) => `${t.role === "customer" ? "YOU" : "AGENT"}: ${t.text}`).join("\n");
  return structuredCall({
    provider,
    node: "simulator",
    promptVersion: "simulator.v1",
    system: SYSTEM,
    user: `${persona}\n\nCONVERSATION SO FAR:\n${convo}\n\nWrite your next message.`,
    logicalInput: { id: sc.id, transcript },
    schema: SimSchema,
    budget: new TurnBudget({ maxLlmCalls: 3, maxRepairs: 2, maxWallMs: 90_000, maxOutputTokens: 4_000 }),
    maxTokens: 300,
  });
}
