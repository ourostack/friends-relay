import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { handle } from "../server/http"
import type { RelayRequest } from "../server/http"
import { MemoryCredentialStore, MemoryInboxStore, MemoryInviteStore, MemoryRegistryStore } from "../store/memory"
import type { A2AMessage, PublicAgentCard } from "../types"
import { RelayClient, RelayClientError } from "../client"
import type { FetchLike } from "../client"

const CARD: PublicAgentCard = { name: "a", url: "https://a", version: "1", protocolVersion: "0.3.0", did: "did:key:zRecipient" }

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    bindHost: "0.0.0.0",
    bindPort: 0,
    publicUrl: "https://relay.test",
    did: "did:web:relay.test",
    version: "1.0.0",
    protocolVersion: "0.3.0",
    invitePolicy: "closed",
    adminCredential: "admin-secret",
    directoryCredential: undefined,
    inboxBounds: { maxMessages: 10, maxBytes: 1_000_000 },
    messageTtlMs: 1000,
    sendRateLimit: { capacity: 100, refillPerSec: 1 },
    ...overrides,
  }
}

/** An injected fetch that routes through the pure relay router — exercises the full
 * client→server contract with zero sockets. */
function inProcessFetch(cfg: RelayConfig, relay: Relay): FetchLike {
  return async (url, init) => {
    const u = new URL(url)
    const path = u.pathname
    const auth = init?.headers?.authorization
    const reqObj: RelayRequest = {
      method: init?.method ?? "GET",
      path,
      bearer: auth ? /^Bearer (.+)$/.exec(auth)?.[1] : undefined,
      headers: {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    }
    const res = await handle(cfg, relay, reqObj)
    return { status: res.status, json: async () => res.body }
  }
}

function makeClient(cfg = config()) {
  const relay = new Relay({
    config: cfg,
    inbox: new MemoryInboxStore(cfg.inboxBounds),
    registry: new MemoryRegistryStore(),
    invites: new MemoryInviteStore(),
    credentials: new MemoryCredentialStore(),
    tokens: new SequenceTokenSource("t"),
    clock: new ManualClock(0),
    logger: new MemoryLogger(),
  })
  const client = new RelayClient({ baseUrl: "https://relay.test/", fetch: inProcessFetch(cfg, relay) })
  return { client, relay }
}

function opaque(recipientDid = "did:key:zRecipient", ct = "cipher", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: `n-${id}`, ct }, recipientDid } }] }
}

describe("RelayClient — full register/send/pull/ack/directory over the contract", () => {
  it("issues an invite, registers, sends, pulls, acks", async () => {
    const { client } = makeClient()
    const invite = await client.issueInvite("admin-secret")
    expect(invite).toBeTruthy()

    const grant = await client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: invite })
    expect(grant.handle).toBe("h")
    expect(grant.relayCard.did).toBe("did:web:relay.test")

    const taskId = await client.send("h", grant.sendCredential, opaque())
    expect(taskId).toBeTruthy()

    const messages = await client.pull("h", grant.inboxAuth)
    expect(messages).toHaveLength(1)
    expect(messages[0].message.parts[0].data.sealed.ct).toBe("cipher")

    expect(await client.ack("h", grant.inboxAuth, taskId)).toBe(true)
    // After ack the inbox is empty.
    expect(await client.pull("h", grant.inboxAuth)).toHaveLength(0)
  })

  it("issues an invite with a uses count", async () => {
    const { client } = makeClient()
    const invite = await client.issueInvite("admin-secret", 2)
    expect(invite).toBeTruthy()
  })

  it("deregisters a handle", async () => {
    const { client } = makeClient()
    const invite = await client.issueInvite("admin-secret")
    const grant = await client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: invite })
    await expect(client.deregister("h", grant.inboxAuth)).resolves.toBeUndefined()
  })

  it("fetches the relay's own card", async () => {
    const { client } = makeClient()
    const card = await client.relayCard()
    expect(card.did).toBe("did:web:relay.test")
  })

  it("looks up the directory by handle and by DID", async () => {
    const { client } = makeClient()
    const invite = await client.issueInvite("admin-secret")
    await client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, keyAgreementPubKey: "x25519", inviteToken: invite })
    const byHandle = await client.lookupByHandle("h")
    expect(byHandle?.keyAgreementPubKey).toBe("x25519")
    const byDid = await client.lookupByDid("did:key:zRecipient")
    expect(byDid?.handle).toBe("h")
  })

  it("directory lookup returns null on a 404", async () => {
    const { client } = makeClient()
    expect(await client.lookupByHandle("nope")).toBeNull()
    expect(await client.lookupByDid("did:key:nope")).toBeNull()
  })

  it("passes a directory credential when the relay requires one", async () => {
    const { client } = makeClient(config({ directoryCredential: "dir-secret" }))
    const invite = await client.issueInvite("admin-secret")
    await client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: invite })
    // Without the credential → 401 → throws.
    await expect(client.lookupByHandle("h")).rejects.toBeInstanceOf(RelayClientError)
    // With it → ok.
    const entry = await client.lookupByHandle("h", "dir-secret")
    expect(entry?.handle).toBe("h")
  })

  it("throws a RelayClientError on a non-2xx (bad invite)", async () => {
    const { client } = makeClient()
    await expect(client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: "bogus" })).rejects.toMatchObject({
      name: "RelayClientError",
      status: 403,
      code: "invite_invalid",
    })
  })

  it("RelayClientError on a by-did lookup failure (directory gated)", async () => {
    const { client } = makeClient(config({ directoryCredential: "dir-secret" }))
    const invite = await client.issueInvite("admin-secret")
    await client.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: invite })
    await expect(client.lookupByDid("did:key:zRecipient")).rejects.toBeInstanceOf(RelayClientError)
  })

  it("strips a trailing slash from the base URL", async () => {
    const { client } = makeClient()
    // The relayCard call would 404 if the base URL had a doubled slash.
    expect((await client.relayCard()).did).toBe("did:web:relay.test")
  })

  it("defaults to the global fetch when none is injected", async () => {
    // Construct with no fetch; stub the global fetch to observe the wiring.
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return { status: 200, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch
    try {
      const client = new RelayClient({ baseUrl: "https://relay.test" })
      await client.relayCard()
      expect(calls).toEqual(["https://relay.test/.well-known/agent-card.json"])
    } finally {
      globalThis.fetch = original
    }
  })

  it("a RelayClientError surfaces a generic code when the body has none", async () => {
    // A fetch that returns a non-2xx with an empty JSON body.
    const client = new RelayClient({
      baseUrl: "https://relay.test",
      fetch: async () => ({ status: 500, json: async () => ({}) }),
    })
    await expect(client.relayCard()).rejects.toMatchObject({ status: 500, code: "error" })
  })

  it("a directory lookup non-404 error surfaces a generic code when the body has none", async () => {
    const client = new RelayClient({
      baseUrl: "https://relay.test",
      fetch: async () => ({ status: 500, json: async () => ({}) }),
    })
    await expect(client.lookupByHandle("h")).rejects.toMatchObject({ status: 500, code: "error" })
  })
})
