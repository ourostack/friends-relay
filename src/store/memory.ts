// store/memory — the reference in-memory backends (the v1 + test default). They
// implement the swappable interfaces; a production deployment swaps in a durable
// adapter without touching the relay core.
//
// SECURITY-RELEVANT: the InboxStore is BOUNDED. Each handle's queue is capped by a
// message COUNT and a total BYTE budget; an enqueue past either cap is DROPPED (not
// queued). This is the DoS floor — no unbounded growth, ever. Dropping is safe
// because recipient imports are idempotent (a drop is a denial, never corruption).

import type {
  CredentialPair,
  CredentialStore,
  EnqueueResult,
  InboxStore,
  InviteStore,
  RegistryStore,
} from "./interfaces"
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

  async enqueue(input: {
    handle: string
    message: A2AMessage
    enqueuedAt: number
    expiresAt: number
    sizeBytes: number
  }): Promise<EnqueueResult> {
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

  async list(handle: string, now: number): Promise<QueuedMessage[]> {
    return this.livePrune(handle, now).slice()
  }

  async ack(handle: string, queueId: string): Promise<boolean> {
    const q = this.queues.get(handle)
    if (!q) return false
    const idx = q.findIndex((m) => m.queueId === queueId)
    if (idx === -1) return false
    q.splice(idx, 1)
    if (q.length === 0) this.queues.delete(handle)
    return true
  }

  async dropExpired(now: number): Promise<number> {
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

  async depth(handle: string, now: number): Promise<number> {
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

  async put(reg: Registration): Promise<void> {
    // A re-registration under the same handle may carry a new DID binding; clear any
    // stale DID index entry that pointed at this handle before re-indexing.
    const prev = this.byHandle.get(reg.handle)
    if (prev && prev.did !== reg.did) {
      this.byDid.delete(prev.did)
    }
    this.byHandle.set(reg.handle, reg)
    this.byDid.set(reg.did, reg)
  }

  async getByHandle(handle: string): Promise<Registration | undefined> {
    return this.byHandle.get(handle)
  }

  async getByDid(did: string): Promise<Registration | undefined> {
    return this.byDid.get(did)
  }

  async remove(handle: string): Promise<boolean> {
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

/** An in-memory InviteStore — pure persistence of token → remaining-use counters.
 * The single-use / cap ENFORCEMENT lives in InviteManager; this just records the
 * counter and provides the atomic decrement-or-delete primitive. */
export class MemoryInviteStore implements InviteStore {
  private readonly remaining = new Map<string, number>()

  async setRemaining(token: string, remaining: number): Promise<void> {
    this.remaining.set(token, remaining)
  }

  async getRemaining(token: string): Promise<number | undefined> {
    return this.remaining.get(token)
  }

  async decrementOrDelete(token: string): Promise<boolean> {
    const rec = this.remaining.get(token)
    if (rec === undefined || rec < 1) return false
    const next = rec - 1
    if (next === 0) {
      this.remaining.delete(token)
    } else {
      this.remaining.set(token, next)
    }
    return true
  }
}

/** An in-memory CredentialStore — pure persistence of handle → current pair plus the
 * two reverse lookups. The rotation revoke-then-mint SEQUENCING lives in
 * CredentialManager; this records bindings and atomically supersedes the prior pair
 * on `setCurrent` (so the old tokens stop resolving even without a preceding delete). */
export class MemoryCredentialStore implements CredentialStore {
  private readonly inboxAuthToHandle = new Map<string, string>()
  private readonly sendCredToHandle = new Map<string, string>()
  private readonly current = new Map<string, CredentialPair>()

  async setCurrent(handle: string, pair: CredentialPair): Promise<void> {
    // Atomically supersede any prior pair for this handle (drop its reverse entries).
    const prev = this.current.get(handle)
    if (prev) {
      this.inboxAuthToHandle.delete(prev.inboxAuth)
      this.sendCredToHandle.delete(prev.sendCredential)
    }
    this.inboxAuthToHandle.set(pair.inboxAuth, handle)
    this.sendCredToHandle.set(pair.sendCredential, handle)
    this.current.set(handle, pair)
  }

  async getCurrent(handle: string): Promise<CredentialPair | undefined> {
    return this.current.get(handle)
  }

  async deleteFor(handle: string, pair: CredentialPair): Promise<void> {
    // Only delete if the handle's current pair is still the one being revoked.
    const cur = this.current.get(handle)
    if (!cur || cur.inboxAuth !== pair.inboxAuth || cur.sendCredential !== pair.sendCredential) {
      return
    }
    this.inboxAuthToHandle.delete(pair.inboxAuth)
    this.sendCredToHandle.delete(pair.sendCredential)
    this.current.delete(handle)
  }

  async handleForInboxAuth(inboxAuth: string): Promise<string | null> {
    return this.inboxAuthToHandle.get(inboxAuth) ?? null
  }

  async handleForSendCredential(sendCredential: string): Promise<string | null> {
    return this.sendCredToHandle.get(sendCredential) ?? null
  }
}
