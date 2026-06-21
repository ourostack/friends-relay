// server/http — the HTTP surface over node:http. It maps requests to the Relay
// core and enforces edge gating (admin credential for invite issuance; directory
// credential for lookups — anti-harvest). Bodies are JSON. The A2A forward path
// (`POST /a2a/{handle}`) carries the OPAQUE message; this layer never inspects its
// content (it hands the raw parsed body to the core, which validates SHAPE only).
//
// Pure request→response mapping is factored into `handle()` so it is fully testable
// WITHOUT a real socket; `createServer` is the thin node:http binding around it.
import { createServer as createHttpServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import type { RelayConfig } from "../config"
import type { Relay } from "../relay"

/** A transport-free representation of an HTTP request (so handlers are pure +
 * testable without a socket). */
export interface RelayRequest {
  method: string
  /** The path WITHOUT query string (e.g. "/a2a/h1"). */
  path: string
  /** Parsed Authorization bearer token, if present. */
  bearer?: string
  /** A header bag (lowercased keys) for non-bearer credentials. */
  headers: Record<string, string | undefined>
  /** The parsed JSON body (or undefined for no/empty body). */
  body?: unknown
}

/** A transport-free HTTP response. */
export interface RelayResponse {
  status: number
  body: unknown
}

const JSON_404: RelayResponse = { status: 404, body: { error: "not_found" } }

/** Extract a Bearer token from an Authorization header value. */
export function parseBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer (.+)$/.exec(authHeader)
  return m ? m[1] : undefined
}

/** Map an EnqueueError to an HTTP status. Auth/credential failures → 401/403,
 * shape/routing → 400, capacity → 429 (rate) / 507 (quota). */
function enqueueStatus(error: string): number {
  switch (error) {
    case "unknown_handle":
      return 404
    case "bad_send_credential":
      return 403
    case "rate_limited":
      return 429
    case "quota_count":
    case "quota_bytes":
      return 507
    default:
      // malformed_message / recipient_mismatch
      return 400
  }
}

/** Map a RegisterError to an HTTP status. */
function registerStatus(error: string): number {
  switch (error) {
    case "invite_required":
    case "invite_invalid":
      return 403
    default:
      return 400
  }
}

