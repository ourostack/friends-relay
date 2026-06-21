// store/memory — the reference in-memory backends (the v1 + test default). They
// implement the swappable interfaces; a production deployment swaps in a durable
// adapter without touching the relay core.
//
// SECURITY-RELEVANT: the InboxStore is BOUNDED. Each handle's queue is capped by a
// message COUNT and a total BYTE budget; an enqueue past either cap is DROPPED (not
// queued). This is the DoS floor — no unbounded growth, ever. Dropping is safe
// because recipient imports are idempotent (a drop is a denial, never corruption).

import type { EnqueueResult, InboxStore, RegistryStore } from "./interfaces"
import type { Registration, QueuedMessage, A2AMessage } from "../types"

/** Per-handle inbox bounds. Both are hard caps — exceeding either drops the
 * enqueue. Defaults are conservative; a deployment tunes them via config. */
export interface InboxBounds {
  /** Max queued (non-expired) messages per handle. */
  maxMessages: number
  /** Max total queued bytes per handle. */
  maxBytes: number
}

/** A bounded, in-memory InboxStore. */
export class MemoryInboxStore implements InboxStore {
  private readonly queues = new Map<string, QueuedMessage[]>()
  private seq = 0

  constructor(private readonly bounds: InboxBounds) {}

  enqueue(input: {
    handle: string
    message: A2AMessage
    enqueuedAt: number
    expiresAt: number
    sizeBytes: number
  }): EnqueueResult {
    // Read the live (non-expired) queue so expired entries don't count against the
    // bound (and get dropped as a side effect of pruning).
    const live = this.livePrune(input.handle, input.enqueuedAt)

    if (live.length >= this.bounds.maxMessages) {
      return { ok: false, reason: "quota_count" }
    }
    const currentBytes = live.reduce((sum, q) => sum + q.sizeBytes, 0)
    if (currentBytes + input.sizeBytes > this.bounds.maxBytes) {
      return { ok: false, reason: "quota_bytes" }
    }

    this.seq += 1
    const queueId = `q${this.seq}`
    live.push({
      queueId,
      message: input.message,
      enqueuedAt: input.enqueuedAt,
      expiresAt: input.expiresAt,
      sizeBytes: input.sizeBytes,
    })
    this.queues.set(input.handle, live)
    return { ok: true, queueId }
  }

  list(handle: string, now: number): QueuedMessage[] {
    return this.livePrune(handle, now).slice()
  }

  ack(handle: string, queueId: string): boolean {
    const q = this.queues.get(handle)
    if (!q) return false
    const idx = q.findIndex((m) => m.queueId === queueId)
    if (idx === -1) return false
    q.splice(idx, 1)
    if (q.length === 0) this.queues.delete(handle)
    return true
  }

  dropExpired(now: number): number {
    let dropped = 0
    for (const [handle, q] of this.queues) {
      const before = q.length
      const kept = q.filter((m) => m.expiresAt > now)
      dropped += before - kept.length
      if (kept.length === 0) {
        this.queues.delete(handle)
      } else if (kept.length !== before) {
        this.queues.set(handle, kept)
      }
    }
    return dropped
  }

  depth(handle: string, now: number): number {
    return this.livePrune(handle, now).length
  }

  /** Return `handle`'s queue with expired entries removed (and the map updated). */
  private livePrune(handle: string, now: number): QueuedMessage[] {
    const q = this.queues.get(handle)
    if (!q) return []
    const kept = q.filter((m) => m.expiresAt > now)
    if (kept.length === 0) {
      this.queues.delete(handle)
      return []
    }
    if (kept.length !== q.length) {
      this.queues.set(handle, kept)
    }
    return kept
  }
}

/** An in-memory RegistryStore. */
export class MemoryRegistryStore implements RegistryStore {
  private readonly byHandle = new Map<string, Registration>()
  private readonly byDid = new Map<string, Registration>()

  put(reg: Registration): void {
    // A re-registration under the same handle may carry a new DID binding; clear any
    // stale DID index entry that pointed at this handle before re-indexing.
    const prev = this.byHandle.get(reg.handle)
    if (prev && prev.did !== reg.did) {
      this.byDid.delete(prev.did)
    }
    this.byHandle.set(reg.handle, reg)
    this.byDid.set(reg.did, reg)
  }

  getByHandle(handle: string): Registration | undefined {
    return this.byHandle.get(handle)
  }

  getByDid(did: string): Registration | undefined {
    return this.byDid.get(did)
  }

  remove(handle: string): boolean {
    const reg = this.byHandle.get(handle)
    if (!reg) return false
    this.byHandle.delete(handle)
    // Only remove the DID index if it still points at THIS handle's registration.
    if (this.byDid.get(reg.did) === reg) {
      this.byDid.delete(reg.did)
    }
    return true
  }
}
