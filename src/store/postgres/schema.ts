// store/postgres/schema — the canonical Postgres DDL the durable adapters create and
// expect, plus an idempotent `migrate(pool)` the relay runs on startup. This is the
// ONE place the durable schema is defined; the adapters (inbox/registry/invite/
// credential) all target these exact tables + indexes.
//
// CONTENT-BLIND BY CONSTRUCTION: the `inbox` table holds only the opaque `message`
// jsonb + accounting metadata (`handle`, timestamps, `size_bytes`, a monotonic
// `seq`). It does NOT store `recipient_did` — the recipient-DID match happens in
// `Relay.enqueue` against the registry BEFORE the inbox enqueue (a sealed blob bound
// to another recipient can never be parked here), so the inbox never needs the DID
// and stays maximally blind (no routing-identity column beyond `handle`). There is
// NO index on the ciphertext column, ever.

/** The minimal pg `Pool` surface the adapters + migration use. Kept structural (not
 * `import type { Pool } from "pg"`) so the production `pg` Pool AND a `pg-mem` test
 * Pool both satisfy it without coupling the store layer to the driver's class.
 *
 * `connect()` checks out a dedicated client for a multi-statement TRANSACTION (the
 * bound-enforcing inbox enqueue runs SERIALIZABLE so concurrent posts to one handle
 * can't both pass the quota and overshoot). Both the real `pg.Pool` and the pg-mem
 * Pool implement it. */
export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
  connect(): Promise<PgPoolClient>
}

/** A checked-out pooled client (one connection) for a transaction. `release()` returns
 * it to the pool. The structural subset both `pg`'s `PoolClient` and pg-mem satisfy. */
export interface PgPoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
  release(): void
}

/** The `inbox` queue: opaque ciphertext blobs + accounting only. FIFO order is the
 * durable monotonic `seq` (a `bigserial`, survives restart — it replaces the
 * in-memory `seq` counter so ordering is correct across process restarts). The
 * `(handle, expires_at)` index serves the per-handle live-queue + quota reads. */
export const INBOX_DDL = `create table if not exists inbox (
  handle text not null,
  queue_id text primary key,
  message jsonb not null,
  enqueued_at bigint not null,
  expires_at bigint not null,
  size_bytes int not null,
  seq bigserial
)`

export const INBOX_INDEX_DDL = `create index if not exists inbox_handle_expires on inbox (handle, expires_at)`

/** Registrations (the directory). `did` is a PLAIN (non-unique) column so multiple
 * handles may carry the same DID; the by-DID lookup is recency-computed (see the
 * adapter) rather than a stored index, which makes re-registration + shared-DID
 * semantics fall out for free. Re-registration is `ON CONFLICT (handle) DO UPDATE`. */
export const REGISTRATIONS_DDL = `create table if not exists registrations (
  handle text primary key,
  did text not null,
  agent_card jsonb not null,
  key_agreement_pubkey text,
  registered_at bigint not null
)`

export const REGISTRATIONS_INDEX_DDL = `create index if not exists registrations_did on registrations (did)`

/** Invites: a token → remaining-uses counter. Single-use ⇒ remaining=1. Consume
 * decrements; deleted at 0. */
export const INVITES_DDL = `create table if not exists invites (
  token text primary key,
  remaining int not null
)`

/** Credentials: handle → its current (inboxAuth, sendCredential) pair. Rotation is
 * `ON CONFLICT (handle) DO UPDATE`, which atomically replaces the old pair; the
 * unique reverse indexes on `inbox_auth` + `send_credential` give the reverse
 * lookups (inboxAuth → handle, sendCredential → handle) AND mean the superseded
 * tokens immediately stop resolving. */
export const CREDENTIALS_DDL = `create table if not exists credentials (
  handle text primary key,
  inbox_auth text not null,
  send_credential text not null
)`

export const CREDENTIALS_INBOX_AUTH_INDEX_DDL = `create unique index if not exists credentials_inbox_auth on credentials (inbox_auth)`

export const CREDENTIALS_SEND_CREDENTIAL_INDEX_DDL = `create unique index if not exists credentials_send_credential on credentials (send_credential)`

/** Every DDL statement, in dependency-safe order (tables before their indexes). All
 * are `create … if not exists`, so running the whole list is idempotent. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  INBOX_DDL,
  INBOX_INDEX_DDL,
  REGISTRATIONS_DDL,
  REGISTRATIONS_INDEX_DDL,
  INVITES_DDL,
  CREDENTIALS_DDL,
  CREDENTIALS_INBOX_AUTH_INDEX_DDL,
  CREDENTIALS_SEND_CREDENTIAL_INDEX_DDL,
]

/** Run the schema migration idempotently against `pool`. The relay calls this on
 * startup (every boot); because every statement is `create … if not exists`, a
 * re-run on an already-provisioned database is a no-op. */
export async function migrate(pool: PgPool): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await pool.query(stmt)
  }
}
