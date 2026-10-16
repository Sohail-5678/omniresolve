# Saga: step order, the pivot, and failure handling

Code: `src/lib/saga/{steps,orchestrator,retry,idempotency}.ts`. Evidence: `data/results/chaos.json`.

## Why the refund is the pivot — and why it goes last

A refund cannot really be undone. "Reversing" it means charging the customer again, which is a new payment, not an undo — and it can fail. Every other step in a resolution *can* be reversed cheaply: a ticket can be marked rolled back, an inventory hold released, a return label voided, a replacement draft cancelled.

So the saga runs every reversible step first and the irreversible money movement last among the main steps. That is the standard saga **pivot transaction**: before the pivot, any failure is undone by compensations; after the pivot, the only way is forward.

## Steps (refund + replacement + return label)

| # | Step | Type | Compensation |
|---|---|---|---|
| 1 | `tickets.create` | Reversible | `tickets.cancel` → ticket `ROLLED_BACK` + human follow-up in the outbox |
| 2 | `orders.reserveInventory(sku, qty)` | Reversible | `orders.releaseInventory` |
| 3 | `carriers.createReturnLabel` (Carrier A → failover Carrier B) | Reversible | `carriers.voidLabel` (both carriers) |
| 4 | `orders.createReplacementDraft` | Reversible | `orders.cancelDraft` |
| **5** | **`billing.refund` — PIVOT** | **Irreversible** | none |
| 6 | `orders.confirmReplacement` | Retriable | forward recovery only |
| 7 | `tickets.resolve` (note + close) | Retriable | forward recovery only |
| 8 | `tickets.notify` (labeled preview, never sent) | Retriable | forward recovery only |

Plans without a refund use the next irreversible step as the pivot (store credit, else confirming the replacement). Steps that a plan doesn't need are not created.

## Failure table

| Where it fails | What happens | Final status | What the customer is told |
|---|---|---|---|
| Steps 1–4, retryable error (503 / 429 / timeout) after 3 attempts | Compensate completed steps in reverse | `ROLLED_BACK` | Nothing was charged or changed; a specialist follows up |
| Steps 1–4, schema drift (contract changed) | No retry (retrying can't fix it); compensate, including the failed step because it may have committed | `ROLLED_BACK` | Same |
| Step 3 on Carrier A | Retry, then the same label on Carrier B; a per-sandbox breaker skips A after repeated failures | continues | — |
| Step 5, definite failure (503 / 429 after retries) | Nothing moved; compensate 4 → 1 | `ROLLED_BACK` | Nothing was charged |
| Step 5, unknown outcome (timeout, schema drift) | **Reconcile**: look the refund up by its idempotency key in the ledger. Found → counts as done; not found → compensate | `DONE` or `ROLLED_BACK` | Matches what actually happened |
| Step 5, committed but the response was lost | The retry sends the same idempotency key; the stored response comes back; exactly one refund | `DONE` | Refund done |
| Steps 6–8 after retries | Keep the refund. Write `needs_ops_followup` to the outbox; ticket `REFUNDED_PENDING_FULFILLMENT` | `REFUNDED_PENDING_FULFILLMENT` | Refund done, fulfilment in progress |
| A compensation keeps failing | Outbox `compensation_failed`, shown loudly in the UI | `COMPENSATION_FAILED` | A specialist has been alerted |
| Process dies mid-saga | Each step's status is written before and after the call. `/api/saga/recover` (and every `/api/resolve` in that sandbox) continues stuck sagas: forward past the pivot, compensation before it | as above | as above |

## Sequence

```mermaid
sequenceDiagram
  participant G as Graph (N6)
  participant L as Saga log (Postgres)
  participant T as Tickets
  participant O as Orders
  participant C as Carrier A/B
  participant B as Billing
  G->>L: create saga + steps (PENDING)
  G->>T: create ticket (idempotency key k1)
  G->>O: reserve stock (k2) — verifies replacement token
  G->>C: return label (k3) — consumes label token; A fails → B
  G->>O: replacement draft (k4) — consumes replacement token
  Note over G,B: PIVOT — everything above can still be undone
  G->>B: refund (k5) — consumes refund token, same DB transaction
  alt step 4 failed
    G->>O: cancel draft
    G->>C: void label
    G->>O: release stock
    G->>T: ticket ROLLED_BACK + human follow-up
  end
  G->>O: confirm replacement (retry → outbox)
  G->>T: note + close (retry → outbox)
  G->>T: notification preview
  G->>L: saga DONE / ROLLED_BACK / REFUNDED_PENDING_FULFILLMENT
```

## Idempotency

`idempotency_key = sha256(sandboxId | sagaId | stepName | canonical(args))`. Every state-changing mock endpoint stores keys in `idempotency_keys` with a unique constraint, in the same transaction as the action. A repeated key returns the stored response without acting again. This is what makes retries safe after "committed, but the response was lost" (the `commit_then_timeout` fault).

## Retries

Retry on 429, 502, 503, 504 and timeouts; never on 400/401/403/404/409/422 or schema mismatches. Backoff `min(2 s, 100 ms × 2^attempt) × random(0.5, 1.0)`, at most 3 attempts, honouring `retry-after` on 429 (capped at 2 s so a turn fits its budget).

## What the chaos eval found

The first run of the fault matrix had zero integrity violations but one cell behaved differently from this design: when a pre-pivot step failed with a *definite* 503 and its compensation was also faulted, the saga was marked `COMPENSATION_FAILED` even though the failed call never committed. The fix: compensate a failed step only when its outcome is unknown (timeout or schema drift). The re-run is recorded in `data/results/chaos.json`.
