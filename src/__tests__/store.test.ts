// store.test — the DUAL-BACKEND parity suite. Every behavioral assertion runs over
// BOTH the in-memory reference backend AND the Postgres adapter (via pg-mem), driven
// by the `backends` table. This is the contract that proves the durable backend
// reproduces the in-memory semantics EXACTLY — there is one spec, two
// implementations. (The Pg adapters also have their own bespoke per-adapter tests in
// pg-{inbox,registry,invite-credential}.test.ts; this suite is the shared contract.)
import { describe, expect, it } from "vitest"

import { sha256Hex } from "../security/hash"
import { migratedPgMem } from "./pg-harness"
import type { CredentialStore, InboxStore, InviteStore, RegistryStore } from "../store/interfaces"
import type { InboxBounds } from "../store/memory"
import {
  MemoryCredentialStore,
  MemoryInboxStore,
  MemoryInviteStore,
  MemoryRegistryStore,
} from "../store/memory"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgInboxStore } from "../store/postgres/inbox"
import { PgInviteStore } from "../store/postgres/invites"
import { PgRegistryStore } from "../store/postgres/registry"
import type { A2AMessage, PublicAgentCard } from "../types"

function msg(ct = "ct", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: "did:key:zB" } }] }
}

const TTL = 1000

/** A backend supplies async factories for the four stores. The memory factories are
 * sync-wrapped; the Postgres factories build adapters over a fresh, migrated pg-mem
 * pool (per call, so each test is isolated). */
interface Backend {
  name: string
  makeInbox(bounds: InboxBounds): Promise<InboxStore>
  makeRegistry(): Promise<RegistryStore>
  makeInvite(): Promise<InviteStore>
  makeCred(): Promise<CredentialStore>
}

const backends: Backend[] = [
  {
    name: "memory",
    makeInbox: async (bounds) => new MemoryInboxStore(bounds),
    makeRegistry: async () => new MemoryRegistryStore(),
    makeInvite: async () => new MemoryInviteStore(),
    makeCred: async () => new MemoryCredentialStore(),
  },
  {
    name: "postgres",
    makeInbox: async (bounds) => {
      const { pool } = await migratedPgMem()
      return new PgInboxStore(pool, bounds)
    },
    makeRegistry: async () => {
      const { pool } = await migratedPgMem()
      return new PgRegistryStore(pool)
    },
    makeInvite: async () => {
      const { pool } = await migratedPgMem()
      return new PgInviteStore(pool)
    },
    makeCred: async () => {
      const { pool } = await migratedPgMem()
      return new PgCredentialStore(pool)
    },
  },
]

