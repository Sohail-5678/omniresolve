/**
 * Postgres schema (Drizzle). Every mock-business and agent table carries sandbox_id and
 * cascades from sandboxes, so deleting an expired sandbox deletes everything it owns.
 * Money is integer cents everywhere. LangGraph's own checkpoint tables are created by
 * PostgresSaver.setup() in scripts/migrate.ts, not here.
 */
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  date,
  primaryKey,
  index,
  uniqueIndex,
  bigserial,
  boolean,
} from "drizzle-orm/pg-core";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const sandboxes = pgTable("sandboxes", {
  id: text("id").primaryKey(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  ipHash: text("ip_hash"),
  seedVersion: integer("seed_version").notNull(),
  isTemplate: boolean("is_template").notNull().default(false),
});

const sandboxRef = () =>
  text("sandbox_id")
    .notNull()
    .references(() => sandboxes.id, { onDelete: "cascade" });

export const idCounters = pgTable(
  "id_counters",
  {
    sandboxId: sandboxRef(),
    prefix: text("prefix").notNull(),
    value: integer("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.prefix] })],
);

// ---------------------------------------------------------------- CRM (mock)
export const customers = pgTable(
  "customers",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    emailMasked: text("email_masked").notNull(),
    tier: text("tier").notNull(), // standard | gold | platinum
    lifetimeValueCents: integer("lifetime_value_cents").notNull(),
    churnFlags: jsonb("churn_flags").$type<string[]>().notNull().default([]),
    since: date("since").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

// ---------------------------------------------------------------- Orders (mock)
export const orders = pgTable(
  "orders",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    customerId: text("customer_id").notNull(),
    orderDate: date("order_date").notNull(),
    promisedDate: date("promised_date").notNull(),
    deliveredDate: date("delivered_date"),
    status: text("status").notNull(), // processing | shipped | delivered | lost
    subtotalCents: integer("subtotal_cents").notNull(),
    shippingCents: integer("shipping_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("orders_customer_idx").on(t.sandboxId, t.customerId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    sandboxId: sandboxRef(),
    orderId: text("order_id").notNull(),
    line: integer("line").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    qty: integer("qty").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.orderId, t.line] })],
);

export const inventory = pgTable(
  "inventory",
  {
    sandboxId: sandboxRef(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    onHand: integer("on_hand").notNull(),
    reserved: integer("reserved").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.sku] })],
);

export const inventoryHolds = pgTable(
  "inventory_holds",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    sku: text("sku").notNull(),
    qty: integer("qty").notNull(),
    sagaId: text("saga_id").notNull(),
    status: text("status").notNull(), // held | released | consumed
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("holds_saga_idx").on(t.sandboxId, t.sagaId),
  ],
);

export const replacementDrafts = pgTable(
  "replacement_drafts",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    orderId: text("order_id").notNull(),
    sku: text("sku").notNull(),
    qty: integer("qty").notNull(),
    holdId: text("hold_id"),
    sagaId: text("saga_id").notNull(),
    tokenId: text("token_id").notNull(),
    status: text("status").notNull(), // draft | cancelled | confirmed
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("drafts_saga_idx").on(t.sandboxId, t.sagaId),
  ],
);

// ---------------------------------------------------------------- Billing (mock)
export const charges = pgTable(
  "charges",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    orderId: text("order_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    capturedAt: ts("captured_at").notNull(),
    status: text("status").notNull().default("captured"),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("charges_order_idx").on(t.sandboxId, t.orderId),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    orderId: text("order_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    tokenId: text("token_id"),
    sagaId: text("saga_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("refunds_order_idx").on(t.sandboxId, t.orderId),
  ],
);

export const storeCredits = pgTable(
  "store_credits",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    customerId: text("customer_id").notNull(),
    orderId: text("order_id"),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    tokenId: text("token_id"),
    sagaId: text("saga_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

// ---------------------------------------------------------------- Carriers (mock)
export type TrackingEvent = { at: string; code: string; description: string };

export const shipments = pgTable(
  "shipments",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    orderId: text("order_id").notNull(),
    carrier: text("carrier").notNull(), // carrier_a | carrier_b
    trackingNo: text("tracking_no").notNull(),
    status: text("status").notNull(),
    events: jsonb("events").$type<TrackingEvent[]>().notNull().default([]),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("shipments_order_idx").on(t.sandboxId, t.orderId),
  ],
);

export const labels = pgTable(
  "labels",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    orderId: text("order_id").notNull(),
    carrier: text("carrier").notNull(),
    trackingNo: text("tracking_no").notNull(),
    sagaId: text("saga_id").notNull(),
    tokenId: text("token_id").notNull(),
    status: text("status").notNull(), // active | voided
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("labels_saga_idx").on(t.sandboxId, t.sagaId),
  ],
);

// ---------------------------------------------------------------- Tickets (mock)
export const tickets = pgTable(
  "tickets",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    customerId: text("customer_id").notNull(),
    orderId: text("order_id"),
    threadId: text("thread_id"),
    sagaId: text("saga_id"),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.id] }),
    index("tickets_saga_idx").on(t.sandboxId, t.sagaId),
  ],
);

