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
import type { PgPool } from "./schema"
import type { A2AMessage, QueuedMessage } from "../../types"

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
    // Live-prune the handle's expired rows first, so they don't count against the
    // bound (and are dropped as a side effect) — mirrors MemoryInboxStore.livePrune.
    await this.pool.query(`delete from inbox where handle = $1 and expires_at <= $2`, [input.handle, input.enqueuedAt])

    // Read the live count + total bytes for the quota check.
    const agg = await this.pool.query(
      `select count(*)::int as n, coalesce(sum(size_bytes), 0)::int as bytes from inbox where handle = $1 and expires_at > $2`,
      [input.handle, input.enqueuedAt],
    )
    const { n, bytes } = agg.rows[0] as { n: number; bytes: number }

    if (n >= this.bounds.maxMessages) {
      return { ok: false, reason: "quota_count" }
    }
    if (bytes + input.sizeBytes > this.bounds.maxBytes) {
      return { ok: false, reason: "quota_bytes" }
    }

    const queueId = randomUUID()
    await this.pool.query(
      `insert into inbox (handle, queue_id, message, enqueued_at, expires_at, size_bytes)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.handle, queueId, JSON.stringify(input.message), input.enqueuedAt, input.expiresAt, input.sizeBytes],
    )
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
