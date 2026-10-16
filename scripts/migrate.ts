/**
 * Idempotent, additive migrations: Drizzle SQL migrations, LangGraph checkpoint tables
 * (PostgresSaver.setup, run once here rather than per request), then the seed template.
 * Runs on every Vercel build (npm run vercel-build) and locally via `npm run db:migrate`.
 */
import { loadEnv } from "./lib/load-env";
loadEnv();

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool, dbFromPool } from "@/db/client";
import { ensureTemplate } from "@/lib/seed/template";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[migrate] DATABASE_URL not set — skipping migrations (build continues).");
    return;
  }
  const pool = createPool(url, 2);
  try {
    const db = dbFromPool(pool);
    const t0 = Date.now();
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    console.log(`[migrate] schema up to date (${Date.now() - t0} ms)`);
    const saver = new PostgresSaver(pool);
    await saver.setup();
    console.log("[migrate] LangGraph checkpoint tables ready");
    const { rebuilt } = await ensureTemplate(db);
    console.log(`[migrate] seed template ${rebuilt ? "rebuilt" : "already current"}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
