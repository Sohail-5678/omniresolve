# Architecture

## Request lifecycle

1. `POST /api/session` creates a private sandbox (cloned from a deterministic seed template with `INSERT … SELECT`) and sets a signed session cookie.
2. `POST /api/resolve` `{ threadId?, message, scenarioId?, mode? }` → firewall → the LangGraph graph runs until it replies, asks a question, or calls `interrupt()`. Progress streams as Server-Sent Events (node start/end, LLM calls, mock-service calls, saga steps). The final `result` event has status `REPLIED | ASKED | AWAITING_APPROVAL | BLOCKED`.
3. If interrupted, the Postgres checkpointer holds the state and the thread row records the interrupt ID.
4. `POST /api/hitl` `{ threadId, interruptId, decision, amountCents?, removeActions?, note? }` → `Command({ resume })` continues from N5 on whichever instance receives it. `(thread, interrupt)` is a primary key in `hitl_decisions`, so a duplicate approval returns the stored result.

## Modules

| Path | Responsibility |
|---|---|
| `src/lib/agent/graph.ts` | StateGraph wiring, node IDs, checkpointer |
| `src/lib/agent/nodes/*` | N1 triage, ask, N2 context, N3 retrieve, N4a plan, N4b gate (+ token minting), N5 HITL, N6 execute, N7 respond |
| `src/lib/agent/structured.ts` | zod-validated LLM calls, repair loop, replay keys |
| `src/lib/agent/runner.ts` | one turn / one resume end to end, trace persistence, idempotent HITL, recovery |
| `src/lib/policy/*` | versioned rules (`data/policies/rules.json`), the gate, clause parsing, policy validation |
| `src/lib/rag/*` | tokenizer (Porter), BM25, dense (embeddings or labeled lexical fallback), RRF, temporal filter, retriever |
| `src/lib/security/*` | approval tokens, tool guard, firewall, rate limiter, sandboxes + sessions |
| `src/lib/saga/*` | steps, orchestrator (pivot, compensation, reconciliation, recovery), retry, idempotency keys |
| `src/lib/services/*` | mock CRM, Orders, Billing, Carriers A/B, Tickets; fault injector; wire contracts |
| `src/lib/verify/grounding.ts` | reply verifier + safe template |
| `src/lib/llm/*` | Groq, Gemini, replay + recording providers, key rotation |
| `src/lib/evals/*` | oracle, customer simulator, statistics |
| `src/components/console/*` | the operations console |
| `src/components/landing/*`, `src/components/art/*` | landing page and illustrations |

## Data

All mock-business and agent tables carry `sandbox_id` with `ON DELETE CASCADE` from `sandboxes`, so deleting an expired sandbox removes everything it owns; LangGraph checkpoints are deleted per thread by the cleanup cron. Money is integer cents everywhere. IDs for new rows (tickets, refunds, labels…) come from per-sandbox counters, so a fresh sandbox produces the same IDs every time — which is what lets recorded demo replies line up.

## Graph state

`ResolutionState` (`src/lib/agent/state.ts`) holds the conversation, firewall result, triage, context, retrieved clauses, plan, gate result, approval record, **token IDs only**, saga summary, verified facts, reply, outcome and per-turn LLM call traces. Each node's output is checkpointed.
