// pg-inbox-atomic.test — RF4: the PgInboxStore enqueue is an ATOMIC, bound-enforcing
// SERIALIZABLE transaction (prune → count/sum → conditional insert in one txn), so two
// concurrent posts to one handle can't both pass the quota and overshoot. The exact
// cap behavior + distinct quota reasons are covered hermetically by the dual-backend
// parity suite (store.test.ts) over pg-mem; THIS file covers the parts pg-mem cannot
// exercise (it is single-threaded so it never raises a real serialization failure):
//   - a serialization failure (SQLSTATE 40001) is rolled back and RETRIED, and a retry
//     that succeeds inserts exactly once;
//   - retries are bounded — a persistently-conflicting txn eventually propagates 40001;
//   - a NON-serialization error propagates immediately (no retry) after a rollback;
//   - a rollback that itself throws does not mask the original error.
import { describe, expect, it } from "vitest"

import { PgInboxStore } from "../store/postgres/inbox"
import type { PgPool, PgPoolClient } from "../store/postgres/schema"
import type { A2AMessage } from "../types"

const BOUNDS = { maxMessages: 10, maxBytes: 1_000_000 }

function msg(ct = "ct"): A2AMessage {
  return { messageId: "m1", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: "did:key:zB" } }] }
}

const ENQ = { handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 1000, sizeBytes: 10 }

/** Build a serialization_failure error exactly as `pg` surfaces it (`.code === 40001`). */
function serializationError(): Error & { code: string } {
  return Object.assign(new Error("could not serialize access"), { code: "40001" })
}

/** A scripted fake Pool: each checked-out client records the SQL verbs it runs, and a
 * per-call hook can throw at `commit` (or any verb) to drive the retry/error paths. The
 * `inserts` array counts committed inserts so a retry-then-succeed inserts exactly once. */
interface FakePoolControl {
  /** Total `connect()` calls = transaction attempts. */
  attempts: number
  /** SQL verbs seen across all attempts (lowercased first word). */
  verbs: string[]
  /** Committed inserts (a successful txn pushes one). */
  inserts: number
  pool: PgPool
}

function makeFakePool(opts: {
  /** Throw this from `commit` on attempts 1..failCommits (then succeed). */
  failCommits?: number
  /** If set, throw this (non-40001) once at the first `commit`. */
  throwAtCommit?: () => Error
  /** If true, the client's `rollback` itself throws (to cover rollbackQuietly's catch). */
  rollbackThrows?: boolean
}): FakePoolControl {
  const ctrl: FakePoolControl = { attempts: 0, verbs: [], inserts: 0, pool: null as unknown as PgPool }
  let pendingInsert = false
  ctrl.pool = {
    async query() {
      throw new Error("fake pool: direct query() not used by enqueue (it uses connect())")
    },
    async connect(): Promise<PgPoolClient> {
      ctrl.attempts++
      const thisAttempt = ctrl.attempts
      pendingInsert = false
      return {
        async query(text: string) {
          const verb = text.trim().split(/\s+/)[0].toLowerCase()
          ctrl.verbs.push(verb)
          if (verb === "insert") {
            pendingInsert = true
          }
          if (verb === "rollback" && opts.rollbackThrows) {
            throw new Error("rollback failed (broken connection)")
          }
          if (verb === "commit") {
            if (opts.throwAtCommit && thisAttempt === 1) {
              throw opts.throwAtCommit()
            }
            if (opts.failCommits && thisAttempt <= opts.failCommits) {
              throw serializationError()
            }
            if (pendingInsert) ctrl.inserts++
          }
          // `select count/sum` → return an under-cap aggregate so the insert path runs.
          if (verb === "select") {
            return { rows: [{ n: 0, bytes: 0 }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
        release() {
          /* no pooled resource to return in the fake */
        },
      }
    },
  }
  return ctrl
}

describe("RF4 — PgInboxStore atomic enqueue: serialization-failure retry semantics", () => {
  it("retries on a 40001 serialization failure and succeeds (inserting exactly once)", async () => {
    // First commit throws 40001; the second attempt commits cleanly.
    const ctrl = makeFakePool({ failCommits: 1 })
    const store = new PgInboxStore(ctrl.pool, BOUNDS)
    const res = await store.enqueue(ENQ)
    expect(res.ok).toBe(true)
    expect(ctrl.attempts).toBe(2) // one failed attempt + one success
    expect(ctrl.inserts).toBe(1) // the message landed exactly once (no double-insert)
    // The first (failed) attempt rolled back; the transaction used SERIALIZABLE.
    expect(ctrl.verbs).toContain("rollback")
    expect(ctrl.verbs.filter((v) => v === "begin")).toHaveLength(2)
  })

  it("bounds the retries — a persistent serialization failure eventually propagates 40001", async () => {
    // Every commit throws 40001 → after MAX_ENQUEUE_ATTEMPTS the error propagates.
    const ctrl = makeFakePool({ failCommits: 99 })
    const store = new PgInboxStore(ctrl.pool, BOUNDS)
    await expect(store.enqueue(ENQ)).rejects.toMatchObject({ code: "40001" })
    expect(ctrl.attempts).toBe(5) // MAX_ENQUEUE_ATTEMPTS
    expect(ctrl.inserts).toBe(0)
  })

  it("a non-serialization error propagates immediately (no retry) after a rollback", async () => {
    const ctrl = makeFakePool({ throwAtCommit: () => new Error("disk full") })
    const store = new PgInboxStore(ctrl.pool, BOUNDS)
    await expect(store.enqueue(ENQ)).rejects.toThrow("disk full")
    expect(ctrl.attempts).toBe(1) // NO retry for a non-40001 error
    expect(ctrl.verbs).toContain("rollback")
  })

  it("a rollback that itself throws does not mask the original error", async () => {
    // The commit throws a non-40001 error AND the subsequent rollback throws too; the
    // ORIGINAL error must still surface (rollbackQuietly swallows the rollback failure).
    const ctrl = makeFakePool({ throwAtCommit: () => new Error("original failure"), rollbackThrows: true })
    const store = new PgInboxStore(ctrl.pool, BOUNDS)
    await expect(store.enqueue(ENQ)).rejects.toThrow("original failure")
    expect(ctrl.attempts).toBe(1)
  })
})
