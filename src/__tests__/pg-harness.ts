// __tests__/pg-harness — the shared hermetic Postgres test harness. Every Postgres
// adapter / parity / restart test builds its in-process database through here, so the
// pg-mem bootstrap (and its one quirk) lives in exactly one place.
//
// NOT a *.test.ts file (no tests) — a helper imported by the suites. It is excluded
// from coverage like the rest of src/__tests__/**.
import { randomBytes } from "node:crypto"

import { Pool } from "pg"
import { newDb } from "pg-mem"
import type { IMemoryDb } from "pg-mem"

import type { PgPool } from "../store/postgres/schema"
import { migrate } from "../store/postgres/schema"

/** A pg-mem-backed database handle: the in-process db + a `pg`-API-compatible Pool
 * factory over it. A fresh pool over the SAME db retains all rows — that is the
 * mechanism the simulated-restart tests use (build relay #2 over a new pool on the
 * same db and assert state survived). */
export interface PgMemHandle {
  db: IMemoryDb
  /** Build a fresh `pg`-compatible Pool over this same db. */
  newPool(): PgPool
}

/** Create a fresh, empty pg-mem database.
 *
 * `noAstCoverageCheck: true` — pg-mem's default strict mode rejects the schema's
 * `create table if not exists (...)` statements (inline `not null` / `primary key`
 * constraints) when run through the Pool adapter; that is an AST-coverage limitation
 * of pg-mem, NOT a real SQL incompatibility (production Postgres accepts the DDL
 * natively). Relaxing the check is purely a test-harness concern and changes nothing
 * about the DDL the adapters run. */
export function makePgMem(): PgMemHandle {
  const db = newDb({ noAstCoverageCheck: true })
  return {
    db,
    newPool(): PgPool {
      const { Pool } = db.adapters.createPg()
      return new Pool() as unknown as PgPool
    },
  }
}

/** Create a pg-mem database, run the schema migration, and return a connected pool +
 * the handle (for building further pools over the same db). The common per-test
 * setup for the adapter suites. */
export async function migratedPgMem(): Promise<{ pool: PgPool; handle: PgMemHandle }> {
  const handle = makePgMem()
  const pool = handle.newPool()
  await migrate(pool)
  return { pool, handle }
}

/** The env var that opts a run into the real-Postgres suite. Unset ⇒ the suite is
 * skipped (pg-mem is not real Postgres: it accepts SQL the real server rejects). */
export const REAL_PG_ENV = "RELAY_TEST_DATABASE_URL"

/** A real-Postgres handle isolated in its own throwaway schema. */
export interface RealPgHandle {
  /** The schema this handle's pools are pinned to via `search_path`. */
  schema: string
  /** Build a fresh pool pinned to the isolated schema (a new pool over the same
   * schema models a process restart). Pools are tracked and closed by `cleanup`. */
  newPool(): PgPool
  /** Close every pool and drop the schema. */
  cleanup(): Promise<void>
}

/** Create an isolated schema on the real database named by RELAY_TEST_DATABASE_URL,
 * run the production migration in it, and return the handle. Each caller gets its own
 * schema, so suites never see each other's rows. */
export async function createRealPg(databaseUrl: string): Promise<RealPgHandle> {
  const schema = `relay_test_${randomBytes(6).toString("hex")}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`create schema ${schema}`)
  const pools: Pool[] = []
  const handle: RealPgHandle = {
    schema,
    newPool(): PgPool {
      const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
      pools.push(pool)
      return pool as unknown as PgPool
    },
    async cleanup(): Promise<void> {
      await Promise.all(pools.map((p) => p.end()))
      await admin.query(`drop schema if exists ${schema} cascade`)
      await admin.end()
    },
  }
  try {
    await migrate(handle.newPool())
  } catch (err) {
    await handle.cleanup()
    throw err
  }
  return handle
}
