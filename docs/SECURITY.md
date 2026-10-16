# Security

**Threat model:** the attacker is any website visitor. They can send arbitrary text (including prompt injections, pasted tool calls and invisible Unicode), call every public API route directly, replay requests, and run as many sandboxes as the rate limits allow. They cannot read server environment variables or the database.

**Assets:** money and order state in the mock systems (refunds, credits, replacements, labels), other visitors' sandboxes, the shared LLM quota, and secrets.

## Controls

| Control | Where | Evidence |
|---|---|---|
| The LLM proposes, code decides: every action is judged by the deterministic policy gate against versioned rules and the real ledger | `src/lib/policy/gate.ts` | `tests/unit/gate.test.ts`, `data/results/scenarios.json`, ablations |
| Approval tokens at the tool boundary: HMAC-SHA256 over canonical JSON, bound to sandbox + thread + action + order + amount (+ sku/qty), 15-minute expiry, single use, consumed in the same transaction as the action; constant-time signature check | `src/lib/security/{approval-token,tool-guard}.ts` | `tests/unit/tokens.test.ts`, property tests, forged-call demo (`TOKEN_MISSING`) |
| The LLM never receives or passes tokens (state holds IDs; the executor attaches them) | `src/lib/agent/nodes/{gate,hitl,execute}.ts` | prompt builders contain no token data |
| Mock billing independently refuses refunds above what was paid | `src/lib/services/billing.ts` | chaos + property tests |
| Sandbox isolation: every query is scoped by the sandbox ID from an HMAC-signed, httpOnly, SameSite=Lax session cookie — never from the request body | `src/lib/security/sandbox.ts`, `src/lib/http.ts` | `tests/integration/isolation-api.test.ts`, smoke test (cross-sandbox thread → 404) |
| Prompt firewall: size caps, Unicode Tag + invisible character stripping (the hidden text is scanned too), scored heuristics; `flag` forces money actions to a human, `block` refuses | `src/lib/security/firewall.ts` | `data/results/firewall.json` |
| Spotlighting: customer text inside per-request random delimiters, labeled as data | `src/lib/agent/conversation.ts` | — |
| Grounded replies: amounts, IDs, clauses, dates and promises checked against code-built facts | `src/lib/verify/grounding.ts` | `tests/unit/retry-verify-firewall.test.ts` |
| Model output rendered as plain text (no HTML, no markdown links, no external images) | console components | — |
| Server-side validation with zod on every route; body size cap 64 KB; message cap 4,000 chars; 30 turns per conversation | `src/app/api/**` | isolation-api tests |
| Rate limits: resolve 10/min per sandbox and 20/min per IP; session 5/hour per IP; chaos 30/min; Postgres-backed daily LLM counters with a global cap (`GLOBAL_DAILY_LLM_CALLS`), after which live mode falls back to replay with a notice | `src/lib/security/rate-limiter.ts` | — |
| Same-origin only: no CORS; state-changing routes reject a foreign `Origin` | `src/lib/http.ts` | isolation-api tests |
| Security headers: nonce-based CSP (`connect-src 'self'`, `frame-ancestors 'none'`), HSTS, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP | `src/proxy.ts`, `next.config.ts` | Playwright + smoke test |
| `/api/cron/cleanup` requires `Authorization: Bearer $CRON_SECRET` (constant-time compare) | route | — |
| Secrets only in Vercel env / local `.env.local` (gitignored); `.env.example` has fake values; gitleaks in CI; no secrets in prompts or logs; BYOK keys are used for one request and never stored | CI, `src/lib/llm/*` | gitleaks job |
| Parameterized queries only (Drizzle / `sql` template); pooled connection, small pool | `src/db/*` | — |
| Generic errors with a trace ID in production; details only in server logs | `src/lib/http.ts` | — |
| Sandboxes (and their checkpoints) deleted after 24 hours by a daily cron | `src/app/api/cron/cleanup` | — |

## Known gaps (honest list)

- **The firewall can be bypassed.** It is heuristic. It reduces risk and improves routing to humans; the token boundary is what prevents unauthorized money movement.
- **The demo supervisor is not an authenticated role.** Anyone can approve inside their own sandbox — which is fine for a demo where all money is fake and sandboxed, and wrong for production.
- **In-memory rate limits are per serverless instance.** The daily LLM counters are global (Postgres); per-minute limits are not.
- **Free-tier provider data policies apply** to live-mode text sent to Groq (and Gemini if configured). Replay mode sends nothing to any provider.
- **The app database role is the one Neon provisions**; a least-privilege runtime role separate from the migration role is a production follow-up.
- **No auth provider, passwords, 2FA or uploads** — by design: there are no real user accounts, and evidence is a labeled toggle.
