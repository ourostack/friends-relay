// lifecycle.test — atomic register/deregister of a handle, the registration-generation
// check on enqueue, and the leftover-mail purge on a newly created registration.
import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { MemoryCredentialStore, MemoryInboxStore, MemoryInviteStore, MemoryRegistryStore } from "../store/memory"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgInboxStore } from "../store/postgres/inbox"
import { PgHandleLifecycleStore } from "../store/postgres/lifecycle"
import { PgRegistryStore } from "../store/postgres/registry"
import type { PgPool, PgPoolClient } from "../store/postgres/schema"
import type { A2AMessage, PublicAgentCard, Registration } from "../types"
import { migratedPgMem } from "./pg-harness"

const card = (did: string): PublicAgentCard => ({ name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did })
const reg = (did: string, registeredAt = 0): Registration => ({ handle: "h", did, agentCard: card(did), registeredAt })
const msg = (id: string): A2AMessage => ({ messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct: id }, recipientDid: "did:key:zB" } }] })
const BOUNDS = { maxMessages: 10, maxBytes: 1_000_000 }
const ENQ = (id: string, registration?: { did: string; registeredAt: number }) => ({ handle: "h", message: msg(id), enqueuedAt: 0, expiresAt: 1000, sizeBytes: 10, registration })

describe("MemoryInboxStore — registration generation", () => {
  it("refuses a send whose checked registration is no longer the handle's current one", async () => {
    const registry = new MemoryRegistryStore()
    const inbox = new MemoryInboxStore(BOUNDS, registry)
    await registry.put(reg("did:key:zA", 0))
    const checkedA = { did: "did:key:zA", registeredAt: 0 }
    expect((await inbox.enqueue(ENQ("1", checkedA))).ok).toBe(true)
    await registry.remove("h")
    expect(await inbox.enqueue(ENQ("2", checkedA))).toEqual({ ok: false, reason: "unknown_handle" })
    await registry.put(reg("did:key:zB", 5))
    expect(await inbox.enqueue(ENQ("3", checkedA))).toEqual({ ok: false, reason: "unknown_handle" })
    expect((await inbox.enqueue(ENQ("4", { did: "did:key:zB", registeredAt: 5 }))).ok).toBe(true)
    expect((await inbox.enqueue(ENQ("5"))).ok).toBe(true) // no registration passed: not checked
  })
})

describe("PgInboxStore — registration generation (pg-mem)", () => {
  it("refuses a send checked against a superseded registration", async () => {
    const { pool } = await migratedPgMem()
    const registry = new PgRegistryStore(pool)
    const inbox = new PgInboxStore(pool, BOUNDS, { requireRegistration: true })
    await registry.put(reg("did:key:zA", 0))
    await registry.remove("h")
    await registry.put(reg("did:key:zB", 5))
    expect(await inbox.enqueue(ENQ("1", { did: "did:key:zA", registeredAt: 0 }))).toEqual({ ok: false, reason: "unknown_handle" })
    expect((await inbox.enqueue(ENQ("2", { did: "did:key:zB", registeredAt: 5 }))).ok).toBe(true)
  })
})

/** A pool whose clients throw on the first statement matching `pattern`. */
function faulty(pool: PgPool, pattern: RegExp): { pool: PgPool; armed: { on: boolean } } {
  const armed = { on: false }
  return {
    armed,
    pool: {
      query: (t, p) => pool.query(t, p),
      async connect(): Promise<PgPoolClient> {
        const c = await pool.connect()
        return {
          release: () => c.release(),
          query: async (t, p) => {
            if (armed.on && pattern.test(t)) {
              armed.on = false
              throw new Error("injected failure")
            }
            return c.query(t, p)
          },
        }
      },
    },
  }
}

describe("PgHandleLifecycleStore (pg-mem)", () => {
  async function setup() {
    const { pool } = await migratedPgMem()
    const f = faulty(pool, /^delete from inbox where handle = \$1$/)
    return { pool, f, life: new PgHandleLifecycleStore(f.pool), registry: new PgRegistryStore(pool), creds: new PgCredentialStore(pool), inbox: new PgInboxStore(pool, BOUNDS) }
  }

  // (pg-mem does not roll back; the intact-state assertions for a failed purge run
  // against real Postgres in pg-real.test.ts. Here: the failure propagates and a retry
  // completes the whole deregistration.)
  it("a failing purge propagates and a retry completes the deregistration", async () => {
    const { f, life, registry, creds, inbox } = await setup()
    await life.register(reg("did:key:zB"))
    await creds.setCurrent("h", { inboxAuth: "ia", sendCredential: "sc" })
    await inbox.enqueue(ENQ("1"))
    f.armed.on = true
    await expect(life.deregister("h")).rejects.toThrow("injected failure")
    await expect(life.deregister("h")).resolves.toBeTypeOf("boolean")
    expect(await registry.getByHandle("h")).toBeUndefined()
    expect(await creds.handleForInboxAuth("ia")).toBeNull()
    expect(await inbox.depth("h", 0)).toBe(0)
    expect(await life.deregister("h")).toBe(false)
  })

  it("a NEW registration purges leftover mail; re-registering an existing handle keeps it", async () => {
    const { life, inbox } = await setup()
    await inbox.enqueue(ENQ("stale")) // leftover rows with no registration
    expect(await life.register(reg("did:key:zB"))).toBe(true)
    expect(await inbox.depth("h", 0)).toBe(0)
    await inbox.enqueue(ENQ("kept"))
    expect(await life.register(reg("did:key:zB", 9))).toBe(false)
    expect(await inbox.depth("h", 0)).toBe(1)
  })
})

describe("Relay over memory stores — deregister then register a new owner", () => {
  it("the new owner starts with an empty inbox and the old credentials are dead", async () => {
    const config = { invitePolicy: "open", sendRateLimit: { capacity: 100, refillPerSec: 1 }, inboxBounds: BOUNDS, messageTtlMs: 1000, publicUrl: "u", did: "d", version: "1", protocolVersion: "0.3.0" } as never
    const registry = new MemoryRegistryStore()
    const relay = new Relay({ config, inbox: new MemoryInboxStore(BOUNDS, registry), registry, invites: new MemoryInviteStore(), credentials: new MemoryCredentialStore(), tokens: new SequenceTokenSource("t"), clock: new ManualClock(0), logger: new MemoryLogger() })
    const a = await relay.register({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB") })
    if (!a.ok) throw new Error("setup")
    expect((await relay.enqueue({ handle: "h", sendCredential: a.grant.sendCredential, message: msg("old") })).ok).toBe(true)
    await relay.deregister("h")
    const b = await relay.register({ handle: "h", did: "did:key:zB", agentCard: card("did:key:zB") })
    if (!b.ok) throw new Error("setup")
    expect((await relay.pull("h", b.grant.inboxAuth)) as unknown).toMatchObject({ ok: true, messages: [] })
    expect(await relay.pull("h", a.grant.inboxAuth)).toEqual({ ok: false, error: "bad_inbox_auth" })
  })
})
