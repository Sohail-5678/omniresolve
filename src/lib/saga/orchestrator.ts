/**
 * Saga orchestrator (N6). Runs approved actions as ordered steps over the mock APIs with a
 * durable step log in Postgres. Before the pivot, a failure compensates completed steps in
 * reverse (ROLLED_BACK). At the pivot, an unknown outcome is reconciled by reading the
 * ledger, never assumed. After the pivot, failures are retried and then written to the
 * outbox (REFUNDED_PENDING_FULFILLMENT) — a refund is never "rolled back".
 * Each step's status is written before and after its call, so a crash can be resumed.
 * This is a single-app saga over mocks, not a distributed transaction system.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { canonicalize, sha256Hex } from "@/lib/util/canonical";
import { ServiceError, SimulatedCrash } from "@/lib/util/errors";
import { formatCents } from "@/lib/util/money";
import type { ServiceCallEvent, ServiceCtx } from "@/lib/services/core";
import * as tickets from "@/lib/services/tickets";
import * as orders from "@/lib/services/orders";
import * as billing from "@/lib/services/billing";
import * as carriers from "@/lib/services/carriers";
import * as wire from "@/lib/services/wire";
import { idempotencyKey } from "./idempotency";
import { isRetryable, outcomeUnknown, withRetry } from "./retry";
import {
  buildSteps,
  type SagaPlan,
  type StepKind,
  type StepName,
} from "./steps";
import { AGENT } from "@/config/agent";

export type SagaStatus =
  | "RUNNING"
  | "COMPENSATING"
  | "DONE"
  | "ROLLED_BACK"
  | "COMPENSATION_FAILED"
  | "REFUNDED_PENDING_FULFILLMENT";
export const FINAL_SAGA: SagaStatus[] = [
  "DONE",
  "ROLLED_BACK",
  "COMPENSATION_FAILED",
  "REFUNDED_PENDING_FULFILLMENT",
];

export type StepEventStatus =
  | "RUNNING"
  | "RETRY"
  | "DONE"
  | "FAILED"
  | "FAILOVER"
  | "RECONCILED"
  | "COMPENSATING"
  | "COMPENSATED"
  | "COMPENSATION_FAILED"
  | "OUTBOX";

export type SagaEvent =
  | {
      type: "saga_start";
      sagaId: string;
      resumed: boolean;
      steps: { seq: number; name: StepName; kind: StepKind; status: string }[];
    }
  | {
      type: "saga_step";
      sagaId: string;
      seq: number;
      name: StepName;
      kind: StepKind;
      status: StepEventStatus;
      attempt?: number;
      message?: string;
      faultInjected?: boolean;
      carrier?: string;
    }
  | {
      type: "saga_end";
      sagaId: string;
      status: SagaStatus;
      ticketStatus: string | null;
    };

export type SagaCtx = {
  db: Db;
  sandboxId: string;
  emit?: (e: SagaEvent) => void;
  onServiceCall?: (e: ServiceCallEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test hook: simulate the process dying right after this step is persisted as DONE. */
  crashAfterSeq?: number;
  /** Set by continueSaga: every step/run write is conditional on still holding the lease. */
  leaseOwner?: string;
};

/** Another runner took this saga over (e.g. recovery or a duplicate resume); this one yields. */
class LeaseLost extends Error {
  constructor(sagaId: string) {
    super(`saga ${sagaId}: lease taken over by another runner`);
    this.name = "LeaseLost";
  }
}

export type SagaOutputs = {
  ticketId?: string;
  holdId?: string;
  labelId?: string;
  trackingNo?: string;
  carrier?: string;
  failover?: boolean;
  draftId?: string;
  refundId?: string;
  refundAmountCents?: number;
  creditId?: string;
  creditAmountCents?: number;
  notificationId?: string;
  notificationPreview?: string;
  replacementConfirmed?: boolean;
};

export type SagaStepView = {
  seq: number;
  name: StepName;
  kind: StepKind;
  status: string;
  attempts: number;
  error: string | null;
  detail: Record<string, unknown> | null;
};

export type SagaSummary = {
  sagaId: string;
  status: SagaStatus;
  ticketStatus: string | null;
  pivotSeq: number | null;
  steps: SagaStepView[];
  outputs: SagaOutputs;
  outbox: { id: string; kind: string }[];
};

type StepRow = typeof s.sagaSteps.$inferSelect;
type RunRow = typeof s.sagaRuns.$inferSelect;

export function planHashOf(plan: SagaPlan): string {
  return sha256Hex(
    canonicalize({ threadId: plan.threadId, actions: plan.actions }),
  );
}

