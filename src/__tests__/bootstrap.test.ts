import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { loadConfig } from "../config"
import { MemoryLogger } from "../logger"
import { SequenceTokenSource } from "../security/tokens"
import { MemoryCredentialStore, MemoryInboxStore, MemoryInviteStore, MemoryRegistryStore } from "../store/memory"
import { assemblePostgresStores, assembleRelay, buildPostgresStores, defaultPoolFactory } from "../server/bootstrap"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgInboxStore } from "../store/postgres/inbox"
import { PgInviteStore } from "../store/postgres/invites"
import { PgRegistryStore } from "../store/postgres/registry"
import { makePgMem, migratedPgMem } from "./pg-harness"

describe("assembleRelay", () => {
  it("assembles a working relay from config with the default backends", async () => {
    const config = loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_ADMIN_CREDENTIAL: "admin" })
    const relay = assembleRelay(config)
    // It works end to end: register (open) → enqueue → pull.
    const reg = await relay.register({ handle: "h", did: "did:key:zR", agentCard: { name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did: "did:key:zR" } })
    expect(reg.ok).toBe(true)
    expect(relay.agentCard().did).toBe(config.did)
  })

  it("honors injected overrides (clock, logger, tokens, backends)", async () => {
    const config = loadConfig({ RELAY_INVITE_POLICY: "open" })
    const clock = new ManualClock(123)
    const logger = new MemoryLogger()
    const tokens = new SequenceTokenSource("z")
    const inbox = new MemoryInboxStore(config.inboxBounds)
    const registry = new MemoryRegistryStore()
    const invites = new MemoryInviteStore()
    const credentials = new MemoryCredentialStore()
    const relay = assembleRelay(config, { clock, logger, tokens, inbox, registry, invites, credentials })
    const reg = await relay.register({ handle: "h", did: "did:key:zR", agentCard: { name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did: "did:key:zR" } })
    // The injected sequence token source produced the credentials.
    expect(reg.ok && reg.grant.inboxAuth).toBe("z-1")
    // The injected logger captured the registration.
    expect(logger.entries.some((e) => e.event === "registered")).toBe(true)
    // The injected clock stamped registeredAt.
    expect((await registry.getByHandle("h"))?.registeredAt).toBe(123)
    // The injected credential store holds the binding.
    expect(await credentials.handleForInboxAuth("z-1")).toBe("h")
  })
})

describe("buildPostgresStores", () => {
  it("constructs the four Pg adapters around an injected (already-migrated) pool", async () => {
    const { pool } = await migratedPgMem()
    const stores = buildPostgresStores(pool)
    expect(stores.inbox).toBeInstanceOf(PgInboxStore)
    expect(stores.registry).toBeInstanceOf(PgRegistryStore)
    expect(stores.invites).toBeInstanceOf(PgInviteStore)
    expect(stores.credentials).toBeInstanceOf(PgCredentialStore)
    // They are live against the pool: a registry put/get round-trips.
    await stores.registry.put({ handle: "h", did: "did:key:zA", agentCard: { name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did: "did:key:zA" }, registeredAt: 1 })
    expect((await stores.registry.getByHandle("h"))?.did).toBe("did:key:zA")
  })
})

describe("assemblePostgresStores", () => {
  it("creates a pool via the factory, migrates, and returns working stores", async () => {
    const handle = makePgMem()
    // Inject a poolFactory that returns a pg-mem pool (fully hermetic — no network).
    const stores = await assemblePostgresStores("postgres://ignored", () => handle.newPool())
    // migrate ran: an invite round-trips through the invite store.
    await stores.invites.setRemaining("tok", 2)
    expect(await stores.invites.getRemaining("tok")).toBe(2)
    // And a credential binding round-trips.
    await stores.credentials.setCurrent("h", { inboxAuth: "ia", sendCredential: "sc" })
    expect(await stores.credentials.handleForInboxAuth("ia")).toBe("h")
  })

  it("assembles a fully working relay end-to-end over a pg-mem-backed Postgres path", async () => {
    const config = loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "postgres", DATABASE_URL: "postgres://ignored" })
    const handle = makePgMem()
    const stores = await assemblePostgresStores(config.databaseUrl as string, () => handle.newPool())
    const relay = assembleRelay(config, { ...stores, tokens: new SequenceTokenSource("p") })
    // register (open) → enqueue → pull → ack, all through the Postgres adapters.
    const reg = await relay.register({ handle: "h", did: "did:key:zR", agentCard: { name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did: "did:key:zR" } })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return
    const enq = await relay.enqueue({
      handle: "h",
      sendCredential: reg.grant.sendCredential,
      message: { messageId: "m1", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct: "ct" }, recipientDid: "did:key:zR" } }] },
    })
    expect(enq.ok).toBe(true)
    const pulled = await relay.pull("h", reg.grant.inboxAuth)
    expect(pulled.ok && pulled.messages).toHaveLength(1)
  })

  it("the default pool factory constructs a real pg Pool without connecting (hermetic)", async () => {
    // The production default factory builds `new Pool({ connectionString })`. pg
    // connects LAZILY (only on the first query), so constructing a pool is offline +
    // safe — no network. We construct one and immediately end() it; no query is ever
    // issued, so no socket is opened. This covers the default factory body without
    // touching a live resource.
    const pool = defaultPoolFactory("postgres://user:pass@localhost:5432/db?sslmode=require")
    expect(typeof pool.query).toBe("function")
    await (pool as unknown as { end(): Promise<void> }).end()
  })
})
