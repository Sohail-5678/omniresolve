/** Migrates the test database once per run (schema + checkpoint tables), serialized with an advisory lock. */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://omni@localhost:54329/omniresolve_test";
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('omniresolve_test_setup'))");
    await migrate(drizzle(pool), { migrationsFolder: "src/db/migrations" });
    await new PostgresSaver(pool).setup();
    // The seed template is created lazily by createSandbox() inside the tests' own module graph.
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('omniresolve_test_setup'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}
