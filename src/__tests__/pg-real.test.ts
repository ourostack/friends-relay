// pg-real.test — the Postgres adapters against a REAL Postgres server. pg-mem accepts
// SQL real Postgres rejects (e.g. `FOR UPDATE` on an aggregate), so the hermetic suite
// alone cannot prove the SQL is valid. This suite runs only when RELAY_TEST_DATABASE_URL
// names a database the test user may create schemas in; otherwise it is skipped. Every
// test gets its own throwaway schema (search_path-pinned pools) and drops it afterwards.
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { loadConfig } from "../config"
import { MemoryLogger } from "../logger"
import { SequenceTokenSource } from "../security/tokens"
import { assemblePostgresStores, assembleRelay } from "../server/bootstrap"
import { ADVISORY_LOCK_CLASS_ID, PgInboxStore } from "../store/postgres/inbox"
import { Pool } from "pg"
import { HandleBusyError, isPoolTimeout } from "../store/postgres/schema"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgHandleLifecycleStore } from "../store/postgres/lifecycle"
import { PgRegistryStore } from "../store/postgres/registry"
import { createRealPg, REAL_PG_ENV } from "./pg-harness"
import type { RealPgHandle } from "./pg-harness"
import type { A2AMessage, PublicAgentCard } from "../types"

const DATABASE_URL = process.env[REAL_PG_ENV]
// The dedicated CI job sets RELAY_REQUIRE_REAL_PG: there the suite must RUN, so a
// renamed or dropped database variable fails loudly instead of skipping. (Keyed on its
// own flag, not bare CI, because the pg-mem coverage job also runs in CI without a DB.)
if (process.env.RELAY_REQUIRE_REAL_PG && !DATABASE_URL) {
  throw new Error(`${REAL_PG_ENV} must be set when RELAY_REQUIRE_REAL_PG is set (the real-Postgres suite cannot be skipped silently)`)
}

function msg(ct = "ct", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: "did:key:zB" } }] }
}
const card = (did: string): PublicAgentCard => ({ name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did })

// The concurrency tests queue dozens of sends behind one lock; on a loaded CI runner
// that can exceed the 5 s production default, so they allow far longer.
const SLOW_RUNNER_LOCK_TIMEOUT_MS = 30_000
const TTL = 1000
const BOUNDS = { maxMessages: 10, maxBytes: 1_000_000 }
const enq = (inbox: PgInboxStore, handle: string, o: { at?: number; exp?: number; size?: number; ct?: string } = {}) =>
  inbox.enqueue({ handle, message: msg(o.ct), enqueuedAt: o.at ?? 0, expiresAt: o.exp ?? TTL, sizeBytes: o.size ?? 10 })

