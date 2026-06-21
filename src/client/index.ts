// client — the thin RelayClient. A friends-using agent imports this to talk to a
// relay over its HTTP API (register / send / pull / ack / directory) without
// hand-rolling fetch. It carries the SAME opaque A2A message the a2a-client builds;
// it never reads or constructs sealed content (that's the a2a-client's job).
//
// `fetch` is INJECTABLE so the client is testable without a real network and so a
// host can supply its own (proxy, retry, mTLS) — defaulting to the global fetch.
import type { A2AMessage, PublicAgentCard, QueuedMessage, RelayAgentCard } from "../types"

/** The minimal fetch shape the client needs (a subset of the WHATWG fetch). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface RelayClientOptions {
  /** The relay's base URL (no trailing slash). */
  baseUrl: string
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: FetchLike
}

/** The grant returned from a successful registration. */
export interface ClientRegistrationGrant {
  handle: string
  inboxAuth: string
  sendCredential: string
  relayCard: RelayAgentCard
}

export interface RegisterArgs {
  handle: string
  did: string
  agentCard: PublicAgentCard
  keyAgreementPubKey?: string
  inviteToken?: string
}

/** A thin, typed HTTP client for the relay. Throws on a non-2xx (with the relay's
 * error code) so callers fail loud. */
export class RelayClient {
  private readonly baseUrl: string
  private readonly doFetch: FetchLike

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    const injected = opts.fetch
    // Default to the global fetch, bound so `this` is correct.
    this.doFetch = injected ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init))
  }

  /** Issue an invite (admin-credential gated). */
  async issueInvite(adminCredential: string, uses?: number): Promise<string> {
    const res = await this.req("POST", "/admin/invites", { bearer: adminCredential, body: uses === undefined ? {} : { uses } })
    return (res as { inviteToken: string }).inviteToken
  }

  /** Register (or re-register → rotate) a handle. */
  async register(args: RegisterArgs): Promise<ClientRegistrationGrant> {
    const res = await this.req("POST", "/register", { body: args })
    return res as ClientRegistrationGrant
  }

  /** Deregister a handle (inbox-auth'd). */
  async deregister(handle: string, inboxAuth: string): Promise<void> {
    await this.req("DELETE", `/register/${encodeURIComponent(handle)}`, { bearer: inboxAuth })
  }

  /** Send an OPAQUE A2A message to a handle (send-credential'd). The message is
   * carried byte-for-byte; the client never reads its sealed content. Returns the
   * relay's task id. */
  async send(handle: string, sendCredential: string, message: A2AMessage): Promise<string> {
    const res = await this.req("POST", `/a2a/${encodeURIComponent(handle)}`, { bearer: sendCredential, body: message })
    return (res as { taskId: string }).taskId
  }

  /** Pull a handle's queued opaque messages (inbox-auth'd). */
  async pull(handle: string, inboxAuth: string): Promise<QueuedMessage[]> {
    const res = await this.req("GET", `/inbox/${encodeURIComponent(handle)}`, { bearer: inboxAuth })
    return (res as { messages: QueuedMessage[] }).messages
  }

  /** Ack (delete) a delivered message (inbox-auth'd). */
  async ack(handle: string, inboxAuth: string, queueId: string): Promise<boolean> {
    const res = await this.req("POST", `/inbox/${encodeURIComponent(handle)}/ack/${encodeURIComponent(queueId)}`, { bearer: inboxAuth })
    return (res as { acked: boolean }).acked
  }

  /** Directory lookup by handle. Returns null on 404. */
  async lookupByHandle(handle: string, directoryCredential?: string): Promise<{ agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string } | null> {
    return this.lookup(`/directory/${encodeURIComponent(handle)}`, directoryCredential)
  }

  /** Directory lookup by DID. Returns null on 404. */
  async lookupByDid(did: string, directoryCredential?: string): Promise<{ agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string } | null> {
    return this.lookup(`/directory/by-did/${encodeURIComponent(did)}`, directoryCredential)
  }

  /** The relay's own A2A card. */
  async relayCard(): Promise<RelayAgentCard> {
    const res = await this.req("GET", "/.well-known/agent-card.json", {})
    return res as RelayAgentCard
  }

  // ── internals ──

  private async lookup(
    path: string,
    directoryCredential?: string,
  ): Promise<{ agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string } | null> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: directoryCredential ? { authorization: `Bearer ${directoryCredential}` } : {},
    })
    if (res.status === 404) return null
    const json = await res.json()
    if (res.status < 200 || res.status >= 300) {
      throw new RelayClientError(res.status, (json as { error?: string }).error ?? "error")
    }
    return json as { agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string }
  }

  private async req(
    method: string,
    path: string,
    opts: { bearer?: string; body?: unknown },
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const json = await res.json()
    if (res.status < 200 || res.status >= 300) {
      throw new RelayClientError(res.status, (json as { error?: string }).error ?? "error")
    }
    return json
  }
}

/** Thrown on a non-2xx relay response, carrying the relay's error code. */
export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`relay error ${status}: ${code}`)
    this.name = "RelayClientError"
  }
}
