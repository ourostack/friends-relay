import { beforeEach, describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { MemoryInboxStore, MemoryRegistryStore } from "../store/memory"
import type { A2AMessage, PublicAgentCard } from "../types"

const CARD: PublicAgentCard = { name: "a", url: "https://a", version: "1", protocolVersion: "0.3.0", did: "did:key:zRecipient" }

function baseConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    bindHost: "0.0.0.0",
    bindPort: 8080,
    publicUrl: "https://relay.test",
    did: "did:web:relay.test",
    version: "1.0.0",
    protocolVersion: "0.3.0",
    invitePolicy: "closed",
    adminCredential: "admin",
    directoryCredential: undefined,
    inboxBounds: { maxMessages: 3, maxBytes: 1_000_000 },
    messageTtlMs: 1000,
    sendRateLimit: { capacity: 5, refillPerSec: 1 },
    ...overrides,
  }
}

function makeRelay(config = baseConfig()) {
  const clock = new ManualClock(0)
  const logger = new MemoryLogger()
  const tokens = new SequenceTokenSource("t")
  const relay = new Relay({
    config,
    inbox: new MemoryInboxStore(config.inboxBounds),
    registry: new MemoryRegistryStore(),
    tokens,
    clock,
    logger,
  })
  return { relay, clock, logger }
}

function opaque(recipientDid = "did:key:zRecipient", ct = "cipher", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: `n-${id}`, ct }, recipientDid } }] }
}

/** Register a handle through the relay, returning its grant credentials. */
async function register(relay: Relay, handle = "h", did = "did:key:zRecipient") {
  const invite = await relay.issueInvite()
  const r = await relay.register({ handle, did, agentCard: { ...CARD, did }, inviteToken: invite })
  if (!r.ok) throw new Error(`register failed: ${r.error}`)
  return r.grant
}

describe("Relay.agentCard", () => {
  it("returns the relay's own A2A card from config", () => {
    const { relay } = makeRelay()
    const card = relay.agentCard()
    expect(card.url).toBe("https://relay.test")
    expect(card.did).toBe("did:web:relay.test")
    expect(card.version).toBe("1.0.0")
  })
})

describe("Relay.register — invite-gated (closed by default)", () => {
  it("registers with a valid invite and returns rotating credentials", async () => {
    const { relay } = makeRelay()
    const invite = await relay.issueInvite()
    const r = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: invite })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.grant.handle).toBe("h")
      expect(r.grant.inboxAuth).toBeTruthy()
      expect(r.grant.sendCredential).toBeTruthy()
      expect(r.grant.inboxAuth).not.toBe(r.grant.sendCredential)
      expect(r.relayCard.did).toBe("did:web:relay.test")
    }
  })

  it("REJECTS registration with no invite (closed membership — no open signup)", async () => {
    const { relay, logger } = makeRelay()
    const r = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD })
    expect(r).toEqual({ ok: false, error: "invite_required" })
    expect(logger.entries.some((e) => e.fields.reason === "invite_required")).toBe(true)
  })

  it("REJECTS registration with an unknown/used invite", async () => {
    const { relay } = makeRelay()
    const r = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: "bogus" })
    expect(r).toEqual({ ok: false, error: "invite_invalid" })
  })

  it("a single-use invite cannot register twice", async () => {
    const { relay } = makeRelay()
    const invite = await relay.issueInvite()
    expect((await relay.register({ handle: "h1", did: "did:key:zA", agentCard: { ...CARD, did: "did:key:zA" }, inviteToken: invite })).ok).toBe(true)
    expect((await relay.register({ handle: "h2", did: "did:key:zB", agentCard: { ...CARD, did: "did:key:zB" }, inviteToken: invite })).ok).toBe(false)
  })

  it("rejects a bad_request (missing handle/did/card)", async () => {
    const { relay } = makeRelay()
    expect(await relay.register({ handle: "", did: "d", agentCard: CARD, inviteToken: "x" })).toEqual({ ok: false, error: "bad_request" })
    expect(await relay.register({ handle: "h", did: "", agentCard: CARD, inviteToken: "x" })).toEqual({ ok: false, error: "bad_request" })
    expect(await relay.register({ handle: "h", did: "d", agentCard: null as never, inviteToken: "x" })).toEqual({ ok: false, error: "bad_request" })
  })

  it("OPEN policy registers with no invite", async () => {
    const { relay } = makeRelay(baseConfig({ invitePolicy: "open", adminCredential: undefined }))
    const r = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD })
    expect(r.ok).toBe(true)
  })

  it("re-registration ROTATES credentials (the old send credential stops working)", async () => {
    const { relay } = makeRelay()
    const first = await register(relay, "h")
    // Send works with the first credential.
    expect((await relay.enqueue({ handle: "h", sendCredential: first.sendCredential, message: opaque() })).ok).toBe(true)
    // Re-register (rotate).
    const second = await register(relay, "h")
    expect(second.sendCredential).not.toBe(first.sendCredential)
    expect(await relay.enqueue({ handle: "h", sendCredential: first.sendCredential, message: opaque(undefined, undefined, "m2") })).toEqual({ ok: false, error: "bad_send_credential" })
    expect((await relay.enqueue({ handle: "h", sendCredential: second.sendCredential, message: opaque(undefined, undefined, "m3") })).ok).toBe(true)
  })
})

