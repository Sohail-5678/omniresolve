# Decisions (where reality differed from the plan, and why)

The build spec says reality wins when the document and reality disagree. These are the places it did.

## Models (2026-10-16)

- **The spec's Groq models are gone.** `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` no longer appear in Groq's `/models` list. The lineup in `src/config/models.ts` is: triage `openai/gpt-oss-20b`, planner and responder `openai/gpt-oss-120b`, customer simulator `qwen/qwen3.8-27b`; fallbacks walk to `qwen/qwen3.8-27b` (a separate rate-limit bucket) and Gemini Flash if a key is configured. gpt-oss models run with `reasoning_effort: "low"` because reasoning tokens are billed as output.
- **Observed free-tier limits** (from Groq response headers, per model, per key): 1,000 requests/day and 8,000 tokens/minute. Two keys from separate accounts are round-robined. The live provider waits out short `retry-after` windows (6 s in the web app, 65 s in scripts) before falling back to another model, because falling back to a weaker model silently degraded plans in early recordings.
- **No Gemini key was available at build time**, so clause embeddings could not be computed. "Dense" retrieval uses a labeled local lexical vector (hashed words + character trigrams). `scripts/build-index.ts` computes Gemini embeddings automatically when `GEMINI_API_KEY` is set.
- **Pricing** in `src/config/pricing.ts` is list price used only for *estimates*. `qwen/qwen3.8-27b` was not on the public price list when checked; it is priced like `qwen3-32b` and labeled an estimate.

## Platform

- **Next.js 16 + Cache Components.** The scaffold enables Cache Components (partial prerendering), which is incompatible with a nonce-based CSP. It is disabled; every page renders per request so `src/proxy.ts` (Next 16's renamed middleware) can attach a fresh nonce.
- **LangGraph.js node names** cannot equal state channel names, so nodes are `n1_triage … n7_respond`.
- **Postgres checkpointer works on Vercel** with the pooled Neon URL; `PostgresSaver.setup()` runs once in `scripts/migrate.ts`, not per request. The graph is rebuilt per request over a shared checkpointer, so a resume works on any instance (covered by a cold-start test).
- **Local Postgres** for development and tests can be Docker (`docker-compose.yml`) or any Postgres; the build machine used a Homebrew Postgres 17 cluster.
- **Recordings are JSON, not JSONL** (`data/recordings/replay.json`) so serverless bundles import them statically.

## Agent design

- **Frozen business clock.** Policy windows are computed against `AGENT.businessDate = 2026-10-16` so the seeded scenarios behave the same every day. Security clocks (token expiry, sandbox TTL, rate limits) use real time.
- **Governing dates.** Customer-facing promises (returns, shipping delays, transit damage) use the **order date** — the customer bought under those terms. Process rules (billing disputes, goodwill, approval limits) use the **claim date** — they describe how support works today.
- **Approval limits live in their own policy family** (`APPROVAL_AUTHORITY`) rather than inside the returns policy, because they apply to every money action.
- **Exposure counts replacements.** The approval limit compares against refunds + store credit + the value of replacement goods, because shipping a $320 replacement costs as much as refunding it.
- **Pinned rule clauses.** Early recordings showed the planner say "policy doesn't provide store credit for late returns" because the clause that grants it ranked 7th. The retriever now pins the clauses that *state the rules* for each triaged intent (from `rules.json` `clauseIds`, version in effect), labeled as pinned. The retrieval eval measures ranking alone, without pinning.
- **Planner exceptions** (`exception: true`) are honoured only for Platinum customers or high churn risk; otherwise a soft policy failure is a denial. This keeps the model from routing every out-of-window return to a human.
- **Replay keys** hash the node, prompt version and logical input — never the random spotlighting delimiter — and normalise run-specific IDs (ticket, refund, label numbers) so a scenario replays in any sandbox. The responder's recordings store those IDs as aliases and re-bind them to the current run's verified facts; the verifier still checks the final text.
- **Plain-text rendering** instead of sanitized markdown: model output is never rendered as HTML, so DOMPurify is not needed.

## UI

- **Design direction.** The spec described a dark ops console; the product owner asked for a poster style (signal orange, heavy wide caps, crop marks, pill toggles) with a monument and a mascot. The result: an Archivo-based "civic poster" system, a temple whose columns are the five pillars, and the Gatekeeper — an owl judge in pixel sunglasses who says "no token, no refund." Status colours are muted earth tones tuned to sit next to orange, always paired with a label and an icon.
- **Tailwind v4** via the Turbopack loader the scaffold configured.