/** Starts the saga for this plan, or resumes/returns the existing one (same thread + plan hash). */
export async function runSaga(
  ctx: SagaCtx,
  plan: SagaPlan,
): Promise<SagaSummary> {
  const planHash = planHashOf(plan);
  const existing = await findRun(ctx, plan.threadId, planHash);
  if (existing) {
    if (FINAL_SAGA.includes(existing.status as SagaStatus))
      return summarize(ctx, existing.id);
    return continueSaga(ctx, existing.id, true);
  }
  const defs = buildSteps(plan);
  const sagaId = `SAG-${randomUUID().slice(0, 8).toUpperCase()}`;
  const pivot = defs.find((d) => d.kind === "pivot")?.seq ?? null;
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.insert(s.sagaRuns).values({
        id: sagaId,
        sandboxId: ctx.sandboxId,
        threadId: plan.threadId,
        planHash,
        plan: plan as unknown as Record<string, unknown>,
        status: "RUNNING",
        pivotSeq: pivot,
      });
      await tx.insert(s.sagaSteps).values(
        defs.map((d) => ({
          sagaId,
          seq: d.seq,
          name: d.name,
          kind: d.kind,
          status: "PENDING",
          attempts: 0,
          idempotencyKey: idempotencyKey(ctx.sandboxId, sagaId, d.name, d.args),
          request: { ...d.args, tokenId: d.tokenId },
        })),
      );
    });
  } catch (err) {
    const raced = await findRun(ctx, plan.threadId, planHash);
    if (!raced) throw err;
    return FINAL_SAGA.includes(raced.status as SagaStatus)
      ? summarize(ctx, raced.id)
      : continueSaga(ctx, raced.id, true);
  }
  return continueSaga(ctx, sagaId, false);
}

async function findRun(
  ctx: SagaCtx,
  threadId: string,
  planHash: string,
): Promise<RunRow | undefined> {
  const rows = await ctx.db
    .select()
    .from(s.sagaRuns)
    .where(
      and(
        eq(s.sagaRuns.sandboxId, ctx.sandboxId),
        eq(s.sagaRuns.threadId, threadId),
        eq(s.sagaRuns.planHash, planHash),
      ),
    );
  return rows[0];
}

async function loadRun(
  ctx: SagaCtx,
  sagaId: string,
): Promise<{ run: RunRow; steps: StepRow[] }> {
  const runs = await ctx.db
    .select()
    .from(s.sagaRuns)
    .where(
      and(eq(s.sagaRuns.id, sagaId), eq(s.sagaRuns.sandboxId, ctx.sandboxId)),
    );
  if (!runs[0]) throw new Error(`saga ${sagaId} not found`);
  const steps = await ctx.db
    .select()
    .from(s.sagaSteps)
    .where(eq(s.sagaSteps.sagaId, sagaId))
    .orderBy(asc(s.sagaSteps.seq));
  return { run: runs[0], steps };
}

const holdsLease = (ctx: SagaCtx, sagaId: string) =>
  ctx.leaseOwner
    ? sql`exists (select 1 from saga_runs r where r.id = ${sagaId} and r.lease_owner = ${ctx.leaseOwner})`
    : undefined;

/** Writes a step and heartbeats the run (so a live saga is never mistaken for a stuck one). */
async function updateStep(
  ctx: SagaCtx,
  sagaId: string,
  seq: number,
  patch: Partial<typeof s.sagaSteps.$inferInsert>,
) {
  const rows = await ctx.db
    .update(s.sagaSteps)
    .set(patch)
    .where(
      and(
        eq(s.sagaSteps.sagaId, sagaId),
        eq(s.sagaSteps.seq, seq),
        holdsLease(ctx, sagaId),
      ),
    )
    .returning({ seq: s.sagaSteps.seq });
  if (ctx.leaseOwner && !rows.length) throw new LeaseLost(sagaId);
  await ctx.db
    .update(s.sagaRuns)
    .set({ updatedAt: new Date() })
    .where(eq(s.sagaRuns.id, sagaId));
}

async function setRunStatus(
  ctx: SagaCtx,
  sagaId: string,
  status: SagaStatus,
  ticketStatus?: string | null,
) {
  const rows = await ctx.db
    .update(s.sagaRuns)
    .set({
      status,
      updatedAt: new Date(),
      ...(ticketStatus !== undefined ? { ticketStatus } : {}),
    })
    .where(
      and(
        eq(s.sagaRuns.id, sagaId),
        ctx.leaseOwner ? eq(s.sagaRuns.leaseOwner, ctx.leaseOwner) : undefined,
      ),
    )
    .returning({ id: s.sagaRuns.id });
  if (ctx.leaseOwner && !rows.length) throw new LeaseLost(sagaId);
}

