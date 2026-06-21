// relay — the content-blind, abuse-resistant CORE. It ties registration (invite-
// gated), enqueue (send-credential + rate-limit + per-handle quota + TTL + bounded
// queue), pull (inbox-auth), ack, and the gated directory together. It depends only
// on the storage INTERFACES (swappable backend) + the security primitives.
//
// THE DEFINING SECURITY PROPERTY: the relay NEVER decrypts. There is no key and no
// code path here that reads `sealed.ct`. It sees { recipient handle (=recipientDid),
// size, timing, send-credential, opaque blob } — and routes. Its compromise can
// only deny / delay / leak handle-level metadata; it can never read, forge, tamper,
// re-target, replay-to-effect, or escalate (those are all defeated client-side by
// the a2a-client's sign-then-seal overlay, which the relay does not — cannot —
// weaken).
import { buildRelayAgentCard } from "./agent-card"
import type { Clock } from "./clock"
import type { RelayConfig } from "./config"
import type { Logger } from "./logger"
import { messageSizeBytes, validateOpaqueMessage } from "./message"
import { CredentialManager } from "./security/credentials"
import { InviteManager } from "./security/invites"
import { RateLimiter } from "./security/rate-limit"
import type { TokenSource } from "./security/tokens"
import type { InboxStore, RegistryStore } from "./store/interfaces"
import type {
  A2AMessage,
  PublicAgentCard,
  QueuedMessage,
  RegistrationGrant,
  RelayAgentCard,
} from "./types"

/** Everything the relay core needs injected. Backends + security primitives +
 * clock + logger are all swappable; nothing is hardcoded. */
export interface RelayDeps {
  config: RelayConfig
  inbox: InboxStore
  registry: RegistryStore
  tokens: TokenSource
  clock: Clock
  logger: Logger
}

/** Reasons a registration can be refused. */
export type RegisterError = "invite_required" | "invite_invalid" | "bad_request"

/** Reasons an enqueue (send to a handle) can be refused. Each is a DENIAL — never a
 * corruption (recipient imports are idempotent). */
export type EnqueueError =
  | "unknown_handle"
  | "bad_send_credential"
  | "rate_limited"
  | "quota_count"
  | "quota_bytes"
  | "malformed_message"
  | "recipient_mismatch"

/** Reasons an inbox read/ack can be refused. */
export type InboxError = "bad_inbox_auth"

export interface RegisterInput {
  handle: string
  did: string
  agentCard: PublicAgentCard
  keyAgreementPubKey?: string
  /** Required unless the deployment policy is `open`. */
  inviteToken?: string
}

export interface EnqueueInput {
  /** The recipient handle being posted to (routing target). */
  handle: string
  /** The send credential the sender presents (rate-limit subject; bound to handle). */
  sendCredential: string
  /** The opaque A2A message. The relay validates its SHAPE and never reads content. */
  message: unknown
}

/** The content-blind, abuse-resistant relay. */
export class Relay {
  private readonly invites: InviteManager
  private readonly credentials: CredentialManager
  private readonly sendLimiter: RateLimiter

  constructor(private readonly deps: RelayDeps) {
    this.invites = new InviteManager(deps.tokens)
    this.credentials = new CredentialManager(deps.tokens)
    this.sendLimiter = new RateLimiter(deps.config.sendRateLimit, deps.clock)
  }

  /** The relay's own A2A agent card (it is itself an A2A agent, so a client can
   * verify it reached the expected relay). */
  agentCard(): RelayAgentCard {
    return buildRelayAgentCard({
      url: this.deps.config.publicUrl,
      did: this.deps.config.did,
      version: this.deps.config.version,
      protocolVersion: this.deps.config.protocolVersion,
    })
  }

  // ── invite issuance (admin-gated at the HTTP layer) ──────────────────────────

  /** Issue an invite (the HTTP layer gates this behind the admin credential).
   * `uses` defaults to single-use. */
  issueInvite(uses = 1): string {
    return this.invites.issue(uses)
  }

  // ── registration (invite-gated; rotates credentials) ─────────────────────────

