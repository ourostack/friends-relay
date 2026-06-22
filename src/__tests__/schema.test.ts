import { describe, expect, it } from "vitest"

import { migratedPgMem, makePgMem } from "./pg-harness"
import { migrate, SCHEMA_STATEMENTS } from "../store/postgres/schema"
import type { PgPool } from "../store/postgres/schema"

/** Read the column names of a table from pg-mem's information_schema. */
async function columns(pool: PgPool, table: string): Promise<string[]> {
  const res = await pool.query(
    "select column_name from information_schema.columns where table_name=$1 order by column_name",
    [table],
  )
  return (res.rows as { column_name: string }[]).map((r) => r.column_name)
}

/** Read the public table names from pg-mem's information_schema. */
async function tables(pool: PgPool): Promise<string[]> {
  const res = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name",
    [],
  )
  return (res.rows as { table_name: string }[]).map((r) => r.table_name)
}

describe("postgres schema migration", () => {
  it("creates all four tables", async () => {
    const { pool } = await migratedPgMem()
    expect(await tables(pool)).toEqual(["credentials", "inbox", "invites", "registrations"])
  })

  it("inbox holds ONLY the opaque blob + accounting (no recipient_did column — content-blind)", async () => {
    const { pool } = await migratedPgMem()
    const cols = await columns(pool, "inbox")
    expect(cols).toEqual(["enqueued_at", "expires_at", "handle", "message", "queue_id", "seq", "size_bytes"])
    // The content-blind invariant at the schema level: there is NO recipient_did
    // column (the DID match is pre-store in Relay.enqueue) and NO ciphertext column.
    expect(cols).not.toContain("recipient_did")
    expect(cols).not.toContain("ct")
  })

  it("registrations carry handle/did/agent_card/key_agreement_pubkey/registered_at", async () => {
    const { pool } = await migratedPgMem()
    expect(await columns(pool, "registrations")).toEqual([
      "agent_card",
      "did",
      "handle",
      "key_agreement_pubkey",
      "registered_at",
    ])
  })

  it("invites carry token + remaining; credentials carry handle + the pair", async () => {
    const { pool } = await migratedPgMem()
    expect(await columns(pool, "invites")).toEqual(["remaining", "token"])
    expect(await columns(pool, "credentials")).toEqual(["handle", "inbox_auth", "send_credential"])
  })

  it("migrate is idempotent (re-running on an already-migrated db is a no-op)", async () => {
    const { pool } = await migratedPgMem()
    // Second migrate over the same pool/db must not throw (create … if not exists).
    await expect(migrate(pool)).resolves.toBeUndefined()
    expect(await tables(pool)).toEqual(["credentials", "inbox", "invites", "registrations"])
  })

  it("exposes every DDL statement in the canonical list", () => {
    // The migration runs exactly the published statement list (4 tables + 4 indexes).
    expect(SCHEMA_STATEMENTS).toHaveLength(8)
    expect(SCHEMA_STATEMENTS.every((s) => s.includes("if not exists"))).toBe(true)
  })

  it("a fresh pool over the same db sees the migrated schema (restart mechanism)", async () => {
    const { handle } = await migratedPgMem()
    // Build a SECOND pool over the SAME db — the simulated-restart primitive.
    const pool2 = handle.newPool()
    expect(await tables(pool2)).toEqual(["credentials", "inbox", "invites", "registrations"])
  })

  it("makePgMem yields an empty db until migrated", async () => {
    const handle = makePgMem()
    const pool = handle.newPool()
    expect(await tables(pool)).toEqual([])
  })
})
