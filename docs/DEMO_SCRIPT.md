# Demo script

Live: https://omniresolve.vercel.app/console — works with no keys (replay mode).

## Two-minute version

1. **(15 s)** "This is a support agent that takes real actions — refunds, replacements, return labels — on mock business systems, safely. The LLM proposes; code decides."
2. **(35 s) Case 01.** Send the complaint. The graph lights up and pauses at N5: "The plan is valid, but $640 of exposure is above the $100 VIP limit, so the run is saved in Postgres and waits." Open *Modify*, drop the return label, approve. The saga runs; the reply cites §2.1 and §4.2 and carries the *verified* stamp; the Customer 360 shows the refund row appear.
3. **(30 s) Case 02B.** "The Orders API is down at step 4. The refund is the pivot, so it only runs after every reversible step worked. Step 4 failed, so 3, 2 and 1 were undone — the customer was never charged twice or refunded wrongly." Point at the saga ledger and the `ROLLED_BACK` ticket.
4. **(20 s) Case 04.** The "VP override" message: the firewall flags it, the gate checks the real order. Click *Try to call the refund tool directly* → `TOKEN_MISSING`. "Across the red-team set: zero unauthorized state changes, even though the planner was fooled some of the time" — read the exact numbers from the Evals drawer.
5. **(20 s) Evals drawer.** "Task success on 60 simulated multi-turn customers, checked against the final database state, not the text" — read the number, its N and its date.

## Questions to prepare for

**Why is the refund the pivot? What if the replacement confirmation fails after the refund?** A refund can't be undone without charging the customer again, so everything reversible runs first. If confirmation fails after the refund, we never claw the money back: we retry with backoff, then write a `needs_ops_followup` outbox record and set the ticket to `REFUNDED_PENDING_FULFILLMENT`; the reply says exactly that.

**What does the idempotency key protect against? Walk through `commit_then_timeout`.** Billing commits the refund and stores the response under the key in the same transaction, then the response is lost. The saga retries with the *same* key (derived from sandbox, saga, step and arguments); billing finds the key and returns the stored response without refunding again. Exactly one refund row.

**Why HMAC tokens if the gate already runs in code?** The gate decides; the token carries that decision to the tool boundary in a form that can't be forged, widened or replayed: it binds approver, action, order and amount, expires in 15 minutes, and is consumed once in the same transaction as the action. And the model never holds one, so even a fully hijacked planner can only propose.

**How does HITL resume work on serverless? What if the supervisor clicks approve twice?** `interrupt()` checkpoints the graph to Postgres and the request ends. The approve request rebuilds the graph on any instance and resumes with `Command({ resume })`. `(thread, interrupt)` is a primary key in `hitl_decisions`; the second click returns the stored result.

**Why final-state evaluation instead of text similarity? What is pass^k?** Customers care whether the refund happened, not how the reply was phrased. Each scenario's reference plan runs through the real gate and saga (an oracle) to produce the expected rows; the agent's run must match them. pass^k is the share of scenarios where *all* k runs succeed — reliability, not luck.

**How did you validate the LLM judge?** The reply-quality judge is not reported as a headline metric: calibrating it needs 40 human-labelled replies (Cohen's kappa), which is listed as pending in `docs/EVALS.md`. Task success uses database state, which needs no judge.

**Which ablation hurt most, and why?** Read it from the ablation table in the README; the gate ablation is the one that turns planner mistakes into wrong payouts.

**Governing date: order date or claim date?** Order date for customer-facing promises (returns, shipping, damage — the customer bought under those terms); claim date for process rules (billing disputes, goodwill, approval limits — how support works today).

**How would you connect real systems?** Replace each mock with an adapter that keeps the same contract: provider idempotency keys (payment providers support them natively), webhooks to confirm async outcomes instead of reading our own ledger, outbox-driven retries, and per-provider error mapping into the retryable / non-retryable split.

**What fails at scale?** Free-tier rate limits (move to paid tiers and per-tenant quotas), database connections (pooling is already in place; watch PgBouncer limits), long HITL queues (approval SLAs and expiring tokens re-minted on approval), prompt and model drift (re-run the scenario evals on every model change; alert on pass^k drops).
