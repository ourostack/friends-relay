import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { createServer, handle, parseBearer, toRelayRequest } from "../server/http"
import type { RelayRequest } from "../server/http"
import { MemoryCredentialStore, MemoryInboxStore, MemoryInviteStore, MemoryRegistryStore } from "../store/memory"
import type { A2AMessage, PublicAgentCard } from "../types"

const CARD: PublicAgentCard = { name: "a", url: "https://a", version: "1", protocolVersion: "0.3.0", did: "did:key:zRecipient" }

function baseConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
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

function makeRelay(config = baseConfig()) {
  const relay = new Relay({
    config,
    inbox: new MemoryInboxStore(config.inboxBounds),
    registry: new MemoryRegistryStore(),
    invites: new MemoryInviteStore(),
    credentials: new MemoryCredentialStore(),
    tokens: new SequenceTokenSource("t"),
    clock: new ManualClock(0),
    logger: new MemoryLogger(),
  })
  return { relay, config }
}

function req(method: string, path: string, opts: Partial<RelayRequest> = {}): RelayRequest {
  return { method, path, headers: {}, ...opts }
}

function opaque(recipientDid = "did:key:zRecipient", ct = "cipher", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: `n-${id}`, ct }, recipientDid } }] }
}

describe("parseBearer", () => {
  it("extracts a Bearer token", () => {
    expect(parseBearer("Bearer abc")).toBe("abc")
  })
  it("returns undefined for missing/non-bearer", () => {
    expect(parseBearer(undefined)).toBeUndefined()
    expect(parseBearer("Basic xyz")).toBeUndefined()
  })
})

describe("HTTP router — liveness + relay card", () => {
  it("GET /healthz → 200 ok", async () => {
    const { relay, config } = makeRelay()
    expect(await handle(config, relay, req("GET", "/healthz"))).toEqual({ status: 200, body: { ok: true } })
  })

  it("GET /.well-known/agent-card.json → the relay's card", async () => {
    const { relay, config } = makeRelay()
    const res = await handle(config, relay, req("GET", "/.well-known/agent-card.json"))
    expect(res.status).toBe(200)
    expect((res.body as { did: string }).did).toBe("did:web:relay.test")
  })

  it("unknown route → 404", async () => {
    const { relay, config } = makeRelay()
    expect(await handle(config, relay, req("GET", "/nope"))).toEqual({ status: 404, body: { error: "not_found" } })
  })
})

describe("HTTP router — admin invites (admin-credential gated)", () => {
  it("POST /admin/invites with the admin credential → an invite token", async () => {
    const { relay, config } = makeRelay()
    const res = await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: {} }))
    expect(res.status).toBe(200)
    expect((res.body as { inviteToken: string }).inviteToken).toBeTruthy()
  })

  it("rejects without/with the wrong admin credential", async () => {
    const { relay, config } = makeRelay()
    expect((await handle(config, relay, req("POST", "/admin/invites", { body: {} }))).status).toBe(401)
    expect((await handle(config, relay, req("POST", "/admin/invites", { bearer: "wrong", body: {} }))).status).toBe(401)
  })

  it("honors a uses count and rejects an invalid one", async () => {
    const { relay, config } = makeRelay()
    expect((await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: { uses: 3 } }))).status).toBe(200)
    expect((await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: { uses: 0 } }))).status).toBe(400)
    expect((await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: { uses: "x" } }))).status).toBe(400)
  })

  it("defaults uses to 1 when the body is non-object", async () => {
    const { relay, config } = makeRelay()
    const res = await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: "not-an-object" }))
    expect(res.status).toBe(200)
  })

  it("an open-policy relay with no admin credential cannot issue invites", async () => {
    const { relay, config } = makeRelay(baseConfig({ invitePolicy: "open", adminCredential: undefined }))
    expect((await handle(config, relay, req("POST", "/admin/invites", { bearer: "anything", body: {} }))).status).toBe(401)
  })
})

