-- Idempotency keys are scoped per sandbox: (sandbox_id, key) instead of a global key.
ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_pkey";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_sandbox_id_key_pk" PRIMARY KEY("sandbox_id","key");