function outputsFrom(steps: StepRow[]): SagaOutputs {
  const out: SagaOutputs = {};
  for (const st of steps) {
    if (
      st.status !== "DONE" &&
      st.status !== "COMPENSATED" &&
      st.status !== "COMPENSATING"
    )
      continue;
    const r = (st.response ?? {}) as Record<string, unknown>;
    switch (st.name as StepName) {
      case "tickets.create":
        out.ticketId = r.ticketId as string;
        break;
      case "orders.reserveInventory":
        out.holdId = r.holdId as string;
        break;
      case "carriers.createReturnLabel":
        out.labelId = r.labelId as string;
        out.trackingNo = r.trackingNo as string;
        out.carrier = r.carrier as string;
        out.failover =
          (st.detail as { failover?: boolean } | null)?.failover ?? false;
        break;
      case "orders.createReplacementDraft":
        out.draftId = r.draftId as string;
        break;
      case "billing.refund":
        out.refundId = r.refundId as string;
        out.refundAmountCents = r.amountCents as number;
        break;
      case "billing.issueStoreCredit":
        out.creditId = r.creditId as string;
        out.creditAmountCents = r.amountCents as number;
        break;
      case "orders.confirmReplacement":
        if (st.status === "DONE") out.replacementConfirmed = true;
        break;
      case "tickets.notify":
        out.notificationId = r.notificationId as string;
        out.notificationPreview = r.preview as string;
        break;
    }
  }
  return out;
}

/** Continues a saga from its log: forward through pending steps, or finishes a compensation. */
export async function continueSaga(
  ctx: SagaCtx,
  sagaId: string,
  resumed: boolean,
): Promise<SagaSummary> {
  let { run, steps } = await loadRun(ctx, sagaId);
  const plan = run.plan as unknown as SagaPlan;
  ctx.emit?.({
    type: "saga_start",
    sagaId,
    resumed,
    steps: steps.map((st) => ({
      seq: st.seq,
      name: st.name as StepName,
      kind: st.kind as StepKind,
      status: st.status,
    })),
  });

  if (run.status === "COMPENSATING") {
    const failed =
      steps.find((st) => st.status === "FAILED")?.seq ??
      Number.MAX_SAFE_INTEGER;
    return rollback(ctx, run, steps, failed, "resumed compensation");
  }
  if (FINAL_SAGA.includes(run.status as SagaStatus))
    return summarize(ctx, sagaId);

  const followups: string[] = [];
  for (const step of steps) {
    if (step.status === "DONE" || step.status === "SKIPPED") continue;
    if (step.status === "FAILED" && step.kind === "retriable") {
      followups.push(step.name);
      // A crash between the FAILED write and the outbox write would otherwise lose the follow-up.
      if (!(step.detail as { outboxId?: string } | null)?.outboxId) {
        const outboxId = await tickets.writeOutbox(
          ctx.db,
          ctx.sandboxId,
          "needs_ops_followup",
          sagaId,
          { step: step.name, error: step.error ?? "failed" },
        );
        await updateStep(ctx, sagaId, step.seq, {
          detail: { ...(step.detail ?? {}), outboxId },
        });
      }
      continue;
    }
    const outputs = outputsFrom(steps);
    const result = await executeStep(ctx, run, plan, step, outputs, followups);
    ({ run, steps } = await loadRun(ctx, sagaId));
    if (result.ok) {
      if (ctx.crashAfterSeq === step.seq)
        throw new SimulatedCrash(`step ${step.seq} ${step.name}`);
      continue;
    }
    const err = result.error;
    const message = err instanceof Error ? err.message : String(err);
    if (step.kind === "retriable") {
      followups.push(step.name);
      const outboxId = await tickets.writeOutbox(
        ctx.db,
        ctx.sandboxId,
        "needs_ops_followup",
        sagaId,
        { step: step.name, error: message },
      );
      const current = steps.find((st) => st.seq === step.seq);
      await updateStep(ctx, sagaId, step.seq, {
        detail: { ...(current?.detail ?? {}), outboxId },
      });
      ctx.emit?.({
        type: "saga_step",
        sagaId,
        seq: step.seq,
        name: step.name as StepName,
        kind: "retriable",
        status: "OUTBOX",
        message: `Queued for ops follow-up (${outboxId})`,
      });
      continue;
    }
    return rollback(ctx, run, steps, step.seq, message);
  }

  const ticketStatus = followups.length
    ? "REFUNDED_PENDING_FULFILLMENT"
    : plan.actions.some((a) => a.action.type === "escalate")
      ? "ESCALATED"
      : "RESOLVED";
  if (followups.length) {
    const ticketId = outputsFrom(steps).ticketId;
    if (ticketId && followups.includes("tickets.resolve")) {
      // the ticket service itself is failing; the outbox row already records the required status
    } else if (ticketId) {
      await tickets
        .setTicketStatus(svc(ctx), {
          ticketId,
          status: ticketStatus,
          idempotencyKey: `${sagaId}:final-status`,
        })
        .catch(() => undefined);
    }
  }
  const status: SagaStatus = followups.length
    ? "REFUNDED_PENDING_FULFILLMENT"
    : "DONE";
  await setRunStatus(ctx, sagaId, status, ticketStatus);
  ctx.emit?.({ type: "saga_end", sagaId, status, ticketStatus });
  return summarize(ctx, sagaId);
}