/** Helper: mint an invite + register a handle via the router, returning the grant. */
async function registerViaHttp(relay: Relay, config: RelayConfig, handleName = "h", did = "did:key:zRecipient") {
  const inviteRes = await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: {} }))
  const inviteToken = (inviteRes.body as { inviteToken: string }).inviteToken
  const regRes = await handle(config, relay, req("POST", "/register", { body: { handle: handleName, did, agentCard: { ...CARD, did }, inviteToken } }))
  return regRes.body as { handle: string; inboxAuth: string; sendCredential: string }
}

describe("HTTP router — register / deregister", () => {
  it("POST /register with a valid invite → grant (+relayCard)", async () => {
    const { relay, config } = makeRelay()
    const inviteRes = await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: {} }))
    const inviteToken = (inviteRes.body as { inviteToken: string }).inviteToken
    const res = await handle(config, relay, req("POST", "/register", { body: { handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken } }))
    expect(res.status).toBe(200)
    const grant = res.body as { handle: string; inboxAuth: string; sendCredential: string; relayCard: { did: string } }
    expect(grant.handle).toBe("h")
    expect(grant.inboxAuth).toBeTruthy()
    expect(grant.relayCard.did).toBe("did:web:relay.test")
  })

  it("POST /register without an invite → 403 invite_required", async () => {
    const { relay, config } = makeRelay()
    const res = await handle(config, relay, req("POST", "/register", { body: { handle: "h", did: "did:key:zRecipient", agentCard: CARD } }))
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe("invite_required")
  })

  it("POST /register with an invalid invite → 403 invite_invalid", async () => {
    const { relay, config } = makeRelay()
    const res = await handle(config, relay, req("POST", "/register", { body: { handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: "bogus" } }))
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe("invite_invalid")
  })

  it("POST /register with a bad body → 400 bad_request", async () => {
    const { relay, config } = makeRelay()
    const inviteRes = await handle(config, relay, req("POST", "/admin/invites", { bearer: "admin-secret", body: {} }))
    const inviteToken = (inviteRes.body as { inviteToken: string }).inviteToken
    const res = await handle(config, relay, req("POST", "/register", { body: { did: "d", agentCard: CARD, inviteToken } }))
    expect(res.status).toBe(400)
  })

  it("POST /register with no body at all → 400 (empty handle)", async () => {
    const { relay, config } = makeRelay(baseConfig({ invitePolicy: "open", adminCredential: undefined }))
    const res = await handle(config, relay, req("POST", "/register", {}))
    expect(res.status).toBe(400)
  })

  it("DELETE /register/{handle} with the inbox auth → 200", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    const res = await handle(config, relay, req("DELETE", "/register/h", { bearer: grant.inboxAuth }))
    expect(res).toEqual({ status: 200, body: { ok: true } })
  })

  it("DELETE /register/{handle} without/with a wrong bearer → 401", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("DELETE", "/register/h"))).status).toBe(401)
    expect((await handle(config, relay, req("DELETE", "/register/h", { bearer: "wrong" }))).status).toBe(401)
  })

  it("DELETE /register/{handle} for an absent (but auth-probed) handle → 404 after a valid bearer for a different handle is rejected", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config, "h")
    // The bearer is valid for h, not for h2 → ownsInbox(h2, bearer) false → 401.
    expect((await handle(config, relay, req("DELETE", "/register/h2", { bearer: grant.inboxAuth }))).status).toBe(401)
  })
})

