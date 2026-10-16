/**
 * One pg Pool per server instance (module-level singleton), shared by Drizzle and the
 * LangGraph checkpointer. Pool max 3 because Neon's free tier and serverless fan-out
 * punish large pools; use the *pooled* Neon URL in production.
 */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";
import { databaseUrl } from "@/config/env";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the db itself or an open transaction. */
export type Queryable = Db | Tx;

type Holder = { pool: pg.Pool; db: Db; url: string };

const globalForDb = globalThis as unknown as { __omniDb?: Holder };

export function createPool(url: string, max = 3): pg.Pool {
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  return pool;
}

export function getDbHolder(): Holder {
  const url = databaseUrl();
  if (!globalForDb.__omniDb || globalForDb.__omniDb.url !== url) {
    const pool = createPool(url);
    if (process.env.VERCEL) attachDatabasePool(pool);
    globalForDb.__omniDb = { pool, db: drizzle(pool, { schema }), url };
  }
  return globalForDb.__omniDb;
}

export function getDb(): Db {
  return getDbHolder().db;
}

export function getPool(): pg.Pool {
  return getDbHolder().pool;
}

export function dbFromPool(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export { schema };
