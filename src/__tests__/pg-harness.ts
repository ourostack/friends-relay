// __tests__/pg-harness — the shared hermetic Postgres test harness. Every Postgres
// adapter / parity / restart test builds its in-process database through here, so the
// pg-mem bootstrap (and its one quirk) lives in exactly one place.
//
// NOT a *.test.ts file (no tests) — a helper imported by the suites. It is excluded
// from coverage like the rest of src/__tests__/**.
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