describe("HTTP router — A2A forward (enqueue), pull, ack", () => {
  it("POST /a2a/{handle} enqueues an opaque message → 202 submitted", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    const res = await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque() }))
    expect(res.status).toBe(202)
    expect((res.body as { state: string }).state).toBe("submitted")
  })

  it.each([
    ["unknown handle → 404", "/a2a/nope", "anything", opaque(), 404],
  ])("%s", async (_label, path, bearer, body, status) => {
    const { relay, config } = makeRelay()
    expect((await handle(config, relay, req("POST", path as string, { bearer: bearer as string, body }))).status).toBe(status)
  })

  it("bad send credential → 403", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: "wrong", body: opaque() }))).status).toBe(403)
  })

  it("malformed message → 400", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: { not: "a2a" } }))).status).toBe(400)
  })

  it("recipient_mismatch → 400", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque("did:key:zOther") }))).status).toBe(400)
  })

  it("rate-limited → 429", async () => {
    const { relay, config } = makeRelay(baseConfig({ sendRateLimit: { capacity: 1, refillPerSec: 1 } }))
    const grant = await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque(undefined, "c", "m1") }))).status).toBe(202)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque(undefined, "c", "m2") }))).status).toBe(429)
  })

  it("over quota → 507", async () => {
    const { relay, config } = makeRelay(baseConfig({ inboxBounds: { maxMessages: 1, maxBytes: 1_000_000 } }))
    const grant = await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque(undefined, "c", "m1") }))).status).toBe(202)
    expect((await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque(undefined, "c", "m2") }))).status).toBe(507)
  })

  it("POST /a2a/{handle} with no bearer → 403 (empty send credential)", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/a2a/h", { body: opaque() }))).status).toBe(403)
  })

  it("GET /inbox/{handle} pulls with the inbox auth → 200 messages", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque() }))
    const res = await handle(config, relay, req("GET", "/inbox/h", { bearer: grant.inboxAuth }))
    expect(res.status).toBe(200)
    expect((res.body as { messages: unknown[] }).messages).toHaveLength(1)
  })

  it("GET /inbox/{handle} with wrong/no auth → 401", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("GET", "/inbox/h", { bearer: "wrong" }))).status).toBe(401)
    expect((await handle(config, relay, req("GET", "/inbox/h"))).status).toBe(401)
  })

  it("POST /inbox/{handle}/ack/{queueId} acks with the inbox auth", async () => {
    const { relay, config } = makeRelay()
    const grant = await registerViaHttp(relay, config)
    const enq = await handle(config, relay, req("POST", "/a2a/h", { bearer: grant.sendCredential, body: opaque() }))
    const queueId = (enq.body as { taskId: string }).taskId
    const res = await handle(config, relay, req("POST", `/inbox/h/ack/${queueId}`, { bearer: grant.inboxAuth }))
    expect(res).toEqual({ status: 200, body: { acked: true } })
  })

  it("ack with a wrong/absent auth → 401", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config)
    expect((await handle(config, relay, req("POST", "/inbox/h/ack/q1", { bearer: "wrong" }))).status).toBe(401)
    // No bearer at all → the `req.bearer ?? ""` fallback → bad_inbox_auth.
    expect((await handle(config, relay, req("POST", "/inbox/h/ack/q1"))).status).toBe(401)
  })
})

describe("toRelayRequest — pure node→RelayRequest build", () => {
  it("strips the query string and parses the bearer", () => {
    const r = toRelayRequest({ method: "POST", url: "/a2a/h?x=1", headers: { authorization: "Bearer tok" }, body: { a: 1 } })
    expect(r).toEqual({ method: "POST", path: "/a2a/h", bearer: "tok", headers: { authorization: "Bearer tok" }, body: { a: 1 } })
  })

  it("defaults an undefined method to GET and an undefined url to /", () => {
    const r = toRelayRequest({ method: undefined, url: undefined, headers: {}, body: undefined })
    expect(r.method).toBe("GET")
    expect(r.path).toBe("/")
    expect(r.bearer).toBeUndefined()
  })
})

