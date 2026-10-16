/**
 * Builds the template sandbox from the deterministic seed and clones it into visitor
 * sandboxes with INSERT … SELECT (one statement per table, inside one transaction),
 * so a new sandbox costs milliseconds instead of re-running the generator.
 */
import { sql, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Db, Queryable } from "@/db/client";
import * as s from "@/db/schema";
import { generateSeed, fixtureRows, SEED_VERSION, TEMPLATE_SANDBOX_ID, type SeedRows } from "./generate";
import type { FixtureSet } from "./fixtures";

/** Tables that hold seeded mock-business data and get cloned per sandbox. */
const SEEDED_TABLES: PgTable[] = [
  s.customers,
  s.orders,
  s.orderItems,
  s.inventory,
  s.charges,
  s.refunds,
  s.storeCredits,
  s.shipments,
  s.tickets,
  s.idCounters,
];

async function insertBatched<T extends Record<string, unknown>>(db: Queryable, table: PgTable, rows: T[]) {
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    if (batch.length) await db.insert(table).values(batch as never);
  }
}

export async function insertSeedRows(
  db: Queryable,
  sandboxId: string,
  rows: Partial<SeedRows> & Omit<SeedRows, "inventory" | "idCounters">,
) {
  const withSb = <T extends object>(list: T[] | undefined) => (list ?? []).map((r) => ({ ...r, sandboxId }));
  await insertBatched(db, s.customers, withSb(rows.customers));
  await insertBatched(db, s.orders, withSb(rows.orders));
  await insertBatched(db, s.orderItems, withSb(rows.orderItems));
  if (rows.inventory) await insertBatched(db, s.inventory, withSb(rows.inventory));
  await insertBatched(db, s.charges, withSb(rows.charges));
  await insertBatched(db, s.refunds, withSb(rows.refunds));
  await insertBatched(db, s.storeCredits, withSb(rows.storeCredits));
  await insertBatched(db, s.shipments, withSb(rows.shipments));
  await insertBatched(db, s.tickets, withSb(rows.tickets));
  if (rows.idCounters) await insertBatched(db, s.idCounters, withSb(rows.idCounters));
}

/** Creates (or rebuilds, when SEED_VERSION changed) the template sandbox. Safe to call concurrently. */
export async function ensureTemplate(db: Db): Promise<{ rebuilt: boolean }> {
  const existing = await db.select().from(s.sandboxes).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID));
  if (existing[0]?.seedVersion === SEED_VERSION) return { rebuilt: false };
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('omniresolve_template'))`);
    const again = await tx.select().from(s.sandboxes).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID));
    if (again[0]?.seedVersion === SEED_VERSION) return { rebuilt: false };
    if (again[0]) await tx.delete(s.sandboxes).where(eq(s.sandboxes.id, TEMPLATE_SANDBOX_ID));
    await tx.insert(s.sandboxes).values({
      id: TEMPLATE_SANDBOX_ID,
      expiresAt: new Date("2999-01-01T00:00:00Z"),
      seedVersion: SEED_VERSION,
      isTemplate: true,
    });
    await insertSeedRows(tx, TEMPLATE_SANDBOX_ID, generateSeed());
    return { rebuilt: true };
  });
}

/** Clones the template's seeded tables into an existing sandbox row. */
export async function cloneTemplateInto(tx: Queryable, sandboxId: string) {
  for (const table of SEEDED_TABLES) {
    const cfg = getTableConfig(table);
    const cols = cfg.columns.map((c) => `"${c.name}"`).filter((c) => c !== `"sandbox_id"`);
    const colList = sql.raw(cols.join(", "));
    const tableName = sql.raw(`"${cfg.name}"`);
    await tx.execute(
      sql`INSERT INTO ${tableName} ("sandbox_id", ${colList}) SELECT ${sandboxId}, ${colList} FROM ${tableName} WHERE "sandbox_id" = ${TEMPLATE_SANDBOX_ID}`,
    );
  }
}

/** Adds an eval scenario's extra customers/orders and inventory overrides to a sandbox. */
export async function applyFixtureOverrides(db: Queryable, sandboxId: string, fx: FixtureSet, idBase = "90") {
  await insertSeedRows(db, sandboxId, fixtureRows(fx, idBase));
  for (const [sku, onHand] of Object.entries(fx.inventory ?? {})) {
    await db.execute(sql`UPDATE inventory SET on_hand = ${onHand} WHERE sandbox_id = ${sandboxId} AND sku = ${sku}`);
  }
}