/** The pure router: (config, relay, request) → response. No sockets. */
export function handle(config: RelayConfig, relay: Relay, req: RelayRequest): RelayResponse {
  // ── liveness ──
  if (req.method === "GET" && req.path === "/healthz") {
    return { status: 200, body: { ok: true } }
  }

  // ── the relay's own A2A card ──
  if (req.method === "GET" && req.path === "/.well-known/agent-card.json") {
    return { status: 200, body: relay.agentCard() }
  }

  // ── admin: issue an invite (admin-credential gated) ──
  if (req.method === "POST" && req.path === "/admin/invites") {
    if (!config.adminCredential || req.bearer !== config.adminCredential) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    const uses = readUses(req.body)
    if (uses === null) {
      return { status: 400, body: { error: "bad_request" } }
    }
    return { status: 200, body: { inviteToken: relay.issueInvite(uses) } }
  }

  // ── register (invite-gated) ──
  if (req.method === "POST" && req.path === "/register") {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = relay.register({
      handle: typeof body.handle === "string" ? body.handle : "",
      did: typeof body.did === "string" ? body.did : "",
      agentCard: (body.agentCard ?? null) as never,
      keyAgreementPubKey: typeof body.keyAgreementPubKey === "string" ? body.keyAgreementPubKey : undefined,
      inviteToken: typeof body.inviteToken === "string" ? body.inviteToken : undefined,
    })
    if (!result.ok) {
      return { status: registerStatus(result.error), body: { error: result.error } }
    }
    return { status: 200, body: { ...result.grant, relayCard: result.relayCard } }
  }

  // ── deregister (inbox-auth'd) ──
  const deregMatch = /^\/register\/([^/]+)$/.exec(req.path)
  if (req.method === "DELETE" && deregMatch) {
    const handle = decodeURIComponent(deregMatch[1])
    // `ownsInbox` passing means the credential is bound to a live registration, so
    // `deregister` always removes it (returns true) — no 404 path is reachable here.
    if (!req.bearer || !relay.ownsInbox(handle, req.bearer)) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    relay.deregister(handle)
    return { status: 200, body: { ok: true } }
  }

  // ── A2A forward: enqueue an OPAQUE message to a handle (send-credential gated) ──
  const a2aMatch = /^\/a2a\/([^/]+)$/.exec(req.path)
  if (req.method === "POST" && a2aMatch) {
    const handle = decodeURIComponent(a2aMatch[1])
    const sendCredential = req.bearer ?? ""
    const result = relay.enqueue({ handle, sendCredential, message: req.body })
    if (!result.ok) {
      return { status: enqueueStatus(result.error), body: { error: result.error } }
    }
    // A2A: the relay's job is queueing, not importing — the task is `submitted`.
    return { status: 202, body: { taskId: result.queueId, state: "submitted" } }
  }

  // ── pull a handle's inbox (inbox-auth'd) ──
  const pullMatch = /^\/inbox\/([^/]+)$/.exec(req.path)
  if (req.method === "GET" && pullMatch) {
    const handle = decodeURIComponent(pullMatch[1])
    const result = relay.pull(handle, req.bearer ?? "")
    if (!result.ok) {
      return { status: 401, body: { error: result.error } }
    }
    return { status: 200, body: { messages: result.messages } }
  }

  // ── ack a delivered message (inbox-auth'd) ──
  const ackMatch = /^\/inbox\/([^/]+)\/ack\/([^/]+)$/.exec(req.path)
  if (req.method === "POST" && ackMatch) {
    const handle = decodeURIComponent(ackMatch[1])
    const queueId = decodeURIComponent(ackMatch[2])
    const result = relay.ack(handle, req.bearer ?? "", queueId)
    if (!result.ok) {
      return { status: 401, body: { error: result.error } }
    }
    return { status: 200, body: { acked: result.existed } }
  }

  // ── directory lookup by handle (directory-credential gated; no anon enumeration) ──
  const dirHandleMatch = /^\/directory\/([^/]+)$/.exec(req.path)
  if (req.method === "GET" && dirHandleMatch && req.path.indexOf("/by-did/") === -1) {
    if (!directoryAllowed(config, req)) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    const handle = decodeURIComponent(dirHandleMatch[1])
    const entry = relay.lookupByHandle(handle)
    return entry ? { status: 200, body: entry } : JSON_404
  }

  // ── directory lookup by DID ──
  const dirDidMatch = /^\/directory\/by-did\/(.+)$/.exec(req.path)
  if (req.method === "GET" && dirDidMatch) {
    if (!directoryAllowed(config, req)) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    const did = decodeURIComponent(dirDidMatch[1])
    const entry = relay.lookupByDid(did)
    return entry ? { status: 200, body: entry } : JSON_404
  }

  return JSON_404
}

/** Directory gating: if a directory credential is configured, require it; if none
 * is configured the directory is open (a deliberate per-deploy choice). */
function directoryAllowed(config: RelayConfig, req: RelayRequest): boolean {
  if (!config.directoryCredential) return true
  return req.bearer === config.directoryCredential
}

/** Read the optional `uses` field for an invite. Returns the count, defaulting to 1,
 * or null if present-but-invalid. */
function readUses(body: unknown): number | null {
  if (!body || typeof body !== "object") return 1
  const uses = (body as Record<string, unknown>).uses
  if (uses === undefined) return 1
  if (typeof uses !== "number" || !Number.isInteger(uses) || uses < 1) return null
  return uses
}

/** Build a transport-free RelayRequest from the raw node:http fields. Pure +
 * testable (including the `undefined` method/url fallbacks node's types allow). */
export function toRelayRequest(input: {
  method: string | undefined
  url: string | undefined
  headers: Record<string, string | undefined>
  body: unknown
}): RelayRequest {
  const url = input.url ?? "/"
  return {
    method: input.method ?? "GET",
    path: url.split("?")[0],
    bearer: parseBearer(input.headers.authorization),
    headers: input.headers,
    body: input.body,
  }
}

/** Bind the pure router to a real node:http server. The only un-pure wiring. */
export function createServer(config: RelayConfig, relay: Relay): Server {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let body: unknown
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "bad_json" }))
          return
        }
      }
      const response = handle(
        config,
        relay,
        toRelayRequest({
          method: req.method,
          url: req.url,
          headers: req.headers as Record<string, string | undefined>,
          body,
        }),
      )
      res.writeHead(response.status, { "content-type": "application/json" })
      res.end(JSON.stringify(response.body))
    })
  })
}
