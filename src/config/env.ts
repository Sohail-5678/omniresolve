/**
 * Server-side environment, parsed once with zod.
 * Secrets have no production fallback: a missing secret in production throws at first use.
 * Never import this from a client component.
 */
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  APPROVAL_SIGNING_SECRET: z.string().min(32).optional(),
  CRON_SECRET: z.string().min(8).optional(),
  GLOBAL_DAILY_LLM_CALLS: z.coerce.number().int().positive().default(800),
  AUTO_REFUND_LIMIT_CENTS_OVERRIDE: z.coerce.number().int().positive().optional(),
  DEFAULT_MODE: z.enum(["replay", "live"]).default("replay"),
  LLM_BASE_URL: z.string().url().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  NODE_ENV: z.string().default("development"),
});

type Env = z.infer<typeof schema>;

function blankToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) out[k] = v === "" ? undefined : v;
  return out;
}

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(blankToUndefined(process.env));
  return cached;
}

/** Test hook: forget the parsed env so tests can change process.env. */
export function resetEnvCache() {
  cached = null;
}

const DEV_SECRETS = {
  SESSION_SECRET: "dev-only-session-secret-not-for-production-0001",
  APPROVAL_SIGNING_SECRET: "dev-only-approval-signing-secret-not-for-prod-01",
  CRON_SECRET: "dev-only-cron-secret",
} as const;

export function secret(name: keyof typeof DEV_SECRETS): string {
  const value = env()[name];
  if (value) return value;
  if (env().NODE_ENV === "production") {
    throw new Error(`${name} is not set. Add it to the Vercel project environment.`);
  }
  return DEV_SECRETS[name];
}

export function databaseUrl(): string {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  return url;
}

export function commitSha(): string {
  return env().VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
}