describe("Relay.enqueue — store-and-forward of CIPHERTEXT, abuse-resistant", () => {
  it("enqueues a valid opaque message", async () => {
    const { relay, logger } = makeRelay()
    const grant = await register(relay)
    const r = await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })
    expect(r.ok).toBe(true)
    expect(logger.entries.some((e) => e.event === "enqueued")).toBe(true)
  })

  it("rejects an unknown handle", async () => {
    const { relay } = makeRelay()
    expect(await relay.enqueue({ handle: "nope", sendCredential: "x", message: opaque() })).toEqual({ ok: false, error: "unknown_handle" })
  })

  it("rejects a bad send credential", async () => {
    const { relay } = makeRelay()
    await register(relay)
    expect(await relay.enqueue({ handle: "h", sendCredential: "wrong", message: opaque() })).toEqual({ ok: false, error: "bad_send_credential" })
  })

  it("RATE-LIMITS excess sends on the send credential", async () => {
    const cfg = baseConfig({ sendRateLimit: { capacity: 2, refillPerSec: 1 } })
    const { relay } = makeRelay(cfg)
    const grant = await register(relay)
    expect((await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m1") })).ok).toBe(true)
    expect((await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m2") })).ok).toBe(true)
    expect(await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m3") })).toEqual({ ok: false, error: "rate_limited" })
  })

  it("rejects a malformed message (shape validation, never content)", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay)
    expect(await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: { not: "a2a" } })).toEqual({ ok: false, error: "malformed_message" })
  })

  it("rejects a recipient_mismatch (a blob sealed to another DID can't be parked here)", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay) // handle h's registered DID is did:key:zRecipient
    const r = await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque("did:key:zSomeoneElse") })
    expect(r).toEqual({ ok: false, error: "recipient_mismatch" })
  })

  it("DROPS over the per-handle COUNT quota (bounded queue — DoS floor)", async () => {
    const cfg = baseConfig({ inboxBounds: { maxMessages: 2, maxBytes: 1_000_000 }, sendRateLimit: { capacity: 100, refillPerSec: 1 } })
    const { relay, logger } = makeRelay(cfg)
    const grant = await register(relay)
    expect((await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m1") })).ok).toBe(true)
    expect((await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m2") })).ok).toBe(true)
    expect(await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m3") })).toEqual({ ok: false, error: "quota_count" })
    expect(logger.entries.some((e) => e.event === "enqueue_dropped" && e.fields.reason === "quota_count")).toBe(true)
  })

  it("DROPS over the per-handle BYTE quota", async () => {
    const cfg = baseConfig({ inboxBounds: { maxMessages: 100, maxBytes: 200 }, sendRateLimit: { capacity: 100, refillPerSec: 1 } })
    const { relay } = makeRelay(cfg)
    const grant = await register(relay)
    // A message with a large ct exceeds 200 bytes.
    const big = opaque(undefined, "x".repeat(500))
    expect(await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: big })).toEqual({ ok: false, error: "quota_bytes" })
  })
})

describe("Relay.pull + ack — the NAT-traversal read path (inbox-auth'd)", () => {
  it("pulls queued opaque messages with the inbox auth", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay)
    await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })
    const r = await relay.pull("h", grant.inboxAuth)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.messages).toHaveLength(1)
      expect(r.messages[0].message.parts[0].data.sealed.ct).toBe("cipher")
    }
  })

  it("rejects a pull with a wrong/empty inbox auth", async () => {
    const { relay } = makeRelay()
    await register(relay)
    expect(await relay.pull("h", "wrong")).toEqual({ ok: false, error: "bad_inbox_auth" })
    expect(await relay.pull("h", "")).toEqual({ ok: false, error: "bad_inbox_auth" })
  })

  it("does not return EXPIRED messages (TTL)", async () => {
    const { relay, clock } = makeRelay(baseConfig({ messageTtlMs: 500 }))
    const grant = await register(relay)
    await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })
    clock.advance(600)
    const r = await relay.pull("h", grant.inboxAuth)
    expect(r.ok && r.messages).toHaveLength(0)
  })

  it("acks a delivered message; a re-ack is harmless", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay)
    const enq = await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })
    const queueId = enq.ok ? enq.queueId : ""
    const a1 = await relay.ack("h", grant.inboxAuth, queueId)
    expect(a1).toEqual({ ok: true, existed: true })
    const a2 = await relay.ack("h", grant.inboxAuth, queueId)
    expect(a2).toEqual({ ok: true, existed: false })
  })

  it("rejects an ack with a wrong inbox auth", async () => {
    const { relay } = makeRelay()
    await register(relay)
    expect(await relay.ack("h", "wrong", "q1")).toEqual({ ok: false, error: "bad_inbox_auth" })
  })

  it("ownsInbox reflects the inbox-auth → handle binding", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay)
    expect(await relay.ownsInbox("h", grant.inboxAuth)).toBe(true)
    expect(await relay.ownsInbox("h", "wrong")).toBe(false)
  })
})

