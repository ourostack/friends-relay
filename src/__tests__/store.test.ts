import { describe, expect, it } from "vitest"

import { MemoryCredentialStore, MemoryInboxStore, MemoryInviteStore, MemoryRegistryStore } from "../store/memory"
import type { A2AMessage, PublicAgentCard } from "../types"

function msg(ct = "ct", id = "m1"): A2AMessage {
  return { messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct }, recipientDid: "did:key:zB" } }] }
}

const TTL = 1000

describe("MemoryInboxStore — bounded queue (the DoS floor)", () => {
  it("enqueues and lists a message", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })
    expect(r).toEqual({ ok: true, queueId: "q1" })
    const listed = await inbox.list("h", 0)
    expect(listed).toHaveLength(1)
    expect(listed[0].queueId).toBe("q1")
    expect(listed[0].message).toEqual(msg())
  })

  it("drops on the per-handle COUNT quota", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 2, maxBytes: 1_000_000 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).ok).toBe(true)
    expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })).toEqual({ ok: false, reason: "quota_count" })
    expect(await inbox.depth("h", 0)).toBe(2)
  })

  it("drops on the per-handle BYTE quota", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 100, maxBytes: 150 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).ok).toBe(true)
    expect(await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 100 })).toEqual({ ok: false, reason: "quota_bytes" })
  })

  it("does not count EXPIRED messages against the quota (they get pruned on enqueue)", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 1, maxBytes: 1_000_000 })
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })).ok).toBe(true)
    // The first is now expired at t=600; the second enqueue should succeed (pruned).
    expect((await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 600, expiresAt: 1600, sizeBytes: 10 })).ok).toBe(true)
    expect(await inbox.depth("h", 600)).toBe(1)
  })

  it("list() omits expired messages and prunes the queue", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    await inbox.enqueue({ handle: "h", message: msg("a"), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("b"), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
    const listed = await inbox.list("h", 600)
    expect(listed).toHaveLength(1)
    expect(listed[0].message.parts[0].data.sealed.ct).toBe("b")
  })

  it("list() of an unknown handle is empty", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 100 })
    expect(await inbox.list("nope", 0)).toEqual([])
    expect(await inbox.depth("nope", 0)).toBe(0)
  })

  it("list() prunes a queue down to empty when all expired", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
    expect(await inbox.list("h", 600)).toEqual([])
    // After pruning to empty, a later list is still empty (queue removed).
    expect(await inbox.list("h", 600)).toEqual([])
  })

  it("ack deletes a message and reports existence", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    const r = await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const queueId = r.ok ? r.queueId : ""
    expect(await inbox.ack("h", queueId)).toBe(true)
    expect(await inbox.depth("h", 0)).toBe(0)
    // A second ack of the same id → false (already gone, queue removed).
    expect(await inbox.ack("h", queueId)).toBe(false)
  })

  it("ack of an unknown handle → false", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 100 })
    expect(await inbox.ack("nope", "q1")).toBe(false)
  })

  it("ack of ONE of several messages keeps the queue (only removes the acked)", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    const r1 = await inbox.enqueue({ handle: "h", message: msg("a", "m1"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("b", "m2"), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    const firstId = r1.ok ? r1.queueId : ""
    expect(await inbox.ack("h", firstId)).toBe(true)
    // The queue still has the second message (not removed from the map).
    const remaining = await inbox.list("h", 0)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].message.parts[0].data.sealed.ct).toBe("b")
  })

  it("ack of an unknown queueId on a known handle → false, queue retained", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: TTL, sizeBytes: 10 })
    expect(await inbox.ack("h", "qX")).toBe(false)
    expect(await inbox.depth("h", 0)).toBe(1)
  })

  it("dropExpired sweeps across handles and returns the count", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h1", message: msg(), enqueuedAt: 0, expiresAt: 1500, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h2", message: msg(), enqueuedAt: 0, expiresAt: 400, sizeBytes: 10 })
    const dropped = await inbox.dropExpired(600)
    expect(dropped).toBe(2) // one from h1, the only one from h2
    expect(await inbox.depth("h1", 600)).toBe(1)
    expect(await inbox.depth("h2", 600)).toBe(0)
  })

  it("dropExpired with nothing expired returns 0 and retains queues", async () => {
    const inbox = new MemoryInboxStore({ maxMessages: 10, maxBytes: 1_000_000 })
    await inbox.enqueue({ handle: "h", message: msg(), enqueuedAt: 0, expiresAt: 5000, sizeBytes: 10 })
    expect(await inbox.dropExpired(600)).toBe(0)
    expect(await inbox.depth("h", 600)).toBe(1)
  })
})