for (const backend of backends) {
  describe(`[${backend.name}] InboxStore — bounded queue (the DoS floor)`, () => {
    it("enqueues and lists a message", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })
      expect(r.ok).toBe(true)
      const listed = await inbox.list("h", 0)
      expect(listed).toHaveLength(1)
      expect(listed[0].message).toEqual(msg())
    })

    it("drops on the per-handle COUNT quota", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 2, maxBytes: 1_000_000 })
      expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
      expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
      expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).toEqual({ ok: false, reason: "quota_count" })
      expect(await inbox.depth("h", 0)).toBe(2)
    })

    it("drops on the per-handle BYTE quota", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 100, maxBytes: 150 })
      expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).ok).toBe(true)
      expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).toEqual({ ok: false, reason: "quota_bytes" })
    })

    it("does not count EXPIRED messages against the quota (they get pruned on enqueue)", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 1, maxBytes: 1_000_000 })
      expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })).ok).toBe(true)
      expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 600, expiresAt: 1600, sizeBytes: 10 })).ok).toBe(true)
      expect(await inbox.depth("h", 600)).toBe(1)
    })

    it("list() omits expired messages and prunes the queue", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h", message: msg("a"), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h", message: msg("b"), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
      const listed = await inbox.list("h", 600)
      expect(listed).toHaveLength(1)
      expect(listed[0].message.parts[0].data.sealed.ct).toBe("b")
    })

    it("list() of an unknown handle is empty", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 100 })
      expect(await inbox.list("nope", 0)).toEqual([])
      expect(await inbox.depth("nope", 0)).toBe(0)
    })

    it("list() prunes a queue down to empty when all expired", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
      expect(await inbox.list("h", 600)).toEqual([])
      expect(await inbox.list("h", 600)).toEqual([])
    })

    it("FIFO order (oldest first)", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h", message: msg("first", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h", message: msg("second", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h", message: msg("third", "m3"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      const listed = await inbox.list("h", 0)
      expect(listed.map((m) => m.message.parts[0].data.sealed.ct)).toEqual(["first", "second", "third"])
    })

    it("ack deletes a message and reports existence", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      const queueId = r.ok ? r.queueId : ""
      expect(await inbox.ack("h", queueId)).toBe(true)
      expect(await inbox.depth("h", 0)).toBe(0)
      expect(await inbox.ack("h", queueId)).toBe(false)
    })

    it("ack of an unknown handle → false", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 100 })
      expect(await inbox.ack("nope", "q1")).toBe(false)
    })

    it("ack of ONE of several messages keeps the queue (only removes the acked)", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      const r1 = await inbox.enqueue({ handle: "h", message: msg("a", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h", message: msg("b", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      const firstId = r1.ok ? r1.queueId : ""
      expect(await inbox.ack("h", firstId)).toBe(true)
      const remaining = await inbox.list("h", 0)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].message.parts[0].data.sealed.ct).toBe("b")
    })

    it("ack of an unknown queueId on a known handle → false, queue retained", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
      expect(await inbox.ack("h", "qX")).toBe(false)
      expect(await inbox.depth("h", 0)).toBe(1)
    })

    it("dropExpired sweeps across handles and returns the count", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
      await inbox.enqueue({ handle: "h2", message: msg(), enqueuedAt: 0, expiresAt: 400, sizeBytes: 10 })
      expect(await inbox.dropExpired(600)).toBe(2)
      expect(await inbox.depth("h1", 600)).toBe(1)
      expect(await inbox.depth("h2", 600)).toBe(0)
    })

    it("dropExpired with nothing expired returns 0 and retains queues", async () => {
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 5000, sizeBytes: 10 })
      expect(await inbox.dropExpired(600)).toBe(0)
      expect(await inbox.depth("h", 600)).toBe(1)
    })

    it("CONTENT-BLIND: a listed message is ONLY the opaque blob + routing DID (no plaintext)", async () => {
      const SECRET = "super-secret-plaintext-never-leaks"
      const inbox = await backend.makeInbox({ maxMessages: 10, maxBytes: 1_000_000 })
      // A sealed message whose ct is opaque base64; the recipientDid is routing.
      const sealed: A2AMessage = {
        messageId: "m-seal",
        role: "agent",
        parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "ePk", n: "n", ct: "Y2lwaGVy" }, recipientDid: "did:key:zRecipient" } }],
      }
      await inbox.enqueue({ handle: "h", message: sealed, enqueuedAt: 0, expiresAt: TTL, sizeBytes: 50 })
      const listed = await inbox.list("h", 0)
      expect(listed).toHaveLength(1)
      const data = listed[0].message.parts[0].data
      // The DataPart carries ONLY {v, sealed, recipientDid}; sealed carries ONLY {v,ePk,n,ct}.
      expect(Object.keys(data).sort()).toEqual(["recipientDid", "sealed", "v"])
      expect(Object.keys(data.sealed).sort()).toEqual(["ct", "ePk", "n", "v"])
      expect(data.recipientDid).toBe("did:key:zRecipient")
      // No plaintext anywhere in the round-tripped message.
      expect(JSON.stringify(listed[0].message).includes(SECRET)).toBe(false)
    })
  })

  describe(`[${backend.name}] RegistryStore`, () => {
    const card = (did: string): PublicAgentCard => ({ name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did })

    it("puts and looks up by handle and by DID", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
      expect((await reg.getByHandle("h"))?.did).toBe("did:key:zA")
      expect((await reg.getByDid("did:key:zA"))?.handle).toBe("h")
      expect(await reg.getByHandle("nope")).toBeUndefined()
      expect(await reg.getByDid("nope")).toBeUndefined()
    })

    it("re-registration under the same handle with a NEW did clears the stale did index", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h", did: "did:key:zOld", agentCard: card("did:key:zOld"), registeredAt: 0 })
      await reg.put({ handle: "h", did: "did:key:zNew", agentCard: card("did:key:zNew"), registeredAt: 1 })
      expect(await reg.getByDid("did:key:zOld")).toBeUndefined()
      expect((await reg.getByDid("did:key:zNew"))?.handle).toBe("h")
    })

    it("re-registration under the same handle with the SAME did keeps the index", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
      await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 1 })
      expect((await reg.getByDid("did:key:zA"))?.registeredAt).toBe(1)
    })

    it("remove deletes both indexes and reports existence", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
      expect(await reg.remove("h")).toBe(true)
      expect(await reg.getByHandle("h")).toBeUndefined()
      expect(await reg.getByDid("did:key:zA")).toBeUndefined()
      expect(await reg.remove("h")).toBe(false)
    })

    it("getByDid is last-writer-wins for a shared DID", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h1", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 0 })
      await reg.put({ handle: "h2", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 1 })
      expect((await reg.getByDid("did:key:zShared"))?.handle).toBe("h2")
    })

    it("remove does NOT clobber a DID index re-pointed to another handle", async () => {
      const reg = await backend.makeRegistry()
      await reg.put({ handle: "h1", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 0 })
      await reg.put({ handle: "h2", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 1 })
      expect(await reg.remove("h1")).toBe(true)
      expect((await reg.getByDid("did:key:zShared"))?.handle).toBe("h2")
    })
  })

  describe(`[${backend.name}] InviteStore — invite counter persistence`, () => {
    it("setRemaining + getRemaining round-trip; unknown is undefined", async () => {
      const inv = await backend.makeInvite()
      expect(await inv.getRemaining("t")).toBeUndefined()
      await inv.setRemaining("t", 3)
      expect(await inv.getRemaining("t")).toBe(3)
    })

    it("decrementOrDelete: unknown → false", async () => {
      const inv = await backend.makeInvite()
      expect(await inv.decrementOrDelete("nope")).toBe(false)
    })

    it("decrementOrDelete: multi-use decrements then deletes at 0", async () => {
      const inv = await backend.makeInvite()
      await inv.setRemaining("t", 2)
      expect(await inv.decrementOrDelete("t")).toBe(true)
      expect(await inv.getRemaining("t")).toBe(1)
      expect(await inv.decrementOrDelete("t")).toBe(true)
      expect(await inv.getRemaining("t")).toBeUndefined()
      expect(await inv.decrementOrDelete("t")).toBe(false)
    })

    it("a token at 0 is treated as exhausted", async () => {
      const inv = await backend.makeInvite()
      await inv.setRemaining("t", 0)
      expect(await inv.decrementOrDelete("t")).toBe(false)
    })
  })

  describe(`[${backend.name}] CredentialStore — binding persistence`, () => {
    const pair = (i: string, s: string) => ({ inboxAuth: i, sendCredential: s })
    // RF3: the store hashes the high-entropy secrets at rest, so `getCurrent` returns
    // the SHA-256 DIGEST pair (identical across BOTH backends → parity preserved). Its
    // only consumer is the rotation revoke path, which feeds the digests to `deleteFor`.
    const hashedPair = (i: string, s: string) => pair(sha256Hex(i), sha256Hex(s))

    it("setCurrent records both reverse lookups + current", async () => {
      const cs = await backend.makeCred()
      await cs.setCurrent("h", pair("ia", "sc"))
      // getCurrent returns the stored DIGESTS, not the plaintext (at-rest hashing).
      expect(await cs.getCurrent("h")).toEqual(hashedPair("ia", "sc"))
      // The reverse lookups still resolve the PLAINTEXT secret (the store hashes it).
      expect(await cs.handleForInboxAuth("ia")).toBe("h")
      expect(await cs.handleForSendCredential("sc")).toBe("h")
    })

    it("setCurrent AGAIN supersedes the prior pair (old reverse lookups stop resolving)", async () => {
      const cs = await backend.makeCred()
      await cs.setCurrent("h", pair("ia1", "sc1"))
      await cs.setCurrent("h", pair("ia2", "sc2"))
      expect(await cs.handleForInboxAuth("ia1")).toBeNull()
      expect(await cs.handleForSendCredential("sc1")).toBeNull()
      expect(await cs.handleForInboxAuth("ia2")).toBe("h")
    })

    it("deleteFor removes the binding when the current pair matches", async () => {
      const cs = await backend.makeCred()
      await cs.setCurrent("h", pair("ia", "sc"))
      // `deleteFor` takes the stored (digest) pair — exactly what the production caller
      // (CredentialManager.rotate/revoke) passes: the result of `getCurrent`.
      const cur = await cs.getCurrent("h")
      expect(cur).toBeDefined()
      await cs.deleteFor("h", cur!)
      expect(await cs.getCurrent("h")).toBeUndefined()
      expect(await cs.handleForInboxAuth("ia")).toBeNull()
      expect(await cs.handleForSendCredential("sc")).toBeNull()
    })

    it("deleteFor is a no-op when the handle is absent", async () => {
      const cs = await backend.makeCred()
      await expect(cs.deleteFor("absent", pair("ia", "sc"))).resolves.toBeUndefined()
    })

    it("deleteFor is a no-op when the pair no longer matches the current (already rotated away)", async () => {
      const cs = await backend.makeCred()
      await cs.setCurrent("h", pair("ia2", "sc2"))
      // A stale pair (the digests of an already-rotated-away pair) matches no row → no-op.
      await cs.deleteFor("h", hashedPair("ia1", "sc1"))
      expect(await cs.getCurrent("h")).toEqual(hashedPair("ia2", "sc2"))
      expect(await cs.handleForInboxAuth("ia2")).toBe("h")
    })

    it("unknown reverse lookups resolve to null", async () => {
      const cs = await backend.makeCred()
      expect(await cs.handleForInboxAuth("nope")).toBeNull()
      expect(await cs.handleForSendCredential("nope")).toBeNull()
      expect(await cs.getCurrent("nope")).toBeUndefined()
    })
  })
}
