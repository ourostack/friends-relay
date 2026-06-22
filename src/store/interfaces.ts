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