describe("HTTP router — directory (gated, anti-harvest)", () => {
  it("GET /directory/{handle} → the public card (open when no directory credential)", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config, "h", "did:key:zRecipient")
    const res = await handle(config, relay, req("GET", "/directory/h"))
    expect(res.status).toBe(200)
    expect((res.body as { handle: string }).handle).toBe("h")
  })

  it("GET /directory/by-did/{did} → the public card", async () => {
    const { relay, config } = makeRelay()
    await registerViaHttp(relay, config, "h", "did:key:zRecipient")
    const res = await handle(config, relay, req("GET", "/directory/by-did/did:key:zRecipient"))
    expect(res.status).toBe(200)
    expect((res.body as { handle: string }).handle).toBe("h")
  })

  it("unknown handle/DID → 404", async () => {
    const { relay, config } = makeRelay()
    expect((await handle(config, relay, req("GET", "/directory/nope"))).status).toBe(404)
    expect((await handle(config, relay, req("GET", "/directory/by-did/did:key:nope"))).status).toBe(404)
  })

  it("when a directory credential is configured, it is REQUIRED (anti-harvest)", async () => {
    const { relay, config } = makeRelay(baseConfig({ directoryCredential: "dir-secret" }))
    await registerViaHttp(relay, config, "h", "did:key:zRecipient")
    expect((await handle(config, relay, req("GET", "/directory/h"))).status).toBe(401)
    expect((await handle(config, relay, req("GET", "/directory/by-did/did:key:zRecipient"))).status).toBe(401)
    expect((await handle(config, relay, req("GET", "/directory/h", { bearer: "dir-secret" }))).status).toBe(200)
    expect((await handle(config, relay, req("GET", "/directory/by-did/did:key:zRecipient", { bearer: "dir-secret" }))).status).toBe(200)
  })
})

describe("createServer — real socket round-trip", () => {
  async function withServer(config: RelayConfig, relay: Relay, fn: (base: string) => Promise<void>): Promise<void> {
    const server = createServer(config, relay)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    const base = `http://127.0.0.1:${addr.port}`
    try {
      await fn(base)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it("serves healthz, registers, sends, pulls, and acks over a real socket", async () => {
    const { relay, config } = makeRelay()
    await withServer(config, relay, async (base) => {
      // healthz
      const h = await fetch(`${base}/healthz`)
      expect(h.status).toBe(200)
      expect(await h.json()).toEqual({ ok: true })

      // issue invite
      const invRes = await fetch(`${base}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: "{}" })
      const { inviteToken } = (await invRes.json()) as { inviteToken: string }

      // register
      const regRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken }),
      })
      const grant = (await regRes.json()) as { inboxAuth: string; sendCredential: string }

      // send an opaque message
      const sendRes = await fetch(`${base}/a2a/h`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.sendCredential}`, "content-type": "application/json" },
        body: JSON.stringify(opaque()),
      })
      expect(sendRes.status).toBe(202)
      const { taskId } = (await sendRes.json()) as { taskId: string }

      // pull
      const pullRes = await fetch(`${base}/inbox/h`, { headers: { authorization: `Bearer ${grant.inboxAuth}` } })
      const { messages } = (await pullRes.json()) as { messages: { message: A2AMessage }[] }
      expect(messages).toHaveLength(1)
      expect(messages[0].message.parts[0].data.sealed.ct).toBe("cipher")

      // ack
      const ackRes = await fetch(`${base}/inbox/h/ack/${taskId}`, { method: "POST", headers: { authorization: `Bearer ${grant.inboxAuth}` } })
      expect(await ackRes.json()).toEqual({ acked: true })
    })
  })

  it("returns 400 on a malformed JSON body", async () => {
    const { relay, config } = makeRelay()
    await withServer(config, relay, async (base) => {
      const res = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "bad_json" })
    })
  })

  it("handles a GET with no body and a missing url/method gracefully", async () => {
    const { relay, config } = makeRelay()
    await withServer(config, relay, async (base) => {
      const res = await fetch(`${base}/healthz?x=1`)
      expect(res.status).toBe(200)
    })
  })
})