export const ticketNotes = pgTable(
  "ticket_notes",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    ticketId: text("ticket_id").notNull(),
    body: text("body").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

export const notifications = pgTable(
  "notifications",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    ticketId: text("ticket_id").notNull(),
    sagaId: text("saga_id"),
    channel: text("channel").notNull(),
    preview: text("preview").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

export const outbox = pgTable(
  "outbox",
  {
    sandboxId: sandboxRef(),
    id: text("id").notNull(),
    kind: text("kind").notNull(), // needs_ops_followup | human_followup | compensation_failed
    sagaId: text("saga_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("open"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

// ---------------------------------------------------------------- Chaos (per sandbox)
export const faultSettings = pgTable(
  "fault_settings",
  {
    sandboxId: sandboxRef(),
    service: text("service").notNull(),
    operation: text("operation").notNull(),
    mode: text("mode").notNull(),
    n: integer("n"),
    calls: integer("calls").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.service, t.operation] })],
);

export const breakers = pgTable(
  "breakers",
  {
    sandboxId: sandboxRef(),
    service: text("service").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    openUntil: ts("open_until"),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.service] })],
);

// ---------------------------------------------------------------- Security
export const approvalTokens = pgTable(
  "approval_tokens",
  {
    tokenId: text("token_id").primaryKey(),
    sandboxId: sandboxRef(),
    threadId: text("thread_id").notNull(),
    action: text("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull(), // issued | consumed | expired | revoked
    issuedAt: ts("issued_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
  },
  (t) => [index("tokens_thread_idx").on(t.sandboxId, t.threadId)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    sandboxId: sandboxRef(),
    operation: text("operation").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.key] })],
);

// ---------------------------------------------------------------- Saga log
export const sagaRuns = pgTable(
  "saga_runs",
  {
    id: text("id").primaryKey(),
    sandboxId: sandboxRef(),
    threadId: text("thread_id").notNull(),
    planHash: text("plan_hash").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    pivotSeq: integer("pivot_seq"),
    ticketStatus: text("ticket_status"),
    /** The runner currently driving this saga; a newer runner takes over and the old one yields. */
    leaseOwner: text("lease_owner"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saga_plan_uq").on(t.sandboxId, t.threadId, t.planHash)],
);

export const sagaSteps = pgTable(
  "saga_steps",
  {
    sagaId: text("saga_id")
      .notNull()
      .references(() => sagaRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // reversible | pivot | retriable
    status: text("status").notNull(), // PENDING | RUNNING | DONE | FAILED | COMPENSATING | COMPENSATED | SKIPPED
    attempts: integer("attempts").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    request: jsonb("request").$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    error: text("error"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.sagaId, t.seq] })],
);

// ---------------------------------------------------------------- Conversations
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    sandboxId: sandboxRef(),
    customerId: text("customer_id").notNull(),
    scenarioId: text("scenario_id"),
    status: text("status").notNull(),
    title: text("title").notNull(),
    mode: text("mode").notNull(),
    evidenceAttached: boolean("evidence_attached").notNull().default(false),
    interruptId: text("interrupt_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("threads_sandbox_idx").on(t.sandboxId)],
);

export const hitlDecisions = pgTable(
  "hitl_decisions",
  {
    sandboxId: sandboxRef(),
    threadId: text("thread_id").notNull(),
    interruptId: text("interrupt_id").notNull(),
    decision: jsonb("decision").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(), // processing | done | failed
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.interruptId] })],
);

export const traceEvents = pgTable(
  "trace_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sandboxId: sandboxRef(),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    node: text("node").notNull(),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("trace_thread_idx").on(t.sandboxId, t.threadId)],
);

export const redteamEvents = pgTable(
  "redteam_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sandboxId: sandboxRef(),
    threadId: text("thread_id"),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("redteam_sandbox_idx").on(t.sandboxId)],
);

/** Daily counters for LLM quota protection (global, per sandbox, per IP). Not sandbox-scoped. */
export const usageCounters = pgTable(
  "usage_counters",
  {
    key: text("key").notNull(),
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.day] })],
);
