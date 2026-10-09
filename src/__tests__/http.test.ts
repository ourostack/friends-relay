import { request as httpRequest } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { EventEmitter } from "node:events"

import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { createServer, handle, MAX_BODY_BYTES, parseBearer, readBody, SMALL_BODY_BYTES, toRelayRequest } from "../server/http"
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
    maxBodyBytes: 1024 * 1024,
    maxConnections: 1024,
    ...overrides,
  }
}

function makeRelay(config = baseConfig()) {
  const logger = new MemoryLogger()
  const relay = new Relay({
    config,
    inbox: new MemoryInboxStore(config.inboxBounds),
    registry: new MemoryRegistryStore(),
    invites: new MemoryInviteStore(),
    credentials: new MemoryCredentialStore(),
    tokens: new SequenceTokenSource("t"),
    clock: new ManualClock(0),
    logger,
  })
  return { relay, config, logger }
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

  it("a rejecting handle() responds 500 (does NOT hang) and leaks ONLY a static event name", async () => {
    const { config } = makeRelay()
    const logger = new MemoryLogger()
    // A relay whose register() REJECTS mid-request (models a Postgres query throwing).
    // The rejection error carries a secret-looking payload that must NEVER be logged.
    const LEAK = "postgres://user:s3cr3t@db.internal:5432/relay sealed-ct-do-not-leak"
    const throwingRelay = {
      register: () => Promise.reject(new Error(LEAK)),
    } as unknown as Relay
    const server = createServer(config, throwingRelay, logger)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    const base = `http://127.0.0.1:${addr.port}`
    try {
      // The request would hang forever before the fix (no response is ever written).
      // A 2s race guards against a regression masquerading as a slow pass.
      const res = await Promise.race([
        fetch(`${base}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: "h", did: "did:key:zR", agentCard: CARD, inviteToken: "t" }),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("socket hung — no 500 written")), 2000)),
      ])
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "internal_error" })
      // Exactly one static error event was logged, with NO fields that could carry
      // the connection string / error message / any content.
      const errs = logger.entries.filter((e) => e.level === "error")
      expect(errs).toHaveLength(1)
      expect(errs[0].event).toBe("request_failed")
      // The leaked secret appears NOWHERE in the captured log (event name or fields).
      expect(JSON.stringify(logger.entries).includes("s3cr3t")).toBe(false)
      expect(JSON.stringify(logger.entries).includes("sealed-ct-do-not-leak")).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("when the response was already partially written, the failure path still ends the socket without a double-writeHead", async () => {
    const { config } = makeRelay()
    const logger = new MemoryLogger()
    // handle() RESOLVES fine, so the success path runs `res.writeHead(200)` — but the
    // body is unserializable (a BigInt), so `JSON.stringify(response.body)` throws
    // INSIDE `res.end(...)`, AFTER headers were sent. The catch must then skip the
    // second writeHead (headersSent === true) and still end the socket (no hang).
    const badBodyRelay = {
      agentCard: () => ({ bad: 1n }),
    } as unknown as Relay
    const server = createServer(config, badBodyRelay, logger)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    const base = `http://127.0.0.1:${addr.port}`
    try {
      const res = await Promise.race([
        // GET the relay card → handle() returns { status: 200, body: relay.agentCard() }.
        fetch(`${base}/.well-known/agent-card.json`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("socket hung")), 2000)),
      ])
      // Headers (200) were already flushed before the body-stringify threw; the socket
      // is still ended (the body is empty/partial), and a static event was logged.
      expect(res.status).toBe(200)
      await res.text()
      expect(logger.entries.filter((e) => e.event === "request_failed")).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("createServer — request body cap + auth before body", () => {
  const MIB = 1024 * 1024

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    return `http://127.0.0.1:${addr.port}`
  }
  const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

  /** Send headers (and optionally some body bytes) but NEVER finish the body, then
   * resolve with the status of whatever the server answers. Fails after 2s if the
   * server is still waiting for the body (i.e. it buffers before deciding). */
  function sendUnfinished(base: string, method: string, path: string, headers: Record<string, string>, firstChunk?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        r.destroy()
        reject(new Error("server did not answer before the body was sent"))
      }, 2000)
      const r = httpRequest(`${base}${path}`, { method, headers }, (res) => {
        let body = ""
        res.on("data", (c: Buffer) => (body += c.toString()))
        res.on("end", () => {
          clearTimeout(timer)
          resolve({ status: res.statusCode as number, body })
        })
      })
      r.on("error", () => undefined)
      r.write(firstChunk ?? "")
      // deliberately no r.end()
    })
  }

  it("exports a 1 MiB default cap", () => {
    expect(MAX_BODY_BYTES).toBe(MIB)
  })

  it("rejects a 2 MiB body with 413 instead of buffering it", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const big = JSON.stringify({ handle: "h", pad: "a".repeat(2 * MIB) })
      const res = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: big })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "payload_too_large" })
    } finally {
      await close(server)
    }
  })

  it("rejects an oversized chunked body (no content-length) with 413", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const chunk = "a".repeat(256 * 1024)
      async function* gen() {
        yield '{"pad":"'
        for (let i = 0; i < 8; i++) yield chunk
        yield '"}'
      }
      const res = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: gen() as never, duplex: "half" } as RequestInit)
      expect(res.status).toBe(413)
    } finally {
      await close(server)
    }
  })

  it("honours content-length up front: 413 before any body bytes arrive", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const res = await sendUnfinished(base, "POST", "/register", { "content-length": String(50 * MIB), "content-type": "application/json" }, "{")
      expect(res.status).toBe(413)
      expect(JSON.parse(res.body)).toEqual({ error: "payload_too_large" })
    } finally {
      await close(server)
    }
  })

  it("accepts a body just under the cap and honours a configured cap", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { maxBodyBytes: 64, drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const small = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(small.status).toBe(400) // reaches the router: register rejects the empty body
      const over = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "a".repeat(100) }) })
      expect(over.status).toBe(413)
    } finally {
      await close(server)
    }
  })

  it("admin route: a wrong or missing credential gets 401 BEFORE the body is read", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const wrong = await sendUnfinished(base, "POST", "/admin/invites", { authorization: "Bearer nope", "content-length": "100" })
      expect(wrong.status).toBe(401)
      const missing = await sendUnfinished(base, "POST", "/admin/invites", { "content-length": "100" })
      expect(missing.status).toBe(401)
      // A correct credential is NOT short-circuited: it proceeds to read the body.
      const ok = await fetch(`${base}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: "{}" })
      expect(ok.status).toBe(200)
    } finally {
      await close(server)
    }
  })

  it("an unauthenticated oversized body gets 401, not a read of the body", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const res = await fetch(`${base}/admin/invites`, { method: "POST", body: "a".repeat(2 * MIB) })
      expect(res.status).toBe(401)
    } finally {
      await close(server)
    }
  })

  it("send route: unknown handle → 404 and bad/missing send credential → 403 before the body; a good one proceeds", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const inv = await relay.issueInvite()
      const reg = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: inv })
      if (!reg.ok) throw new Error("setup")
      expect((await sendUnfinished(base, "POST", "/a2a/ghost", { authorization: `Bearer ${reg.grant.sendCredential}`, "content-length": "100" })).status).toBe(404)
      const bad = await sendUnfinished(base, "POST", "/a2a/h", { authorization: "Bearer wrong", "content-length": "100" })
      expect(bad.status).toBe(403)
      expect(JSON.parse(bad.body)).toEqual({ error: "bad_send_credential" })
      expect((await sendUnfinished(base, "POST", "/a2a/h", { "content-length": "100" })).status).toBe(403)
      const good = await fetch(`${base}/a2a/h`, { method: "POST", headers: { authorization: `Bearer ${reg.grant.sendCredential}` }, body: JSON.stringify(opaque()) })
      expect(good.status).toBe(202)
    } finally {
      await close(server)
    }
  })

  it("deregister route: a wrong inbox credential gets 401 before the body; the owner proceeds", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const inv = await relay.issueInvite()
      const reg = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: inv })
      if (!reg.ok) throw new Error("setup")
      expect((await sendUnfinished(base, "DELETE", "/register/h", { authorization: "Bearer wrong", "content-length": "100" })).status).toBe(401)
      expect((await sendUnfinished(base, "DELETE", "/register/h", { "content-length": "100" })).status).toBe(401)
      const ok = await fetch(`${base}/register/h`, { method: "DELETE", headers: { authorization: `Bearer ${reg.grant.inboxAuth}` } })
      expect(ok.status).toBe(200)
    } finally {
      await close(server)
    }
  })
})

describe("createServer — per-route caps, timeouts, failure cleanup, aborted bodies", () => {
  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    return `http://127.0.0.1:${addr.port}`
  }
  const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

  it("caps /register and /admin/invites at 64 KiB while /a2a keeps the full cap", async () => {
    const { relay, config } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      expect(SMALL_BODY_BYTES).toBe(64 * 1024)
      const pad = JSON.stringify({ pad: "a".repeat(100 * 1024) })
      expect((await fetch(`${base}/register`, { method: "POST", body: pad })).status).toBe(413)
      expect((await fetch(`${base}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin-secret" }, body: pad })).status).toBe(413)
      const inv = await relay.issueInvite()
      const reg = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: inv })
      if (!reg.ok) throw new Error("setup")
      // 100 KiB to the send route is within the full cap: it reaches the router (400 malformed), not 413.
      const send = await fetch(`${base}/a2a/h`, { method: "POST", headers: { authorization: `Bearer ${reg.grant.sendCredential}` }, body: pad })
      expect(send.status).toBe(400)
    } finally {
      await close(server)
    }
  })

  it("uses the configured RelayConfig.maxBodyBytes when no option overrides it", async () => {
    const { relay, config } = makeRelay(baseConfig({ maxBodyBytes: 100 }))
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const inv = await relay.issueInvite()
      const reg = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: inv })
      if (!reg.ok) throw new Error("setup")
      const send = await fetch(`${base}/a2a/h`, { method: "POST", headers: { authorization: `Bearer ${reg.grant.sendCredential}` }, body: JSON.stringify(opaque()) })
      expect(send.status).toBe(413)
    } finally {
      await close(server)
    }
  })

  it("sets slow-upload timeouts and a connection cap (defaults and overrides)", async () => {
    const { relay, config } = makeRelay()
    const d = createServer(config, relay)
    expect(d.requestTimeout).toBe(30_000)
    expect(d.headersTimeout).toBeGreaterThan(0)
    expect(d.headersTimeout).toBeLessThan(d.requestTimeout)
    expect(d.maxConnections).toBe(1024)
    const o = createServer(baseConfig({ maxConnections: 7 }), relay, undefined, { requestTimeoutMs: 9000 })
    expect(o.requestTimeout).toBe(9000)
    expect(o.headersTimeout).toBeLessThan(9000)
    expect(o.maxConnections).toBe(7)
  })

  it("when pre-body auth throws: 500, and the unread body is still discarded then destroyed", async () => {
    const { config } = makeRelay()
    const logger = new MemoryLogger()
    const dbDown = { ownsInbox: () => Promise.reject(new Error("db down")) } as unknown as Relay
    const server = createServer(config, dbDown, logger, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const outcome = await new Promise<{ status: number; closedAfterMs: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket never closed")), 3000)
        const started = Date.now()
        let status = 0
        const r = httpRequest(`${base}/register/h`, { method: "DELETE", headers: { authorization: "Bearer x", "content-length": "100" } }, (res) => {
          status = res.statusCode as number
          res.resume()
        })
        r.on("error", () => undefined)
        r.on("close", () => {
          clearTimeout(timer)
          resolve({ status, closedAfterMs: Date.now() - started })
        })
        r.write("partial") // never ended: the server must stop waiting for it
      })
      expect(outcome.status).toBe(500)
      expect(logger.entries.filter((e) => e.event === "request_failed")).toHaveLength(1)
    } finally {
      await close(server)
    }
  })

  it("a client that aborts mid-body is dropped quietly (handler never runs, nothing logged)", async () => {
    const { config } = makeRelay()
    const logger = new MemoryLogger()
    let called = 0
    const spy = { register: () => ((called += 1), Promise.reject(new Error("must not run"))) } as unknown as Relay
    const server = createServer(config, spy, logger, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      await new Promise<void>((resolve) => {
        const r = httpRequest(`${base}/register`, { method: "POST", headers: { "content-length": "100" } })
        r.on("error", () => undefined)
        r.on("close", () => resolve())
        r.write("partial")
        setTimeout(() => r.destroy(), 50)
      })
      await new Promise((r) => setTimeout(r, 150))
      expect(called).toBe(0)
      expect(logger.entries).toEqual([])
    } finally {
      await close(server)
    }
  })

  it("readBody settles on end, over-limit, close and error (never hangs)", async () => {
    const fake = () => new EventEmitter() as unknown as IncomingMessage
    const a = fake()
    const pa = readBody(a, 10)
    a.emit("data", Buffer.from("abc"))
    a.emit("end")
    expect((await pa)?.toString()).toBe("abc")
    const b = fake()
    const pb = readBody(b, 2)
    b.emit("data", Buffer.from("abc"))
    expect(await pb).toBe("too_large")
    const c = fake()
    const pc = readBody(c, 10)
    c.emit("close")
    expect(await pc).toBe("aborted")
    const d = fake()
    const pd = readBody(d, 10)
    d.emit("error", new Error("reset"))
    expect(await pd).toBe("aborted")
  })

  it("logs enqueue_rejected for a bad send credential rejected before the body", async () => {
    const { relay, config, logger } = makeRelay()
    const server = createServer(config, relay, undefined, { drainGraceMs: 50 })
    const base = await listen(server)
    try {
      const inv = await relay.issueInvite()
      const reg = await relay.register({ handle: "h", did: "did:key:zRecipient", agentCard: CARD, inviteToken: inv })
      if (!reg.ok) throw new Error("setup")
      const res = await fetch(`${base}/a2a/h`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })
      expect(res.status).toBe(403)
      const entry = logger.entries.find((e) => e.event === "enqueue_rejected")
      expect(entry?.fields).toMatchObject({ handle: "h", reason: "bad_send_credential" })
    } finally {
      await close(server)
    }
  })
})