describe("Relay.deregister", () => {
  it("deregisters a handle, revoking its credentials", async () => {
    const { relay } = makeRelay()
    const grant = await register(relay)
    expect(await relay.deregister("h")).toBe(true)
    // Credentials revoked: send + pull now fail.
    expect(await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })).toEqual({ ok: false, error: "unknown_handle" })
    expect(await relay.pull("h", grant.inboxAuth)).toEqual({ ok: false, error: "bad_inbox_auth" })
  })

  it("deregister of an absent handle → false", async () => {
    const { relay } = makeRelay()
    expect(await relay.deregister("absent")).toBe(false)
  })
})

describe("Relay.directory — gated lookup (anti-harvest, no anon enumeration)", () => {
  it("looks up by handle and by DID", async () => {
    const { relay } = makeRelay()
    await register(relay, "h", "did:key:zRecipient")
    const byHandle = await relay.lookupByHandle("h")
    expect(byHandle?.agentCard.did).toBe("did:key:zRecipient")
    expect(byHandle?.handle).toBe("h")
    const byDid = await relay.lookupByDid("did:key:zRecipient")
    expect(byDid?.handle).toBe("h")
  })

  it("returns the pinned keyAgreement pubkey when registered with one", async () => {
    const { relay } = makeRelay()
    const invite = await relay.issueInvite()
    await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, keyAgreementPubKey: "x25519pub", inviteToken: invite })
    expect((await relay.lookupByHandle("h"))?.keyAgreementPubKey).toBe("x25519pub")
  })

  it("returns null for unknown handle/DID", async () => {
    const { relay } = makeRelay()
    expect(await relay.lookupByHandle("nope")).toBeNull()
    expect(await relay.lookupByDid("did:key:nope")).toBeNull()
  })
})

describe("Relay.sweepExpired — DoS hygiene", () => {
  let ctx: ReturnType<typeof makeRelay>
  beforeEach(() => {
    ctx = makeRelay(baseConfig({ messageTtlMs: 500, sendRateLimit: { capacity: 100, refillPerSec: 1 } }))
  })

  it("drops expired messages and reports the count", async () => {
    const { relay, clock } = ctx
    const grant = await register(relay)
    await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m1") })
    await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque(undefined, "c", "m2") })
    clock.advance(600)
    expect(await relay.sweepExpired()).toBe(2)
  })

  it("returns 0 and logs nothing when nothing is expired", async () => {
    const { relay, logger } = ctx
    const grant = await register(relay)
    await relay.enqueue({ handle: "h", sendCredential: grant.sendCredential, message: opaque() })
    expect(await relay.sweepExpired()).toBe(0)
    expect(logger.entries.some((e) => e.event === "swept_expired")).toBe(false)
  })
})