describe.skipIf(!DATABASE_URL)("real Postgres", () => {
  let pg: RealPgHandle
  beforeEach(async () => {
    pg = await createRealPg(DATABASE_URL as string)
  })
  afterEach(async () => {
    await pg.cleanup()
  })

  describe("PgInboxStore", () => {
    it("enqueues and lists a message (opaque jsonb round-trips)", async () => {
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS)
      const r = await enq(inbox, "h", { size: 100 })
      expect(r.ok).toBe(true)
      const listed = await inbox.list("h", 0)
      expect(listed).toHaveLength(1)
      expect(listed[0].message).toEqual(msg())
      expect(listed[0].sizeBytes).toBe(100)
    })

    it("drops on the per-handle COUNT quota", async () => {
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 2, maxBytes: 1_000_000 })
      expect((await enq(inbox, "h")).ok).toBe(true)
      expect((await enq(inbox, "h")).ok).toBe(true)
      expect(await enq(inbox, "h")).toEqual({ ok: false, reason: "quota_count" })
      expect(await inbox.depth("h", 0)).toBe(2)
    })

    it("drops on the per-handle BYTE quota", async () => {
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 100, maxBytes: 150 })
      expect((await enq(inbox, "h", { size: 100 })).ok).toBe(true)
      expect(await enq(inbox, "h", { size: 100 })).toEqual({ ok: false, reason: "quota_bytes" })
    })

    it("counts only live messages: expired ones are pruned on enqueue", async () => {
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 1, maxBytes: 1_000_000 })
      expect((await enq(inbox, "h", { exp: 500 })).ok).toBe(true)
      expect((await enq(inbox, "h", { at: 600, exp: 1600 })).ok).toBe(true)
      expect(await inbox.depth("h", 600)).toBe(1)
    })

    it("quota is per handle (another handle's queue does not count)", async () => {
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 1, maxBytes: 1_000_000 })
      expect((await enq(inbox, "h1")).ok).toBe(true)
      expect((await enq(inbox, "h2")).ok).toBe(true)
    })

    it("lists FIFO, omits expired, ack removes one, dropExpired sweeps", async () => {
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS)
      const first = await enq(inbox, "h", { ct: "first" })
      await enq(inbox, "h", { ct: "second" })
      await enq(inbox, "h", { ct: "gone", exp: 500 })
      expect((await inbox.list("h", 600)).map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second"])
      expect(await inbox.ack("h", first.ok ? first.queueId : "")).toBe(true)
      expect(await inbox.ack("h", first.ok ? first.queueId : "")).toBe(false)
      expect(await inbox.ack("other", "nope")).toBe(false)
      await enq(inbox, "h2", { exp: 400 })
      expect(await inbox.dropExpired(600)).toBe(1)
      expect(await inbox.depth("h", 600)).toBe(1)
    })

    it("concurrent enqueues to one handle never overshoot the count quota", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 0 })
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 3, maxBytes: 1_000_000 }, { lockTimeoutMs: SLOW_RUNNER_LOCK_TIMEOUT_MS })
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => enq(inbox, "h", { ct: `c${i}` })))
      expect(results.filter((r) => r.ok)).toHaveLength(3)
      expect(await inbox.depth("h", 0)).toBe(3)
    })

    it("30 concurrent sends to an inbox with free space ALL succeed (no 40001 leaking out)", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 0 })
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 1000, maxBytes: 1_000_000 }, { lockTimeoutMs: SLOW_RUNNER_LOCK_TIMEOUT_MS })
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => enq(inbox, "h", { ct: `c${i}` })))
      expect(results.filter((r) => !r.ok)).toEqual([])
      expect(await inbox.depth("h", 0)).toBe(30)
    })

    it.each([
      ["with a registry row", true],
      ["without a registry row", false],
    ])("exact count quota under 30 concurrent sends %s", async (_label, registered) => {
      if (registered) {
        await new PgRegistryStore(pg.newPool()).put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 0 })
      }
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 5, maxBytes: 1_000_000 }, { lockTimeoutMs: SLOW_RUNNER_LOCK_TIMEOUT_MS })
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => enq(inbox, "h", { ct: `c${i}` })))
      expect(results.filter((r) => r.ok)).toHaveLength(5)
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "quota_count")).toBe(true)
      expect(await inbox.depth("h", 0)).toBe(5)
    })

    it("purge removes one handle's queue", async () => {
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS)
      await enq(inbox, "h")
      await enq(inbox, "h")
      await enq(inbox, "other")
      expect(await inbox.purge("h")).toBe(2)
      expect(await inbox.depth("h", 0)).toBe(0)
      expect(await inbox.depth("other", 0)).toBe(1)
    })

    it("an enqueue stuck behind a held per-handle lock gives up as busy (55P03), then works once released", async () => {
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS, { lockTimeoutMs: 200 })
      const holder = await pg.newPool().connect()
      await holder.query("begin")
      await holder.query(`select pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_ID}, hashtext($1))`, ["h"])
      try {
        const started = Date.now()
        expect(await enq(inbox, "h")).toEqual({ ok: false, reason: "busy" })
        expect(Date.now() - started).toBeLessThan(3000)
        // a different handle is not blocked by that lock
        expect((await enq(inbox, "other")).ok).toBe(true)
      } finally {
        await holder.query("rollback")
        holder.release()
      }
      expect((await enq(inbox, "h")).ok).toBe(true)
    })

    it("a send already waiting on the handle lock when it is deregistered is refused, leaving no rows", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 0 })
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS, { requireRegistration: true })
      const holder = await pg.newPool().connect()
      await holder.query("begin")
      await holder.query(`select pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_ID}, hashtext($1))`, ["h"])
      // The send passed the relay's registry check and is now blocked on the lock...
      const send = enq(inbox, "h")
      await new Promise((r) => setTimeout(r, 300))
      // ...while the owner deregisters (registry first, then purge, as Relay.deregister does).
      await reg.remove("h")
      const purge = inbox.purge("h")
      await new Promise((r) => setTimeout(r, 100))
      await holder.query("commit")
      holder.release()
      expect(await send).toEqual({ ok: false, reason: "unknown_handle" })
      await purge
      expect(await inbox.depth("h", 0)).toBe(0)
    })

    it("concurrent sends racing a deregister leave zero rows afterwards", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 0 })
      const inbox = new PgInboxStore(pg.newPool(), { maxMessages: 1000, maxBytes: 1_000_000 }, { requireRegistration: true, lockTimeoutMs: SLOW_RUNNER_LOCK_TIMEOUT_MS })
      const sends = Array.from({ length: 20 }, (_, i) => enq(inbox, "h", { ct: `c${i}` }))
      await new Promise((r) => setTimeout(r, 5))
      await reg.remove("h")
      await inbox.purge("h")
      const results = await Promise.all(sends)
      expect(results.every((r) => r.ok || r.reason === "unknown_handle")).toBe(true)
      expect(await inbox.depth("h", 0)).toBe(0)
    })

    it("a send checked against owner A cannot land in new owner B's inbox (same handle, different DID)", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 1 })
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS, { requireRegistration: true })
      const holder = await pg.newPool().connect()
      await holder.query("begin")
      await holder.query(`select pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_ID}, hashtext($1))`, ["h"])
      // The relay checked registration A, then the send blocks on the handle lock...
      const send = inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10, registration: { did: "did:key:zA", registeredAt: 1 } })
      await new Promise((r) => setTimeout(r, 300))
      // ...A deregisters and B registers the same handle with a different DID.
      await reg.remove("h")
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 2 })
      await holder.query("commit")
      holder.release()
      expect(await send).toEqual({ ok: false, reason: "registration_changed" })
      expect(await inbox.depth("h", 0)).toBe(0)
    })

    it("lifecycle: failing purge leaves everything intact and retryable; B's mail is never lost", async () => {
      const real = pg.newPool()
      let fail = false
      const flaky: typeof real = {
        query: (t, p) => real.query(t, p),
        async connect() {
          const c = await real.connect()
          return {
            release: () => c.release(),
            query: async (t: string, p?: unknown[]) => {
              if (fail && /^delete from inbox where handle = \$1$/.test(t)) {
                fail = false
                throw new Error("injected failure")
              }
              return c.query(t, p)
            },
          }
        },
      }
      const life = new PgHandleLifecycleStore(flaky)
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS, { requireRegistration: true })
      const creds = new PgCredentialStore(pg.newPool())
      expect(await life.register({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 1 })).toBe(true)
      await creds.setCurrent("h", { inboxAuth: "ia", sendCredential: "sc" })
      await enq(inbox, "h", { ct: "a-mail" })
      fail = true
      await expect(life.deregister("h")).rejects.toThrow("injected failure")
      expect(await creds.handleForInboxAuth("ia")).toBe("h")
      expect(await inbox.depth("h", 0)).toBe(1)
      expect(await life.deregister("h")).toBe(true)
      expect(await inbox.depth("h", 0)).toBe(0)
      // B registers right after, receives mail; nothing of A's remains and B's survives.
      await life.register({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 2 })
      expect((await enq(inbox, "h", { ct: "b-mail" })).ok).toBe(true)
      expect((await inbox.list("h", 0)).map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["b-mail"])
    })

    it("register/deregister stuck behind a held handle lock give up as HandleBusyError", async () => {
      const life = new PgHandleLifecycleStore(pg.newPool(), { lockTimeoutMs: 200 })
      const holder = await pg.newPool().connect()
      await holder.query("begin")
      await holder.query(`select pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_ID}, hashtext($1))`, ["h"])
      try {
        await expect(life.register({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 1 })).rejects.toBeInstanceOf(HandleBusyError)
        await expect(life.deregister("h")).rejects.toBeInstanceOf(HandleBusyError)
      } finally {
        await holder.query("rollback")
        holder.release()
      }
    })

    it("a send checked against a replaced registration is reported registration_changed, not unknown_handle", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB"), registeredAt: 2 })
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS, { requireRegistration: true })
      const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10, registration: { did: "did:key:zA", registeredAt: 1 } })
      expect(r).toEqual({ ok: false, reason: "registration_changed" })
      expect(await inbox.enqueue({ handle: "nobody", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10, registration: { did: "x", registeredAt: 1 } })).toEqual({ ok: false, reason: "unknown_handle" })
    })

    it("pg-pool still words a starved-pool timeout the way isPoolTimeout expects", async () => {
      const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 500 })
      const held = await pool.connect()
      try {
        const err = await pool.connect().then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(isPoolTimeout(err)).toBe(true)
      } finally {
        held.release()
        await pool.end()
      }
    })

    it("queued messages and FIFO order survive a restart (fresh pool, same schema)", async () => {
      const inbox = new PgInboxStore(pg.newPool(), BOUNDS)
      await enq(inbox, "h", { ct: "first" })
      await enq(inbox, "h", { ct: "second" })
      const inbox2 = new PgInboxStore(pg.newPool(), BOUNDS)
      await enq(inbox2, "h", { ct: "third" })
      expect((await inbox2.list("h", 0)).map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second", "third"])
    })
  })

  describe("PgRegistryStore", () => {
    it("puts, looks up, re-registers, resolves a shared DID last-writer-wins, removes", async () => {
      const reg = new PgRegistryStore(pg.newPool())
      await reg.put({ handle: "h1", did: "did:key:zS", agentCard: card("did:key:zS"), keyAgreementPubKey: "pub", registeredAt: 0 })
      expect(await reg.getByHandle("h1")).toEqual({ handle: "h1", did: "did:key:zS", agentCard: card("did:key:zS"), keyAgreementPubKey: "pub", registeredAt: 0 })
      await reg.put({ handle: "h2", did: "did:key:zS", agentCard: card("did:key:zS"), registeredAt: 1 })
      expect((await reg.getByDid("did:key:zS"))?.handle).toBe("h2")
      expect((await reg.getByHandle("h2"))?.keyAgreementPubKey).toBeUndefined()
      await reg.put({ handle: "h2", did: "did:key:zNew", agentCard: card("did:key:zNew"), registeredAt: 2 })
      expect((await reg.getByDid("did:key:zS"))?.handle).toBe("h1")
      expect(await reg.remove("h1")).toBe(true)
      expect(await reg.remove("h1")).toBe(false)
      expect(await reg.getByDid("did:key:zS")).toBeUndefined()
    })
  })

  describe("assembled relay", () => {
    const config = loadConfig({ RELAY_INVITE_POLICY: "closed", RELAY_ADMIN_CREDENTIAL: "admin", RELAY_STORE: "postgres", DATABASE_URL: "postgres://ignored" })
    const DID = "did:key:zRecipient"
    const sealed = (ct: string): A2AMessage => ({ messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: DID } }] })
    const build = async (prefix: string) => {
      const stores = await assemblePostgresStores(config.databaseUrl as string, config.inboxBounds, () => pg.newPool())
      return assembleRelay(config, { ...stores, tokens: new SequenceTokenSource(prefix), clock: new ManualClock(0), logger: new MemoryLogger() })
    }

    it("registration, queued message, credentials and invite state survive a restart", async () => {
      const relay1 = await build("t")
      const invite = await relay1.issueInvite(2)
      const reg = await relay1.register({ handle: "B", did: DID, agentCard: card(DID), keyAgreementPubKey: "pub", inviteToken: invite })
      expect(reg.ok).toBe(true)
      if (!reg.ok) return
      expect((await relay1.enqueue({ handle: "B", sendCredential: reg.grant.sendCredential, message: sealed("c1") })).ok).toBe(true)

      const relay2 = await build("t2")
      expect((await relay2.lookupByHandle("B"))?.keyAgreementPubKey).toBe("pub")
      const pulled = await relay2.pull("B", reg.grant.inboxAuth)
      expect(pulled.ok && pulled.messages).toHaveLength(1)
      expect((await relay2.enqueue({ handle: "B", sendCredential: reg.grant.sendCredential, message: sealed("c2") })).ok).toBe(true)
      expect((await relay2.register({ handle: "C", did: "did:key:zC", agentCard: card("did:key:zC"), inviteToken: invite })).ok).toBe(true)
      expect(await relay2.register({ handle: "D", did: "did:key:zD", agentCard: card("did:key:zD"), inviteToken: invite })).toEqual({ ok: false, error: "invite_invalid" })
    })
  })
})
