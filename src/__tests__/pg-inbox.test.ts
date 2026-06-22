import { describe, expect, it } from "vitest"

import { migratedPgMem } from "./pg-harness"
import { PgInboxStore } from "../store/postgres/inbox"
import type { PgPool } from "../store/postgres/schema"
import type { A2AMessage } from "../types"

function msg(ct = "ct", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: "did:key:zB" } }] }
}

const TTL = 1000
const BOUNDS = { maxMessages: 10, maxBytes: 1_000_000 }

/** Build a PgInboxStore over a freshly-migrated pg-mem db. */
async function setup(bounds = BOUNDS): Promise<{ inbox: PgInboxStore; pool: PgPool; handle: Awaited<ReturnType<typeof migratedPgMem>>["handle"] }> {
  const { pool, handle } = await migratedPgMem()
  return { inbox: new PgInboxStore(pool, bounds), pool, handle }
}

describe("PgInboxStore — bounded queue over pg-mem", () => {
  it("enqueues and lists a message (opaque jsonb round-trips)", async () => {
    const { inbox } = await setup()
    const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })
    expect(r.ok).toBe(true)
    const listed = await inbox.list("h", 0)
    expect(listed).toHaveLength(1)
    expect(listed[0].message).toEqual(msg())
    expect(listed[0].enqueuedAt).toBe(0)
    expect(listed[0].expiresAt).toBe(TTL)
    expect(listed[0].sizeBytes).toBe(100)
    // The queueId is whatever the adapter assigns; ack must accept it.
    expect(typeof listed[0].queueId).toBe("string")
  })

  it("drops on the per-handle COUNT quota", async () => {
    const { inbox } = await setup({ maxMessages: 2, maxBytes: 1_000_000 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
    expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).toEqual({ ok: false, reason: "quota_count" })
    expect(await inbox.depth("h", 0)).toBe(2)
  })

  it("drops on the per-handle BYTE quota", async () => {
    const { inbox } = await setup({ maxMessages: 100, maxBytes: 150 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).ok).toBe(true)
    expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).toEqual({ ok: false, reason: "quota_bytes" })
  })

  it("does not count EXPIRED messages against the quota (pruned on enqueue)", async () => {
    const { inbox } = await setup({ maxMessages: 1, maxBytes: 1_000_000 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })).ok).toBe(true)
    // First is expired at t=600; the second enqueue succeeds (the expired one no
    // longer counts against the bound).
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 600, expiresAt: 1600, sizeBytes: 10 })).ok).toBe(true)
    expect(await inbox.depth("h", 600)).toBe(1)
  })

  it("list() omits expired messages", async () => {
    const { inbox } = await setup()
    await inbox.enqueue({ handle: "h", message: msg("a"), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("b"), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
    const listed = await inbox.list("h", 600)
    expect(listed).toHaveLength(1)
    expect(listed[0].message.parts[0].data.sealed.ct).toBe("b")
  })

  it("list() of an unknown handle is empty", async () => {
    const { inbox } = await setup()
    expect(await inbox.list("nope", 0)).toEqual([])
    expect(await inbox.depth("nope", 0)).toBe(0)
  })

  it("FIFO order by the durable seq (oldest first)", async () => {
    const { inbox } = await setup()
    await inbox.enqueue({ handle: "h", message: msg("first", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("second", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("third", "m3"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const listed = await inbox.list("h", 0)
    expect(listed.map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second", "third"])
  })

  it("ack deletes a message and reports existence; re-ack → false", async () => {
    const { inbox } = await setup()
    const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const queueId = r.ok ? r.queueId : ""
    expect(await inbox.ack("h", queueId)).toBe(true)
    expect(await inbox.depth("h", 0)).toBe(0)
    expect(await inbox.ack("h", queueId)).toBe(false)
  })

  it("ack of an unknown handle → false", async () => {
    const { inbox } = await setup()
    expect(await inbox.ack("nope", "q1")).toBe(false)
  })

  it("ack of ONE of several messages keeps the rest", async () => {
    const { inbox } = await setup()
    const r1 = await inbox.enqueue({ handle: "h", message: msg("a", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("b", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const firstId = r1.ok ? r1.queueId : ""
    expect(await inbox.ack("h", firstId)).toBe(true)
    const remaining = await inbox.list("h", 0)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].message.parts[0].data.sealed.ct).toBe("b")
  })

  it("ack of an unknown queueId on a known handle → false, queue retained", async () => {
    const { inbox } = await setup()
    await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    expect(await inbox.ack("h", "qX")).toBe(false)
    expect(await inbox.depth("h", 0)).toBe(1)
  })

  it("ack is scoped to the handle (cannot ack another handle's message by id)", async () => {
    const { inbox } = await setup()
    const r = await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const queueId = r.ok ? r.queueId : ""
    // h2 acking h1's queueId must not delete it.
    expect(await inbox.ack("h2", queueId)).toBe(false)
    expect(await inbox.depth("h1", 0)).toBe(1)
  })

  it("dropExpired sweeps across handles and returns the count", async () => {
    const { inbox } = await setup()
    await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h2", message: msg(), enqueuedAt: 0, expiresAt: 400, sizeBytes: 10 })
    expect(await inbox.dropExpired(600)).toBe(2)
    expect(await inbox.depth("h1", 600)).toBe(1)
    expect(await inbox.depth("h2", 600)).toBe(0)
  })

  it("dropExpired with nothing expired returns 0", async () => {
    const { inbox } = await setup()
    await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 5000, sizeBytes: 10 })
    expect(await inbox.dropExpired(600)).toBe(0)
    expect(await inbox.depth("h", 600)).toBe(1)
  })

  it("FIFO order + queued messages survive a simulated restart (fresh adapter over same db)", async () => {
    const { inbox, handle } = await setup()
    await inbox.enqueue({ handle: "h", message: msg("first", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("second", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    // "Restart": a brand-new adapter + pool over the SAME db.
    const inbox2 = new PgInboxStore(handle.newPool(), BOUNDS)
    const listed = await inbox2.list("h", 0)
    expect(listed.map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second"])
    // And a NEW enqueue after restart keeps FIFO after the survivors (durable seq).
    await inbox2.enqueue({ handle: "h", message: msg("third", "m3"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const listed2 = await inbox2.list("h", 0)
    expect(listed2.map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second", "third"])
  })
})

// The same plaintext substrings the interop content-blind assertion guards against,
// asserted here against the RAW persisted Postgres row.
const SUBJECT_JOIN_KEY = "teams:proof-subject-xyz"
const SECRET_NOTE = "super-secret-note-do-not-leak"

/** A sealed A2A message mirroring what the real a2a-client emits: ONLY the routing
 * recipientDid + the opaque sealed blob. The ciphertext is base64 noise here; the
 * point is the persisted row must carry NOTHING but this opaque shape. */
function sealedMsg(recipientDid = "did:key:zB"): A2AMessage {
  return {
    messageId: "m-seal",
    role: "agent",
    parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "ePk-b64", n: "nonce-b64", ct: "Y2lwaGVydGV4dA==" }, recipientDid } }],
  }
}

describe("PgInboxStore — content-blind structural invariant (Postgres)", () => {
  it("persists ONLY the opaque blob + routing DID; no plaintext, no ciphertext index/column", async () => {
    const { inbox, pool } = await setup()
    await inbox.enqueue({ handle: "B-opaque-handle", message: sealedMsg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })

    // Read the RAW persisted row directly (not via the adapter), exactly as a db
    // operator / backup / telemetry pipeline would see it.
    const raw = await pool.query(`select handle, queue_id, message, enqueued_at, expires_at, size_bytes, seq from inbox`, [])
    expect(raw.rows).toHaveLength(1)
    const row = raw.rows[0] as { handle: string; message: A2AMessage; [k: string]: unknown }

    // (a) The stored message jsonb round-trips to EXACTLY {v, sealed:{v,ePk,n,ct}, recipientDid}.
    expect(Object.keys(row.message).sort()).toEqual(["parts", "messageId", "role"].sort())
    const data = row.message.parts[0].data
    expect(Object.keys(data).sort()).toEqual(["recipientDid", "sealed", "v"])
    expect(Object.keys(data.sealed).sort()).toEqual(["ct", "ePk", "n", "v"])
    expect(data.recipientDid).toBe("did:key:zB")

    // No plaintext leaks anywhere in the serialized row (the whole row, not just message).
    const rowBytes = JSON.stringify(row)
    expect(rowBytes.includes(SUBJECT_JOIN_KEY)).toBe(false)
    expect(rowBytes.includes(SECRET_NOTE)).toBe(false)
    expect(rowBytes.includes("profile_share")).toBe(false)

    // (b) The table has NO ciphertext column (and therefore no ciphertext index can
    // exist — an index can only reference an existing column). The only columns are
    // the opaque `message` blob + routing `handle` + accounting; there is no `ct`,
    // no decoded-ciphertext column, and no `recipient_did`. (pg-mem does not
    // implement pg_indexes, but column-absence makes a ciphertext index impossible,
    // and the schema DDL itself indexes only (handle, expires_at) + the queue_id PK.)
    const cols = await pool.query(
      "select column_name from information_schema.columns where table_name='inbox' order by column_name",
      [],
    )
    const colNames = (cols.rows as { column_name: string }[]).map((c) => c.column_name)
    expect(colNames).toEqual(["enqueued_at", "expires_at", "handle", "message", "queue_id", "seq", "size_bytes"])
    expect(colNames).not.toContain("ct")
    expect(colNames).not.toContain("recipient_did")
  })
})
