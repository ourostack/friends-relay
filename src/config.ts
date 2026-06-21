// config — 12-factor config, read ENTIRELY from injected env. The relay is
// infra-agnostic: NOTHING about any cloud, region, or managed service is hardcoded,
// so it runs on whatever infrastructure a deployment provides. It reads its bind
// address, TLS posture (terminated upstream by an injected proxy by default), invite
// policy, quotas/limits/TTL, its own DID/URL, and the admin credential from env.

import type { InboxBounds } from "./store/memory"
import type { RateLimitConfig } from "./security/rate-limit"

/** Registration policy. `closed` (default) = invite-gated. `open` = a per-deploy
 * POLICY choice that accepts the spam/DoS surface (still rate-limited, quota'd,
 * bounded — never content-filtered). */
export type InvitePolicy = "closed" | "open"

/** The fully-resolved relay config. */
export interface RelayConfig {
  /** TCP bind host + port for the HTTP server. */
  bindHost: string
  bindPort: number
  /** The relay's public base URL (goes on its agent card). */
  publicUrl: string
  /** The relay's own DID. */
  did: string
  /** Version string (the relay's card version). */
  version: string
  /** The A2A protocol version it advertises. */
  protocolVersion: string
  /** Registration policy. */
  invitePolicy: InvitePolicy
  /** The admin credential gating invite issuance (`POST /admin/invites`). Required
   * when the policy is `closed` (otherwise no invites could ever be minted). */
  adminCredential: string | undefined
  /** A credential gating directory lookups (anti-harvest — no anon enumeration). */
  directoryCredential: string | undefined
  /** Per-handle inbox bounds (DoS floor). */
  inboxBounds: InboxBounds
  /** Per-message TTL in ms (queued messages drop past this). */
  messageTtlMs: number
  /** Per-send-credential rate limit. */
  sendRateLimit: RateLimitConfig
}

/** Parse a positive integer env var with a default. Throws on a present-but-invalid
 * value (fail loud — a misconfigured limit is a security/availability bug). */
function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key]
  if (raw === undefined || raw === "") return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`config: ${key} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

/** Resolve config from an env bag (defaults to process.env). Throws on an invalid
 * combination (e.g. closed policy with no admin credential — there'd be no way to
 * issue invites, so registration would be permanently impossible). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const invitePolicy: InvitePolicy = env.RELAY_INVITE_POLICY === "open" ? "open" : "closed"
  const adminCredential = env.RELAY_ADMIN_CREDENTIAL || undefined
  const directoryCredential = env.RELAY_DIRECTORY_CREDENTIAL || undefined

  if (invitePolicy === "closed" && !adminCredential) {
    throw new Error(
      "config: RELAY_ADMIN_CREDENTIAL is required when RELAY_INVITE_POLICY is closed " +
        "(without it no invite could ever be issued and registration would be impossible)",
    )
  }

  return {
    bindHost: env.RELAY_BIND_HOST || "0.0.0.0",
    bindPort: intEnv(env, "RELAY_BIND_PORT", 8080),
    publicUrl: env.RELAY_PUBLIC_URL || "https://relay.invalid",
    did: env.RELAY_DID || "did:web:relay.invalid",
    version: env.RELAY_VERSION || "0.1.0-alpha.1",
    protocolVersion: env.RELAY_PROTOCOL_VERSION || "0.3.0",
    invitePolicy,
    adminCredential,
    directoryCredential,
    inboxBounds: {
      maxMessages: intEnv(env, "RELAY_INBOX_MAX_MESSAGES", 256),
      maxBytes: intEnv(env, "RELAY_INBOX_MAX_BYTES", 4 * 1024 * 1024),
    },
    messageTtlMs: intEnv(env, "RELAY_MESSAGE_TTL_MS", 7 * 24 * 60 * 60 * 1000),
    sendRateLimit: {
      capacity: intEnv(env, "RELAY_SEND_RATE_CAPACITY", 60),
      refillPerSec: intEnv(env, "RELAY_SEND_RATE_REFILL_PER_SEC", 1),
    },
  }
}
