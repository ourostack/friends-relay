// store/postgres/inbox — the durable Postgres InboxStore adapter. It reproduces
// MemoryInboxStore's bounded-queue semantics EXACTLY against the Unit-0 `inbox`
// table, using parameterized `pg` queries (no string interpolation of values).
//
// CONTENT-BLIND: the only thing persisted per message is the opaque `message` jsonb
// + accounting metadata (handle, timestamps, size_bytes) and a durable monotonic
// `seq` (the FIFO key). There is NO recipient_did column and NO ciphertext index —
// the table can never be queried by content. FIFO order is `order by seq` so it is
// correct across process restarts (the in-memory `seq` counter would reset; the
// `bigserial` does not).
import { randomUUID } from "node:crypto"

import type { InboxBounds } from "../memory"
import type { EnqueueResult, InboxStore } from "../interfaces"
import type { PgPool, PgPoolClient } from "./schema"
import type { A2AMessage, QueuedMessage } from "../../types"

/** PostgreSQL's `serialization_failure` SQLSTATE — raised under SERIALIZABLE when a
 * concurrent transaction makes this one's reads/writes non-serializable. The correct
 * response is to roll back and RETRY (the conflict is transient). */
const SERIALIZATION_FAILURE = "40001"

/** Max attempts for the SERIALIZABLE enqueue before giving up. A handful is plenty —
 * a contended handle resolves in 1–2 retries; this just bounds a pathological loop. */
const MAX_ENQUEUE_ATTEMPTS = 5

/** Whether an unknown thrown value is a Postgres serialization failure (so we retry). */
function isSerializationFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === SERIALIZATION_FAILURE
}

/** A row shape as read back from the `inbox` table. `message` is the opaque jsonb
 * (pg returns it as a parsed object); the bigints come back as JS numbers under
 * pg-mem and as strings under the real `pg` driver for very large values — the
 * accounting numbers here are well within Number.MAX_SAFE_INTEGER (ms epochs / byte
 * counts), so a Number() coercion is exact. */
interface InboxRow {
  queue_id: string
  message: A2AMessage
  enqueued_at: number | string
  expires_at: number | string
  size_bytes: number | string
}

export class PgInboxStore implements InboxStore {
  constructor(
    private readonly pool: PgPool,
    private readonly bounds: InboxBounds,
  ) {}

  async enqueue(input: {
    handle: string
    message: A2AMessage
    enqueuedAt: number
    expiresAt: number
    sizeBytes: number
  }): Promise<EnqueueResult> {
    // The bound-enforcing enqueue MUST be atomic: prune → count/sum → insert as three
    // separate autocommit statements let two concurrent posts to one handle both read
    // the same under-cap count/byte-sum and both insert, overshooting the quota. So the
    // whole sequence runs in ONE SERIALIZABLE transaction — Postgres aborts a
    // non-serializable interleaving with `40001`, which we roll back and RETRY. (Bare
    // `FOR UPDATE` is insufficient: an empty handle has no rows to lock, so the cap
    // race on a fresh handle is a phantom that only SERIALIZABLE detects.)
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect()
      try {
        const result = await this.enqueueTxn(client, input)
        return result
      } catch (err) {
        await rollbackQuietly(client)
        if (isSerializationFailure(err) && attempt < MAX_ENQUEUE_ATTEMPTS) {
          continue // transient conflict — retry the whole transaction
        }
        throw err
      } finally {
        client.release()
      }
    }
  }

  /** One attempt of the atomic enqueue on a checked-out client. BEGIN SERIALIZABLE →
   * prune expired (drop-on-enqueue) → read live count+bytes (FOR UPDATE so the real
   * backend serializes concurrent posts to this handle) → enforce both bounds
   * (count-first, exact reasons — mirrors MemoryInboxStore) → conditional INSERT →
   * COMMIT. A quota rejection still COMMITs (the prune is a legitimate, committable
   * side effect); only an error rolls back (handled by the caller). */
  private async enqueueTxn(
    client: PgPoolClient,
    input: { handle: string; message: A2AMessage; enqueuedAt: number; expiresAt: number; sizeBytes: number },
  ): Promise<EnqueueResult> {
    await client.query(`begin isolation level serializable`)
    await client.query(`delete from inbox where handle = $1 and expires_at <= $2`, [input.handle, input.enqueuedAt])
    const agg = await client.query(
      `select count(*)::int as n, coalesce(sum(size_bytes), 0)::int as bytes
       from inbox where handle = $1 and expires_at > $2 for update`,
      [input.handle, input.enqueuedAt],
    )
    const { n, bytes } = agg.rows[0] as { n: number; bytes: number }

    if (n >= this.bounds.maxMessages) {
      await client.query(`commit`)
      return { ok: false, reason: "quota_count" }
    }
    if (bytes + input.sizeBytes > this.bounds.maxBytes) {
      await client.query(`commit`)
      return { ok: false, reason: "quota_bytes" }
    }

    const queueId = randomUUID()
    await client.query(
      `insert into inbox (handle, queue_id, message, enqueued_at, expires_at, size_bytes)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.handle, queueId, JSON.stringify(input.message), input.enqueuedAt, input.expiresAt, input.sizeBytes],
    )
    await client.query(`commit`)
    return { ok: true, queueId }
  }

  async list(handle: string, now: number): Promise<QueuedMessage[]> {
    // Prune expired first (drop-on-read), then return the live queue in FIFO order.
    await this.pool.query(`delete from inbox where handle = $1 and expires_at <= $2`, [handle, now])
    const res = await this.pool.query(
      `select queue_id, message, enqueued_at, expires_at, size_bytes
       from inbox where handle = $1 and expires_at > $2 order by seq asc`,
      [handle, now],
    )
    return (res.rows as InboxRow[]).map(rowToQueued)
  }

  async ack(handle: string, queueId: string): Promise<boolean> {
    // `returning queue_id` yields one row per deleted row, so `rows.length` is the
    // exact delete count — always a number (no `rowCount: number | null` dead branch).
    const res = await this.pool.query(
      `delete from inbox where handle = $1 and queue_id = $2 returning queue_id`,
      [handle, queueId],
    )
    return res.rows.length > 0
  }

  async dropExpired(now: number): Promise<number> {
    const res = await this.pool.query(`delete from inbox where expires_at <= $1 returning queue_id`, [now])
    return res.rows.length
  }

  async depth(handle: string, now: number): Promise<number> {
    await this.pool.query(`delete from inbox where handle = $1 and expires_at <= $2`, [handle, now])
    const res = await this.pool.query(
      `select count(*)::int as n from inbox where handle = $1 and expires_at > $2`,
      [handle, now],
    )
    return (res.rows[0] as { n: number }).n
  }
}

/** Roll back the transaction, swallowing any rollback error so it never masks the
 * original failure being handled (a broken connection can make ROLLBACK itself throw;
 * the client is released regardless by the caller's `finally`). */
async function rollbackQuietly(client: PgPoolClient): Promise<void> {
  try {
    await client.query(`rollback`)
  } catch {
    /* the original error is what matters; a failed rollback is not actionable here */
  }
}

/** Map a raw `inbox` row to the QueuedMessage shape the relay returns. */
function rowToQueued(row: InboxRow): QueuedMessage {
  return {
    queueId: row.queue_id,
    message: row.message,
    enqueuedAt: Number(row.enqueued_at),
    expiresAt: Number(row.expires_at),
    sizeBytes: Number(row.size_bytes),
  }
}