  /** Register (or re-register → ROTATE) a handle. Invite-gated unless policy=open.
   * Returns the credential grant (inboxAuth + rotating sendCredential). */
  register(input: RegisterInput): { ok: true; grant: RegistrationGrant; relayCard: RelayAgentCard } | { ok: false; error: RegisterError } {
    if (
      typeof input.handle !== "string" ||
      input.handle.length === 0 ||
      typeof input.did !== "string" ||
      input.did.length === 0 ||
      !input.agentCard ||
      typeof input.agentCard !== "object"
    ) {
      return { ok: false, error: "bad_request" }
    }

    if (this.deps.config.invitePolicy === "closed") {
      if (!input.inviteToken) {
        this.deps.logger.log("warn", "register_rejected", { handle: input.handle, reason: "invite_required" })
        return { ok: false, error: "invite_required" }
      }
      if (!this.invites.consume(input.inviteToken)) {
        this.deps.logger.log("warn", "register_rejected", { handle: input.handle, reason: "invite_invalid" })
        return { ok: false, error: "invite_invalid" }
      }
    }

    this.deps.registry.put({
      handle: input.handle,
      did: input.did,
      agentCard: input.agentCard,
      keyAgreementPubKey: input.keyAgreementPubKey,
      registeredAt: this.deps.clock.now(),
    })
    const { inboxAuth, sendCredential } = this.credentials.rotate(input.handle)
    this.deps.logger.log("info", "registered", { handle: input.handle, decision: "registered" })
    return {
      ok: true,
      grant: { handle: input.handle, inboxAuth, sendCredential },
      relayCard: this.agentCard(),
    }
  }

  /** Whether `inboxAuth` is the bearer that may drain (and therefore administer)
   * `handle`. The HTTP layer uses this to gate deregistration. */
  ownsInbox(handle: string, inboxAuth: string): boolean {
    return this.credentials.handleForInboxAuth(inboxAuth) === handle
  }

  /** Deregister a handle (auth'd by its inboxAuth at the HTTP layer). Revokes its
   * credentials and removes the registration. Returns whether it existed. */
  deregister(handle: string): boolean {
    this.credentials.revoke(handle)
    const existed = this.deps.registry.remove(handle)
    if (existed) {
      this.deps.logger.log("info", "deregistered", { handle, decision: "deregistered" })
    }
    return existed
  }

  // ── enqueue (the send path: store-and-forward of CIPHERTEXT) ──────────────────

  /** Accept an opaque A2A message addressed to `handle` and queue it. Gated by:
   * (1) the handle exists, (2) the send credential is valid FOR THIS handle,
   * (3) the per-credential rate limit, (4) the DataPart's recipientDid matches the
   * handle's registered DID (a sender can't smuggle a blob sealed to X into Y's
   * queue), (5) the per-handle quota + bound. Every failure is a DENIAL. The relay
   * NEVER reads the sealed content. */
  enqueue(input: EnqueueInput): { ok: true; queueId: string } | { ok: false; error: EnqueueError } {
    const reg = this.deps.registry.getByHandle(input.handle)
    if (!reg) {
      return { ok: false, error: "unknown_handle" }
    }
    if (!this.credentials.canSendTo(input.sendCredential, input.handle)) {
      this.deps.logger.log("warn", "enqueue_rejected", { handle: input.handle, reason: "bad_send_credential" })
      return { ok: false, error: "bad_send_credential" }
    }
    // Rate-limit on the send credential (the rate-limit subject — a rotating
    // credential keeps this from being a stable per-agent identity by default).
    if (!this.sendLimiter.take(input.sendCredential)) {
      this.deps.logger.log("warn", "enqueue_rejected", { handle: input.handle, reason: "rate_limited" })
      return { ok: false, error: "rate_limited" }
    }

    // Validate the SHAPE only — never the content.
    const payload = validateOpaqueMessage(input.message)
    if (!payload) {
      this.deps.logger.log("warn", "enqueue_rejected", { handle: input.handle, reason: "malformed_message" })
      return { ok: false, error: "malformed_message" }
    }
    // The blob's bound recipient DID must match the handle's registered DID — so a
    // blob sealed to a different recipient can't be parked in this handle's inbox.
    if (payload.recipientDid !== reg.did) {
      this.deps.logger.log("warn", "enqueue_rejected", { handle: input.handle, reason: "recipient_mismatch" })
      return { ok: false, error: "recipient_mismatch" }
    }

    const message = input.message as A2AMessage
    const sizeBytes = messageSizeBytes(message)
    const now = this.deps.clock.now()
    const result = this.deps.inbox.enqueue({
      handle: input.handle,
      message,
      enqueuedAt: now,
      expiresAt: now + this.deps.config.messageTtlMs,
      sizeBytes,
    })
    if (!result.ok) {
      // Over quota → DROP (safe). Surface the drop reason; the message is denied.
      this.deps.logger.log("warn", "enqueue_dropped", { handle: input.handle, sizeBytes, reason: result.reason })
      return { ok: false, error: result.reason }
    }
    this.deps.logger.log("info", "enqueued", { handle: input.handle, sizeBytes, decision: "enqueued" })
    return { ok: true, queueId: result.queueId }
  }