describe("MemoryRegistryStore", () => {
  const card = (did: string): PublicAgentCard => ({ name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did })

  it("puts and looks up by handle and by DID", async () => {
    const reg = new MemoryRegistryStore()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    expect((await reg.getByHandle("h"))?.did).toBe("did:key:zA")
    expect((await reg.getByDid("did:key:zA"))?.handle).toBe("h")
    expect(await reg.getByHandle("nope")).toBeUndefined()
    expect(await reg.getByDid("nope")).toBeUndefined()
  })

  it("re-registration under the same handle with a NEW did clears the stale did index", async () => {
    const reg = new MemoryRegistryStore()
    await reg.put({ handle: "h", did: "did:key:zOld", agentCard: card("did:key:zOld"), registeredAt: 0 })
    await reg.put({ handle: "h", did: "did:key:zNew", agentCard: card("did:key:zNew"), registeredAt: 1 })
    expect(await reg.getByDid("did:key:zOld")).toBeUndefined()
    expect((await reg.getByDid("did:key:zNew"))?.handle).toBe("h")
  })

  it("re-registration under the same handle with the SAME did keeps the index", async () => {
    const reg = new MemoryRegistryStore()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 1 })
    expect((await reg.getByDid("did:key:zA"))?.registeredAt).toBe(1)
  })

  it("remove deletes both indexes and reports existence", async () => {
    const reg = new MemoryRegistryStore()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    expect(await reg.remove("h")).toBe(true)
    expect(await reg.getByHandle("h")).toBeUndefined()
    expect(await reg.getByDid("did:key:zA")).toBeUndefined()
    expect(await reg.remove("h")).toBe(false)
  })

  it("remove does NOT clobber a DID index re-pointed to another handle", async () => {
    const reg = new MemoryRegistryStore()
    await reg.put({ handle: "h1", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 0 })
    // A second handle re-claims the same DID (the byDid index now points at h2).
    await reg.put({ handle: "h2", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 1 })
    // Removing h1 must not delete the DID index that now belongs to h2.
    expect(await reg.remove("h1")).toBe(true)
    expect((await reg.getByDid("did:key:zShared"))?.handle).toBe("h2")
  })
})

describe("MemoryInviteStore — invite counter persistence", () => {
  it("setRemaining + getRemaining round-trip; unknown is undefined", async () => {
    const inv = new MemoryInviteStore()
    expect(await inv.getRemaining("t")).toBeUndefined()
    await inv.setRemaining("t", 3)
    expect(await inv.getRemaining("t")).toBe(3)
  })

  it("decrementOrDelete: unknown → false", async () => {
    const inv = new MemoryInviteStore()
    expect(await inv.decrementOrDelete("nope")).toBe(false)
  })

  it("decrementOrDelete: multi-use decrements then deletes at 0", async () => {
    const inv = new MemoryInviteStore()
    await inv.setRemaining("t", 2)
    expect(await inv.decrementOrDelete("t")).toBe(true)
    expect(await inv.getRemaining("t")).toBe(1)
    expect(await inv.decrementOrDelete("t")).toBe(true)
    // Deleted at 0 — gone, and a further consume fails.
    expect(await inv.getRemaining("t")).toBeUndefined()
    expect(await inv.decrementOrDelete("t")).toBe(false)
  })

  it("decrementOrDelete: a token explicitly set to 0 is treated as exhausted", async () => {
    const inv = new MemoryInviteStore()
    await inv.setRemaining("t", 0)
    expect(await inv.decrementOrDelete("t")).toBe(false)
  })
})

describe("MemoryCredentialStore — binding persistence", () => {
  const pair = (i: string, s: string) => ({ inboxAuth: i, sendCredential: s })

  it("setCurrent records both reverse lookups + current", async () => {
    const cs = new MemoryCredentialStore()
    await cs.setCurrent("h", pair("ia", "sc"))
    expect(await cs.getCurrent("h")).toEqual(pair("ia", "sc"))
    expect(await cs.handleForInboxAuth("ia")).toBe("h")
    expect(await cs.handleForSendCredential("sc")).toBe("h")
  })

  it("setCurrent AGAIN supersedes the prior pair (old reverse lookups stop resolving)", async () => {
    const cs = new MemoryCredentialStore()
    await cs.setCurrent("h", pair("ia1", "sc1"))
    // Re-set WITHOUT a preceding deleteFor — setCurrent must drop the old reverse entries.
    await cs.setCurrent("h", pair("ia2", "sc2"))
    expect(await cs.handleForInboxAuth("ia1")).toBeNull()
    expect(await cs.handleForSendCredential("sc1")).toBeNull()
    expect(await cs.handleForInboxAuth("ia2")).toBe("h")
  })

  it("deleteFor removes the binding when the current pair matches", async () => {
    const cs = new MemoryCredentialStore()
    await cs.setCurrent("h", pair("ia", "sc"))
    await cs.deleteFor("h", pair("ia", "sc"))
    expect(await cs.getCurrent("h")).toBeUndefined()
    expect(await cs.handleForInboxAuth("ia")).toBeNull()
    expect(await cs.handleForSendCredential("sc")).toBeNull()
  })

  it("deleteFor is a no-op when the handle is absent", async () => {
    const cs = new MemoryCredentialStore()
    await expect(cs.deleteFor("absent", pair("ia", "sc"))).resolves.toBeUndefined()
  })

  it("deleteFor is a no-op when the pair no longer matches the current (already rotated away)", async () => {
    const cs = new MemoryCredentialStore()
    await cs.setCurrent("h", pair("ia2", "sc2")) // current is the NEW pair
    // Attempt to delete a STALE pair — must not touch the current binding.
    await cs.deleteFor("h", pair("ia1", "sc1"))
    expect(await cs.getCurrent("h")).toEqual(pair("ia2", "sc2"))
    expect(await cs.handleForInboxAuth("ia2")).toBe("h")
  })

  it("unknown reverse lookups resolve to null", async () => {
    const cs = new MemoryCredentialStore()
    expect(await cs.handleForInboxAuth("nope")).toBeNull()
    expect(await cs.handleForSendCredential("nope")).toBeNull()
    expect(await cs.getCurrent("nope")).toBeUndefined()
  })
})