function svc(ctx: SagaCtx): ServiceCtx {
  return { db: ctx.db, sandboxId: ctx.sandboxId, onCall: ctx.onServiceCall };
}

type StepResult = { ok: true } | { ok: false; error: unknown };

async function executeStep(
  ctx: SagaCtx,
  run: RunRow,
  plan: SagaPlan,
  step: StepRow,
  outputs: SagaOutputs,
  followups: string[],
): Promise<StepResult> {
  const sagaId = run.id;
  const name = step.name as StepName;
  const kind = step.kind as StepKind;
  const req = (step.request ?? {}) as Record<string, unknown>;
  const tokenId = (req.tokenId as string | null) ?? null;
  const key =
    step.idempotencyKey ?? idempotencyKey(ctx.sandboxId, sagaId, name, req);
  const s2 = svc(ctx);
  let attempts = step.attempts;
  let faultSeen = false;
  const onCall = (e: ServiceCallEvent) => {
    if (e.faultInjected) faultSeen = true;
    ctx.onServiceCall?.(e);
  };
  const sctx: ServiceCtx = { ...s2, onCall };

  await updateStep(ctx, sagaId, step.seq, {
    status: "RUNNING",
    startedAt: step.startedAt ?? new Date(),
  });
  ctx.emit?.({
    type: "saga_step",
    sagaId,
    seq: step.seq,
    name,
    kind,
    status: "RUNNING",
    attempt: attempts + 1,
  });

  const hooks = {
    sleep: ctx.sleep,
    random: ctx.random,
    onRetry: ({
      attempt,
      delayMs,
      error,
    }: {
      attempt: number;
      delayMs: number;
      error: unknown;
    }) => {
      ctx.emit?.({
        type: "saga_step",
        sagaId,
        seq: step.seq,
        name,
        kind,
        status: "RETRY",
        attempt: attempt + 1,
        faultInjected:
          error instanceof ServiceError ? error.faultInjected : false,
        message: `${error instanceof Error ? error.message : String(error)} — retrying in ${delayMs} ms`,
      });
    },
  };
  const counted = async <T>(fn: () => Promise<T>) => {
    attempts++;
    await updateStep(ctx, sagaId, step.seq, { attempts });
    return fn();
  };

  try {
    let response: Record<string, unknown>;
    let detail: Record<string, unknown> = {};
    switch (name) {
      case "tickets.create": {
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.TicketWire,
                await tickets.createTicket(sctx, {
                  sagaId,
                  threadId: plan.threadId,
                  customerId: plan.customerId,
                  orderId: plan.primaryOrderId,
                  subject: plan.subject,
                  idempotencyKey: key,
                }),
                "tickets.create",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "orders.reserveInventory": {
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.HoldWire,
                await orders.reserveInventory(sctx, {
                  threadId: plan.threadId,
                  sagaId,
                  tokenId,
                  idempotencyKey: key,
                  orderId: req.orderId as string,
                  sku: req.sku as string,
                  qty: req.qty as number,
                }),
                "orders.reserveInventory",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "carriers.createReturnLabel": {
        const r = await labelWithFailover(
          ctx,
          sctx,
          sagaId,
          plan,
          step,
          req,
          tokenId,
          hooks,
          counted,
        );
        response = r.response;
        detail = r.detail;
        break;
      }
      case "orders.createReplacementDraft": {
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.DraftWire,
                await orders.createReplacementDraft(sctx, {
                  threadId: plan.threadId,
                  sagaId,
                  tokenId,
                  idempotencyKey: key,
                  orderId: req.orderId as string,
                  sku: req.sku as string,
                  qty: req.qty as number,
                  holdId: outputs.holdId ?? null,
                }),
                "orders.createReplacementDraft",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "billing.refund": {
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.RefundWire,
                await billing.refund(sctx, {
                  threadId: plan.threadId,
                  sagaId,
                  tokenId,
                  idempotencyKey: key,
                  orderId: req.orderId as string,
                  amountCents: req.amountCents as number,
                  reason: req.reason as string,
                }),
                "billing.refund",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "billing.issueStoreCredit": {
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.CreditWire,
                await billing.issueStoreCredit(sctx, {
                  threadId: plan.threadId,
                  sagaId,
                  tokenId,
                  idempotencyKey: key,
                  customerId: req.customerId as string,
                  orderId: (req.orderId as string | null) ?? null,
                  amountCents: req.amountCents as number,
                  reason: req.reason as string,
                }),
                "billing.issueStoreCredit",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "orders.confirmReplacement": {
        if (!outputs.draftId)
          throw new ServiceError(
            409,
            "CONFLICT",
            "no replacement draft to confirm",
          );
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.ConfirmWire,
                await orders.confirmReplacement(sctx, {
                  sagaId,
                  draftId: outputs.draftId!,
                  idempotencyKey: key,
                }),
                "orders.confirmReplacement",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
      case "tickets.resolve": {
        if (!outputs.ticketId)
          throw new ServiceError(409, "CONFLICT", "no ticket to resolve");
        const status = followups.length
          ? "REFUNDED_PENDING_FULFILLMENT"
          : req.escalated
            ? "ESCALATED"
            : "RESOLVED";
        const note = resolutionNote(plan, outputs, status);
        // Note + status change are one logical step; both calls are idempotent, so retrying the pair is safe.
        const { value } = await withRetry(
          () =>
            counted(async () => {
              wire.parseWire(
                wire.NoteWire,
                await tickets.addNote(sctx, {
                  ticketId: outputs.ticketId!,
                  body: note,
                  idempotencyKey: `${key}:note`,
                }),
                "tickets.addNote",
              );
              return wire.parseWire(
                wire.TicketWire,
                await tickets.setTicketStatus(sctx, {
                  ticketId: outputs.ticketId!,
                  status,
                  idempotencyKey: `${key}:status`,
                }),
                "tickets.close",
              );
            }),
          hooks,
        );
        if (req.escalated) {
          await tickets.writeOutbox(
            ctx.db,
            ctx.sandboxId,
            "human_followup",
            sagaId,
            {
              ticketId: outputs.ticketId,
              reason: req.escalationReason ?? "Escalated to a specialist",
            },
          );
        }
        response = { ...value, note };
        break;
      }
      case "tickets.notify": {
        if (!outputs.ticketId)
          throw new ServiceError(409, "CONFLICT", "no ticket for notification");
        const preview = notificationPreview(plan, outputs);
        const { value } = await withRetry(
          () =>
            counted(async () =>
              wire.parseWire(
                wire.NotifyWire,
                await tickets.notifyPreview(sctx, {
                  ticketId: outputs.ticketId!,
                  sagaId,
                  preview,
                  idempotencyKey: key,
                }),
                "tickets.notify",
              ),
            ),
          hooks,
        );
        response = value;
        break;
      }
    }
    await updateStep(ctx, sagaId, step.seq, {
      status: "DONE",
      response,
      detail: { ...detail, faultInjected: faultSeen || undefined },
      error: null,
      finishedAt: new Date(),
    });
    ctx.emit?.({
      type: "saga_step",
      sagaId,
      seq: step.seq,
      name,
      kind,
      status: "DONE",
      attempt: attempts,
      faultInjected: faultSeen,
      carrier: detail.carrier as string | undefined,
      message: detail.failover
        ? `Failover → ${detail.carrier === "carrier_b" ? "Carrier B" : "Carrier A"}`
        : undefined,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof SimulatedCrash || err instanceof LeaseLost) throw err;
    // An unknown outcome at the pivot is reconciled against the ledger, never guessed.
    // An earlier attempt may have committed even when the last one failed definitely (lost
    // response, then 503), so every pivot failure is checked against the ledger.
    if (kind === "pivot" && !(err instanceof LeaseLost)) {
      const reconciled = await reconcilePivot(ctx, name, key, sagaId);
      if (reconciled) {
        await updateStep(ctx, sagaId, step.seq, {
          status: "DONE",
          response: reconciled,
          detail: { reconciled: true, faultInjected: true },
          error: null,
          finishedAt: new Date(),
        });
        ctx.emit?.({
          type: "saga_step",
          sagaId,
          seq: step.seq,
          name,
          kind,
          status: "RECONCILED",
          message:
            "Outcome unknown; ledger shows the call committed, so it counts as done.",
        });
        return { ok: true };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    await updateStep(ctx, sagaId, step.seq, {
      status: "FAILED",
      error: message,
      finishedAt: new Date(),
      detail: {
        faultInjected:
          faultSeen ||
          (err instanceof ServiceError && err.faultInjected) ||
          undefined,
        code:
          err instanceof ServiceError
            ? err.code
            : (err as { code?: string }).code,
      },
    });
    ctx.emit?.({
      type: "saga_step",
      sagaId,
      seq: step.seq,
      name,
      kind,
      status: "FAILED",
      attempt: attempts,
      message,
      faultInjected:
        faultSeen || (err instanceof ServiceError && err.faultInjected),
    });
    return { ok: false, error: err };
  }
}

async function labelWithFailover(
  ctx: SagaCtx,
  sctx: ServiceCtx,
  sagaId: string,
  plan: SagaPlan,
  step: StepRow,
  req: Record<string, unknown>,
  tokenId: string | null,
  hooks: Parameters<typeof withRetry>[1],
  counted: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{
  response: Record<string, unknown>;
  detail: Record<string, unknown>;
}> {
  const order: carriers.Carrier[] = (await carriers.breakerOpen(
    ctx.db,
    ctx.sandboxId,
    "carrier_a",
  ))
    ? ["carrier_b"]
    : ["carrier_a", "carrier_b"];
  const tried: { carrier: string; error: string }[] = [];
  let lastErr: unknown;
  for (const carrier of order) {
    const ckey = idempotencyKey(
      ctx.sandboxId,
      sagaId,
      `carriers.createReturnLabel@${carrier}`,
      { orderId: req.orderId },
    );
    try {
      const { value } = await withRetry(
        () =>
          counted(async () => {
            try {
              const r = wire.parseWire(
                wire.LabelWire,
                await carriers.createReturnLabel(sctx, carrier, {
                  threadId: plan.threadId,
                  sagaId,
                  orderId: req.orderId as string,
                  tokenId,
                  idempotencyKey: ckey,
                }),
                `${carrier}.createReturnLabel`,
              );
              await carriers.recordCarrierResult(
                ctx.db,
                ctx.sandboxId,
                carrier,
                true,
              );
              return r;
            } catch (e) {
              if (isRetryable(e) || outcomeUnknown(e))
                await carriers.recordCarrierResult(
                  ctx.db,
                  ctx.sandboxId,
                  carrier,
                  false,
                );
              throw e;
            }
          }),
        hooks,
      );
      return {
        response: value,
        detail: {
          carrier,
          failover: tried.length > 0 || order[0] === "carrier_b",
          breakerSkippedA: order[0] === "carrier_b",
          tried,
        },
      };
    } catch (err) {
      lastErr = err;
      if (outcomeUnknown(err)) {
        const rows = await ctx.db
          .select()
          .from(s.labels)
          .where(
            and(
              eq(s.labels.sandboxId, ctx.sandboxId),
              eq(s.labels.sagaId, sagaId),
              eq(s.labels.carrier, carrier),
              eq(s.labels.status, "active"),
            ),
          );
        if (rows[0]) {
          return {
            response: {
              labelId: rows[0].id,
              carrier,
              trackingNo: rows[0].trackingNo,
              status: "active",
            },
            detail: {
              carrier,
              failover: tried.length > 0,
              reconciled: true,
              tried,
            },
          };
        }
      }
      if (!(isRetryable(err) || outcomeUnknown(err))) throw err;
      tried.push({
        carrier,
        error: err instanceof Error ? err.message : String(err),
      });
      if (carrier === "carrier_a" && order.includes("carrier_b")) {
        ctx.emit?.({
          type: "saga_step",
          sagaId,
          seq: step.seq,
          name: "carriers.createReturnLabel",
          kind: "reversible",
          status: "FAILOVER",
          carrier: "carrier_b",
          message: "Carrier A exhausted retries — failing over to Carrier B",
        });
      }
    }
  }
  throw lastErr;
}

async function reconcilePivot(
  ctx: SagaCtx,
  name: StepName,
  key: string,
  sagaId: string,
): Promise<Record<string, unknown> | null> {
  const sctx = svc(ctx);
  if (name === "billing.refund") {
    const r = await billing.findRefundByKey(sctx, key);
    return r
      ? {
          refundId: r.id,
          orderId: r.orderId,
          amountCents: r.amountCents,
          status: "succeeded",
        }
      : null;
  }
  if (name === "billing.issueStoreCredit") {
    const c = await billing.findCreditByKey(sctx, key);
    return c
      ? { creditId: c.id, amountCents: c.amountCents, status: "issued" }
      : null;
  }
  if (name === "orders.confirmReplacement") {
    const rows = await ctx.db
      .select()
      .from(s.replacementDrafts)
      .where(
        and(
          eq(s.replacementDrafts.sandboxId, ctx.sandboxId),
          eq(s.replacementDrafts.sagaId, sagaId),
          eq(s.replacementDrafts.status, "confirmed"),
        ),
      );
    return rows[0] ? { draftId: rows[0].id, status: "confirmed" } : null;
  }
  return null;
}

/** Runs compensations for completed reversible steps in reverse order (plus the failed step). */
async function rollback(
  ctx: SagaCtx,
  run: RunRow,
  steps: StepRow[],
  failedSeq: number,
  reason: string,
): Promise<SagaSummary> {
  const sagaId = run.id;
  await setRunStatus(ctx, sagaId, "COMPENSATING");
  const sctx = svc(ctx);
  // The failed step itself is compensated only when it may have committed (timeout / schema
  // drift). A definite pre-commit failure (503, 429, 4xx) changed nothing, so undoing it would
  // only add a way for the rollback to fail.
  const mayHaveCommitted = (st: StepRow) =>
    ["TIMEOUT", "UPSTREAM_SCHEMA_MISMATCH"].includes(
      String((st.detail as { code?: string } | null)?.code ?? ""),
    );
  const targets = steps
    .filter(
      (st) =>
        st.kind === "reversible" &&
        (st.status === "DONE" ||
          st.status === "COMPENSATING" ||
          (st.seq === failedSeq &&
            st.status === "FAILED" &&
            mayHaveCommitted(st))),
    )
    .sort((a, b) => b.seq - a.seq);
  let compensationFailed = false;
  for (const st of targets) {
    const wasFailed = st.status === "FAILED";
    if (!wasFailed)
      await updateStep(ctx, sagaId, st.seq, { status: "COMPENSATING" });
    ctx.emit?.({
      type: "saga_step",
      sagaId,
      seq: st.seq,
      name: st.name as StepName,
      kind: "reversible",
      status: "COMPENSATING",
    });
    try {
      if ((st.name as StepName) === "carriers.createReturnLabel") {
        await voidLabels(ctx, sctx, sagaId, st);
      } else
        await withRetry(
          async () => {
            switch (st.name as StepName) {
              case "tickets.create":
                return wire.parseWire(
                  wire.CompensationWire,
                  await tickets.rollbackTicket(sctx, { sagaId, reason }),
                  "tickets.cancel",
                );
              case "orders.reserveInventory":
                return wire.parseWire(
                  wire.CompensationWire,
                  await orders.releaseInventory(sctx, { sagaId }),
                  "orders.releaseInventory",
                );
              case "orders.createReplacementDraft":
                return wire.parseWire(
                  wire.CompensationWire,
                  await orders.cancelDraft(sctx, { sagaId }),
                  "orders.cancelDraft",
                );
              default:
                return { affected: 0 };
            }
          },
          { sleep: ctx.sleep, random: ctx.random },
        );
      if (wasFailed) {
        await updateStep(ctx, sagaId, st.seq, {
          detail: { ...(st.detail ?? {}), compensated: true },
        });
      } else {
        await updateStep(ctx, sagaId, st.seq, { status: "COMPENSATED" });
      }
      ctx.emit?.({
        type: "saga_step",
        sagaId,
        seq: st.seq,
        name: st.name as StepName,
        kind: "reversible",
        status: "COMPENSATED",
      });
    } catch (err) {
      if (err instanceof SimulatedCrash || err instanceof LeaseLost) throw err;
      compensationFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      await updateStep(ctx, sagaId, st.seq, {
        status: wasFailed ? "FAILED" : "COMPENSATION_FAILED",
        error: message,
      });
      const outboxId = await tickets.writeOutbox(
        ctx.db,
        ctx.sandboxId,
        "compensation_failed",
        sagaId,
        { step: st.name, error: message },
      );
      ctx.emit?.({
        type: "saga_step",
        sagaId,
        seq: st.seq,
        name: st.name as StepName,
        kind: "reversible",
        status: "COMPENSATION_FAILED",
        message: `${message} (outbox ${outboxId})`,
      });
    }
  }
  // Steps after the failure never ran.
  await ctx.db
    .update(s.sagaSteps)
    .set({ status: "SKIPPED" })
    .where(
      and(eq(s.sagaSteps.sagaId, sagaId), eq(s.sagaSteps.status, "PENDING")),
    );
  const status: SagaStatus = compensationFailed
    ? "COMPENSATION_FAILED"
    : "ROLLED_BACK";
  const ticketStatus = compensationFailed
    ? "COMPENSATION_FAILED"
    : "ROLLED_BACK";
  await setRunStatus(ctx, sagaId, status, ticketStatus);
  ctx.emit?.({ type: "saga_end", sagaId, status, ticketStatus });
  return summarize(ctx, sagaId);
}

/**
 * Voids the saga's labels on both carriers, each with its own retries. Only the carrier that
 * issued the label (or both, when the step's outcome is unknown) must succeed: a Carrier A
 * outage — the usual reason for failing over to B — must not block voiding B's label.
 */
async function voidLabels(
  ctx: SagaCtx,
  sctx: ServiceCtx,
  sagaId: string,
  st: StepRow,
) {
  const issuer = (st.detail as { carrier?: carriers.Carrier } | null)?.carrier;
  const required: carriers.Carrier[] =
    st.status !== "FAILED" && issuer ? [issuer] : ["carrier_a", "carrier_b"];
  let firstErr: unknown = null;
  for (const carrier of ["carrier_a", "carrier_b"] as const) {
    try {
      await withRetry(
        async () =>
          wire.parseWire(
            wire.CompensationWire,
            await carriers.voidLabel(sctx, carrier, { sagaId }),
            `${carrier}.voidLabel`,
          ),
        { sleep: ctx.sleep, random: ctx.random },
      );
    } catch (err) {
      if (required.includes(carrier) && !firstErr) firstErr = err;
    }
  }
  if (firstErr) throw firstErr;
}

export async function summarize(
  ctx: Pick<SagaCtx, "db" | "sandboxId">,
  sagaId: string,
): Promise<SagaSummary> {
  const { run, steps } = await loadRun(ctx as SagaCtx, sagaId);
  const outbox = await ctx.db
    .select({ id: s.outbox.id, kind: s.outbox.kind })
    .from(s.outbox)
    .where(
      and(eq(s.outbox.sandboxId, ctx.sandboxId), eq(s.outbox.sagaId, sagaId)),
    );
  return {
    sagaId,
    status: run.status as SagaStatus,
    ticketStatus: run.ticketStatus,
    pivotSeq: run.pivotSeq,
    steps: steps.map((st) => ({
      seq: st.seq,
      name: st.name as StepName,
      kind: st.kind as StepKind,
      status: st.status,
      attempts: st.attempts,
      error: st.error,
      detail: st.detail ?? null,
    })),
    outputs: outputsFrom(steps),
    outbox,
  };
}

/** Sagas in this sandbox stuck in a non-final state (crashed or abandoned mid-run). */
export async function findStuckSagas(
  db: Db,
  sandboxId: string,
  olderThanMs: number = AGENT.sagaStaleMs,
) {
  return db
    .select({
      id: s.sagaRuns.id,
      threadId: s.sagaRuns.threadId,
      status: s.sagaRuns.status,
    })
    .from(s.sagaRuns)
    .where(
      and(
        eq(s.sagaRuns.sandboxId, sandboxId),
        inArray(s.sagaRuns.status, ["RUNNING", "COMPENSATING"]),
        lt(s.sagaRuns.updatedAt, new Date(Date.now() - olderThanMs)),
      ),
    );
}

/** Resumes every stuck saga in the sandbox: forward past the pivot, compensation before it. */
export async function recoverSagas(
  ctx: SagaCtx,
  olderThanMs: number = AGENT.sagaStaleMs,
): Promise<SagaSummary[]> {
  const stuck = await findStuckSagas(ctx.db, ctx.sandboxId, olderThanMs);
  const out: SagaSummary[] = [];
  for (const st of stuck) {
    await ctx.db
      .update(s.sagaRuns)
      .set({ updatedAt: new Date() })
      .where(eq(s.sagaRuns.id, st.id));
    out.push(await continueSaga(ctx, st.id, true));
  }
  return out;
}

function resolutionNote(
  plan: SagaPlan,
  o: SagaOutputs,
  status: string,
): string {
  const parts = [
    `Resolution for ${plan.customerName}${plan.primaryOrderId ? ` (${plan.primaryOrderId})` : ""}: ${status}.`,
  ];
  if (o.refundId)
    parts.push(
      `Refund ${o.refundId} for ${formatCents(o.refundAmountCents ?? 0)}.`,
    );
  if (o.creditId)
    parts.push(
      `Store credit ${o.creditId} for ${formatCents(o.creditAmountCents ?? 0)}.`,
    );
  if (o.draftId)
    parts.push(
      `Replacement ${o.draftId}${o.replacementConfirmed ? "" : " (not yet confirmed)"}.`,
    );
  if (o.labelId) parts.push(`Return label ${o.labelId} (${o.trackingNo}).`);
  return parts.join(" ");
}

function notificationPreview(plan: SagaPlan, o: SagaOutputs): string {
  const first = plan.customerName.split(" ")[0];
  const lines = [
    `Hi ${first}, here is an update on your request${plan.primaryOrderId ? ` about ${plan.primaryOrderId}` : ""}.`,
  ];
  if (o.refundId)
    lines.push(
      `Refund ${o.refundId}: ${formatCents(o.refundAmountCents ?? 0)}.`,
    );
  if (o.creditId)
    lines.push(
      `Store credit ${o.creditId}: ${formatCents(o.creditAmountCents ?? 0)}.`,
    );
  if (o.draftId && o.replacementConfirmed)
    lines.push(`Replacement order ${o.draftId} is confirmed.`);
  else if (o.draftId)
    lines.push(
      `Replacement order ${o.draftId} is being finalised by our operations team.`,
    );
  if (o.trackingNo) lines.push(`Return label tracking: ${o.trackingNo}.`);
  return lines.join(" ");
}
