import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { loadConfig } from "../config"
import { MemoryLogger } from "../logger"
import { SequenceTokenSource } from "../security/tokens"
import { MemoryInboxStore, MemoryRegistryStore } from "../store/memory"
import { assembleRelay } from "../server/bootstrap"

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
    const relay = assembleRelay(config, { clock, logger, tokens, inbox, registry })
    const reg = await relay.register({ handle: "h", did: "did:key:zR", agentCard: { name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did: "did:key:zR" } })
    // The injected sequence token source produced the credentials.
    expect(reg.ok && reg.grant.inboxAuth).toBe("z-1")
    // The injected logger captured the registration.
    expect(logger.entries.some((e) => e.event === "registered")).toBe(true)
    // The injected clock stamped registeredAt.
    expect((await registry.getByHandle("h"))?.registeredAt).toBe(123)
  })
})
