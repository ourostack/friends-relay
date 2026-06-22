// store/interfaces — the swappable backend seam. The inbox store is an interface; a
// reference in-memory impl ships; production backends are adapters; NO infra is
// hardcoded. The relay core depends ONLY on these interfaces, so a deployment can
// back them with any queue/KV/object store via an adapter. This file is pure types —
// excluded from the coverage gate (a pure interface).

import type { Registration, QueuedMessage, A2AMessage } from "../types"

/** The outcome of an enqueue attempt. The relay is DROPPABLE: over-quota /
 * bound-exceeded messages are dropped, which is always SAFE (recipient imports are
 * idempotent — a drop is a denial, never a corruption). */
export type EnqueueResult =
  | { ok: true; queueId: string }
  | { ok: false; reason: "quota_count" | "quota_bytes" }

/** A store of per-handle inbox queues of OPAQUE messages. Single-writer-per-inbox
 * semantics at the storage layer (no cross-handle interference). It is a QUEUE of
 * ciphertext blobs that get dropped on ack/expiry — NOT a content store.
 *
 * ALL methods are async (`Promise`-returning): the seam must accommodate a durable
 * backend (Postgres `pg`, which is necessarily async). The in-memory reference impl
 * satisfies this trivially (its bodies are synchronous, wrapped in `async`). */
export interface InboxStore {
  /** Enqueue an opaque message for `handle` with a TTL `expiresAt`, subject to the
   * per-handle count + byte quota. Returns the queueId on success, or a drop reason.
   * `sizeBytes` is the message's serialized size (quota accounting metadata). */
  enqueue(input: {
    handle: string
    message: A2AMessage
    enqueuedAt: number
    expiresAt: number
    sizeBytes: number
  }): Promise<EnqueueResult>

  /** List the (non-expired) queued messages for `handle` — the NAT-traversal read
   * path (A2A tasks/list-style). Expired messages are not returned (and are
   * dropped). `now` drives the TTL filter. */
  list(handle: string, now: number): Promise<QueuedMessage[]>

  /** Ack (delete) a delivered message by queueId. Returns true if it existed.
   * Cleanup is the relay holding nothing long-term. */
  ack(handle: string, queueId: string): Promise<boolean>

  /** Drop all expired messages across all handles (a sweep). Returns the count
   * dropped. Dropping is always safe. */
  dropExpired(now: number): Promise<number>

  /** The current queued count for `handle` (non-expired) — for quota/metrics. */
  depth(handle: string, now: number): Promise<number>
}

/** A store of registrations (handle → record) + the directory lookups. It knows
 * handle → {card, did, pinned key} and NOTHING about the social graph.
 *
 * ALL methods are async (`Promise`-returning) — same rationale as `InboxStore`. */
export interface RegistryStore {
  /** Create or REPLACE a registration (re-registration rotates credentials at the
   * relay layer; this just persists the record). */
  put(reg: Registration): Promise<void>

  /** Look up by handle. */
  getByHandle(handle: string): Promise<Registration | undefined>

  /** Look up by DID (directory by-did path). */
  getByDid(did: string): Promise<Registration | undefined>

  /** Remove a registration. Returns true if it existed. */
  remove(handle: string): Promise<boolean>
}

/** A store of invite tokens → remaining-use counters. Pure persistence: the
 * use-cap / single-use ENFORCEMENT lives in `InviteManager` (logic-over-store); this
 * just records and mutates the counter. ALL methods async (durable-backend seam). */
export interface InviteStore {
  /** Set the remaining-use counter for `token` (issuance). */
  setRemaining(token: string, remaining: number): Promise<void>

  /** Read the remaining uses for `token`, or undefined if unknown. */
  getRemaining(token: string): Promise<number | undefined>

  /** Atomically consume one use of `token`: if it exists with >= 1 remaining,
   * decrement it (deleting it at 0) and return true; otherwise return false. The
   * atomicity is the store's responsibility so a single-use token can't be
   * double-spent under concurrency. */
  decrementOrDelete(token: string): Promise<boolean>
}

/** The current credential pair bound to a handle. */
export interface CredentialPair {
  inboxAuth: string
  sendCredential: string
}

/** A store of credential bindings: handle → its current (inboxAuth, sendCredential)
 * pair, plus the two reverse lookups. Pure persistence: the rotation
 * revoke-then-mint SEQUENCING lives in `CredentialManager`. ALL methods async. */
export interface CredentialStore {
  /** Set (or REPLACE) the current pair for `handle`. Replacing atomically supersedes
   * the prior pair so the old tokens stop resolving via the reverse lookups. */
  setCurrent(handle: string, pair: CredentialPair): Promise<void>

  /** The current pair for `handle`, or undefined. */
  getCurrent(handle: string): Promise<CredentialPair | undefined>

  /** Delete `handle`'s binding IFF its current pair equals `pair` (revoke). A no-op
   * if absent or already rotated away. */
  deleteFor(handle: string, pair: CredentialPair): Promise<void>

  /** Resolve an inboxAuth bearer to the handle it may drain, or null. */
  handleForInboxAuth(inboxAuth: string): Promise<string | null>

  /** Resolve a send credential to the handle it may post to, or null. */
  handleForSendCredential(sendCredential: string): Promise<string | null>
}
