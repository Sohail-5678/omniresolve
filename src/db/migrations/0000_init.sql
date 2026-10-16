CREATE TABLE "approval_tokens" (
	"token_id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "breakers" (
	"sandbox_id" text NOT NULL,
	"service" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"open_until" timestamp with time zone,
	CONSTRAINT "breakers_sandbox_id_service_pk" PRIMARY KEY("sandbox_id","service")
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'captured' NOT NULL,
	CONSTRAINT "charges_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"email_masked" text NOT NULL,
	"tier" text NOT NULL,
	"lifetime_value_cents" integer NOT NULL,
	"churn_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"since" date NOT NULL,
	CONSTRAINT "customers_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "fault_settings" (
	"sandbox_id" text NOT NULL,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"mode" text NOT NULL,
	"n" integer,
	"calls" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fault_settings_sandbox_id_service_operation_pk" PRIMARY KEY("sandbox_id","service","operation")
);
--> statement-breakpoint
CREATE TABLE "hitl_decisions" (
	"sandbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"interrupt_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hitl_decisions_thread_id_interrupt_id_pk" PRIMARY KEY("thread_id","interrupt_id")
);
--> statement-breakpoint
CREATE TABLE "id_counters" (
	"sandbox_id" text NOT NULL,
	"prefix" text NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "id_counters_sandbox_id_prefix_pk" PRIMARY KEY("sandbox_id","prefix")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"operation" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"sandbox_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_sandbox_id_sku_pk" PRIMARY KEY("sandbox_id","sku")
);
--> statement-breakpoint
CREATE TABLE "inventory_holds" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"saga_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_holds_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"carrier" text NOT NULL,
	"tracking_no" text NOT NULL,
	"saga_id" text NOT NULL,
	"token_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"saga_id" text,
	"channel" text NOT NULL,
	"preview" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"sandbox_id" text NOT NULL,
	"order_id" text NOT NULL,
	"line" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "order_items_sandbox_id_order_id_line_pk" PRIMARY KEY("sandbox_id","order_id","line")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"order_date" date NOT NULL,
	"promised_date" date NOT NULL,
	"delivered_date" date,
	"status" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"shipping_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	CONSTRAINT "orders_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"saga_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "redteam_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"token_id" text,
	"saga_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "replacement_drafts" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"hold_id" text,
	"saga_id" text NOT NULL,
	"token_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replacement_drafts_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "saga_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text NOT NULL,
	"pivot_seq" integer,
	"ticket_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saga_steps" (
	"saga_id" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"request" jsonb,
	"response" jsonb,
	"error" text,
	"detail" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "saga_steps_saga_id_seq_pk" PRIMARY KEY("saga_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_hash" text,
	"seed_version" integer NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text NOT NULL,
	"carrier" text NOT NULL,
	"tracking_no" text NOT NULL,
	"status" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "shipments_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "store_credits" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"order_id" text,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"token_id" text,
	"saga_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_credits_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"scenario_id" text,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"mode" text NOT NULL,
	"evidence_attached" boolean DEFAULT false NOT NULL,
	"interrupt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_notes" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_notes_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"sandbox_id" text NOT NULL,
	"id" text NOT NULL,
	"customer_id" text NOT NULL,
	"order_id" text,
	"thread_id" text,
	"saga_id" text,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "trace_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"node" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"key" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_key_day_pk" PRIMARY KEY("key","day")
);
--> statement-breakpoint
ALTER TABLE "approval_tokens" ADD CONSTRAINT "approval_tokens_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breakers" ADD CONSTRAINT "breakers_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fault_settings" ADD CONSTRAINT "fault_settings_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_decisions" ADD CONSTRAINT "hitl_decisions_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "id_counters" ADD CONSTRAINT "id_counters_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_holds" ADD CONSTRAINT "inventory_holds_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redteam_events" ADD CONSTRAINT "redteam_events_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_drafts" ADD CONSTRAINT "replacement_drafts_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saga_runs" ADD CONSTRAINT "saga_runs_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saga_steps" ADD CONSTRAINT "saga_steps_saga_id_saga_runs_id_fk" FOREIGN KEY ("saga_id") REFERENCES "public"."saga_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tokens_thread_idx" ON "approval_tokens" USING btree ("sandbox_id","thread_id");--> statement-breakpoint
CREATE INDEX "charges_order_idx" ON "charges" USING btree ("sandbox_id","order_id");--> statement-breakpoint
CREATE INDEX "holds_saga_idx" ON "inventory_holds" USING btree ("sandbox_id","saga_id");--> statement-breakpoint
CREATE INDEX "labels_saga_idx" ON "labels" USING btree ("sandbox_id","saga_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("sandbox_id","customer_id");--> statement-breakpoint
CREATE INDEX "redteam_sandbox_idx" ON "redteam_events" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("sandbox_id","order_id");--> statement-breakpoint
CREATE INDEX "drafts_saga_idx" ON "replacement_drafts" USING btree ("sandbox_id","saga_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saga_plan_uq" ON "saga_runs" USING btree ("sandbox_id","thread_id","plan_hash");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("sandbox_id","order_id");--> statement-breakpoint
CREATE INDEX "threads_sandbox_idx" ON "threads" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "tickets_saga_idx" ON "tickets" USING btree ("sandbox_id","saga_id");--> statement-breakpoint
CREATE INDEX "trace_thread_idx" ON "trace_events" USING btree ("sandbox_id","thread_id");