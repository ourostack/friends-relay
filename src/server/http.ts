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
import { silentLogger } from "../logger"
import type { Logger } from "../logger"
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

/** The pure router: (config, relay, request) → response. No sockets. Async because
 * the relay core is async (its storage seam is). */
export async function handle(config: RelayConfig, relay: Relay, req: RelayRequest): Promise<RelayResponse> {
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
    if (!adminAllowed(config, req)) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    const uses = readUses(req.body)
    if (uses === null) {
      return { status: 400, body: { error: "bad_request" } }
    }
    return { status: 200, body: { inviteToken: await relay.issueInvite(uses) } }
  }

  // ── register (invite-gated) ──
  if (req.method === "POST" && req.path === "/register") {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = await relay.register({
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
    if (!req.bearer || !(await relay.ownsInbox(handle, req.bearer))) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    await relay.deregister(handle)
    return { status: 200, body: { ok: true } }
  }

  // ── A2A forward: enqueue an OPAQUE message to a handle (send-credential gated) ──
  const a2aMatch = /^\/a2a\/([^/]+)$/.exec(req.path)
  if (req.method === "POST" && a2aMatch) {
    const handle = decodeURIComponent(a2aMatch[1])
    const sendCredential = req.bearer ?? ""
    const result = await relay.enqueue({ handle, sendCredential, message: req.body })
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
    const result = await relay.pull(handle, req.bearer ?? "")
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
    const result = await relay.ack(handle, req.bearer ?? "", queueId)
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
    const entry = await relay.lookupByHandle(handle)
    return entry ? { status: 200, body: entry } : JSON_404
  }

  // ── directory lookup by DID ──
  const dirDidMatch = /^\/directory\/by-did\/(.+)$/.exec(req.path)
  if (req.method === "GET" && dirDidMatch) {
    if (!directoryAllowed(config, req)) {
      return { status: 401, body: { error: "unauthorized" } }
    }
    const did = decodeURIComponent(dirDidMatch[1])
    const entry = await relay.lookupByDid(did)
    return entry ? { status: 200, body: entry } : JSON_404
  }

  return JSON_404
}

/** Admin gating: a configured admin credential, presented as the bearer. */
function adminAllowed(config: RelayConfig, req: RelayRequest): boolean {
  return Boolean(config.adminCredential) && req.bearer === config.adminCredential
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

/** The default cap on a request body: 1 MiB. Every JSON body this relay accepts (an
 * invite request, a registration, one sealed message bounded by the inbox byte quota)
 * is far smaller; anything bigger is refused before it can be buffered into memory. */
export const MAX_BODY_BYTES = 1024 * 1024

/** Tunables for `createServer`. */
export interface ServerOptions {
  /** Maximum request body in bytes (default `MAX_BODY_BYTES`). */
  maxBodyBytes?: number
  /** How long to keep discarding an unread body after an early rejection before the
   * connection is destroyed (default `DRAIN_GRACE_MS`). */
  drainGraceMs?: number
}

/** Default grace for discarding an unread body after an early rejection. */
export const DRAIN_GRACE_MS = 1000

/** Credential checks that need only the request line + headers, run BEFORE the body is
 * read so an unauthenticated caller cannot make the server buffer anything. Returns the
 * same rejection `handle()` would give for that credential, or undefined to continue.
 * Routes whose credential is checked here: admin invite issuance, deregistration, and
 * the A2A send. (Pull/ack/directory carry no body; /register is gated by an invite
 * token inside the body, so it relies on the size cap alone.) */
export async function authorizeBeforeBody(config: RelayConfig, relay: Relay, req: RelayRequest): Promise<RelayResponse | undefined> {
  if (req.method === "POST" && req.path === "/admin/invites") {
    return adminAllowed(config, req) ? undefined : { status: 401, body: { error: "unauthorized" } }
  }
  const deregMatch = /^\/register\/([^/]+)$/.exec(req.path)
  if (req.method === "DELETE" && deregMatch) {
    const handle = decodeURIComponent(deregMatch[1])
    return req.bearer && (await relay.ownsInbox(handle, req.bearer)) ? undefined : { status: 401, body: { error: "unauthorized" } }
  }
  const a2aMatch = /^\/a2a\/([^/]+)$/.exec(req.path)
  if (req.method === "POST" && a2aMatch) {
    const error = await relay.checkSendAccess(decodeURIComponent(a2aMatch[1]), req.bearer ?? "")
    return error ? { status: enqueueStatus(error), body: { error } } : undefined
  }
  return undefined
}

/** Read the request body, giving up (null) as soon as more than `limit` bytes arrive. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (c: Buffer): void => {
      size += c.length
      if (size > limit) {
        req.off("data", onData)
        req.off("end", onEnd)
        resolve(null)
        return
      }
      chunks.push(c)
    }
    const onEnd = (): void => resolve(Buffer.concat(chunks))
    req.on("data", onData)
    req.on("end", onEnd)
  })
}

/** Answer without having consumed the request body: discard (never
 * buffer) whatever the client is still sending so it can read the response instead of
 * hitting a reset (closing a socket with unread data resets it), and destroy the request after `graceMs` so a
 * client that never stops sending cannot hold the socket open. */
function respondAndClose(req: IncomingMessage, res: ServerResponse, response: RelayResponse, graceMs: number): void {
  res.writeHead(response.status, { "content-type": "application/json" })
  res.end(JSON.stringify(response.body))
  req.resume()
  const timer = setTimeout(() => req.destroy(), graceMs)
  timer.unref()
  req.once("close", () => clearTimeout(timer))
}

const PAYLOAD_TOO_LARGE: RelayResponse = { status: 413, body: { error: "payload_too_large" } }

/** Bind the pure router to a real node:http server. The only un-pure wiring. `logger`
 * is used SOLELY to record a static event when a request handler rejects (e.g. a
 * Postgres query throws mid-request) — it logs an event NAME only, never the error
 * message / connection string / any content (the relay is content-blind end to end). */
export function createServer(config: RelayConfig, relay: Relay, logger: Logger = silentLogger, options: ServerOptions = {}): Server {
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES
  const graceMs = options.drainGraceMs ?? DRAIN_GRACE_MS
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // The handler is async + can REJECT (the storage seam is async — a Postgres
    // query can throw mid-request). Without this `.catch` the socket would hang
    // forever (no response) AND the rejection would be unhandled. The catch writes a
    // generic 500 + ends the socket, and logs a STATIC event name only — the caught
    // error is deliberately NOT inspected, so nothing it carries (a message body, a
    // connection string, any content) can leak into the log or the response.
    void (async () => {
      const headers = req.headers as Record<string, string | undefined>
      const head = toRelayRequest({ method: req.method, url: req.url, headers, body: undefined })
      // 1. Turn away a missing/wrong credential before reading a single body byte.
      const denied = await authorizeBeforeBody(config, relay, head)
      if (denied) {
        respondAndClose(req, res, denied, graceMs)
        return
      }
      // 2. A declared length over the cap is refused up front; an undeclared or
      //    understated one is caught while streaming.
      if (Number(headers["content-length"]) > limit) {
        respondAndClose(req, res, PAYLOAD_TOO_LARGE, graceMs)
        return
      }
      const buf = await readBody(req, limit)
      if (buf === null) {
        respondAndClose(req, res, PAYLOAD_TOO_LARGE, graceMs)
        return
      }
      const raw = buf.toString("utf8")
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
      const response = await handle(config, relay, { ...head, body })
      res.writeHead(response.status, { "content-type": "application/json" })
      res.end(JSON.stringify(response.body))
    })().catch(() => {
      logger.log("error", "request_failed")
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
      }
      res.end(JSON.stringify({ error: "internal_error" }))
    })
  })
}