  // ── pull + ack (the NAT-traversal read path; inbox-auth'd) ────────────────────

  /** Drain a handle's queued opaque messages (A2A tasks/list-style). Auth'd by the
   * inboxAuth bearer (which must resolve to THIS handle). Expired messages are not
   * returned (and get dropped). The returned messages are still ciphertext. */
  pull(handle: string, inboxAuth: string): { ok: true; messages: QueuedMessage[] } | { ok: false; error: InboxError } {
    if (this.credentials.handleForInboxAuth(inboxAuth) !== handle) {
      this.deps.logger.log("warn", "pull_rejected", { handle, reason: "bad_inbox_auth" })
      return { ok: false, error: "bad_inbox_auth" }
    }
    const messages = this.deps.inbox.list(handle, this.deps.clock.now())
    this.deps.logger.log("info", "pulled", { handle, count: messages.length, decision: "pulled" })
    return { ok: true, messages }
  }

  /** Ack (delete) a delivered message by queueId. Auth'd by the inboxAuth bearer.
   * Returns whether the message existed (idempotent — a re-ack is harmless). */
  ack(handle: string, inboxAuth: string, queueId: string): { ok: true; existed: boolean } | { ok: false; error: InboxError } {
    if (this.credentials.handleForInboxAuth(inboxAuth) !== handle) {
      this.deps.logger.log("warn", "ack_rejected", { handle, reason: "bad_inbox_auth" })
      return { ok: false, error: "bad_inbox_auth" }
    }
    const existed = this.deps.inbox.ack(handle, queueId)
    return { ok: true, existed }
  }

  // ── directory (gated lookup — anti-harvest, no anon enumeration) ──────────────

  /** Directory lookup by handle. Returns the registrant's PUBLIC card + handle +
   * pinned keyAgreement pubkey, or null. Gating (the directory credential) is
   * enforced at the HTTP layer — there is no list-ALL surface. */
  lookupByHandle(handle: string): { agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string } | null {
    const reg = this.deps.registry.getByHandle(handle)
    if (!reg) return null
    return { agentCard: reg.agentCard, handle: reg.handle, keyAgreementPubKey: reg.keyAgreementPubKey }
  }

  /** Directory lookup by DID. */
  lookupByDid(did: string): { agentCard: PublicAgentCard; handle: string; keyAgreementPubKey?: string } | null {
    const reg = this.deps.registry.getByDid(did)
    if (!reg) return null
    return { agentCard: reg.agentCard, handle: reg.handle, keyAgreementPubKey: reg.keyAgreementPubKey }
  }

  // ── maintenance ───────────────────────────────────────────────────────────────

  /** Sweep expired messages across all inboxes (a scheduled DoS-hygiene task).
   * Returns the count dropped. Dropping is always safe. */
  sweepExpired(): number {
    const dropped = this.deps.inbox.dropExpired(this.deps.clock.now())
    if (dropped > 0) {
      this.deps.logger.log("info", "swept_expired", { count: dropped, decision: "swept" })
    }
    return dropped
  }
}
