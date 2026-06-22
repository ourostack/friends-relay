import { describe, expect, it } from "vitest"

import { migratedPgMem } from "./pg-harness"
import { PgRegistryStore } from "../store/postgres/registry"
import type { PublicAgentCard } from "../types"

const card = (did: string): PublicAgentCard => ({ name: "a", url: "u", version: "1", protocolVersion: "0.3.0", did })

/** Build a PgRegistryStore over a freshly-migrated pg-mem db. */
async function setup(): Promise<{ reg: PgRegistryStore; handle: Awaited<ReturnType<typeof migratedPgMem>>["handle"] }> {
  const { pool, handle } = await migratedPgMem()
  return { reg: new PgRegistryStore(pool), handle }
}

describe("PgRegistryStore over pg-mem", () => {
  it("puts and looks up by handle and by DID", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    expect((await reg.getByHandle("h"))?.did).toBe("did:key:zA")
    expect((await reg.getByDid("did:key:zA"))?.handle).toBe("h")
    expect(await reg.getByHandle("nope")).toBeUndefined()
    expect(await reg.getByDid("nope")).toBeUndefined()
  })

  it("round-trips the full record (agentCard jsonb + optional keyAgreementPubKey)", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), keyAgreementPubKey: "x25519pub", registeredAt: 42 })
    const got = await reg.getByHandle("h")
    expect(got).toEqual({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), keyAgreementPubKey: "x25519pub", registeredAt: 42 })
  })

  it("a record with NO keyAgreementPubKey round-trips as undefined (not null)", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    const got = await reg.getByHandle("h")
    expect(got?.keyAgreementPubKey).toBeUndefined()
    expect("keyAgreementPubKey" in (got as object)).toBe(true) // present-but-undefined, like memory
  })

  it("re-registration under the same handle REPLACES the record (ON CONFLICT DO UPDATE)", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: { ...card("did:key:zA"), name: "renamed" }, registeredAt: 5 })
    const got = await reg.getByHandle("h")
    expect(got?.agentCard.name).toBe("renamed")
    expect(got?.registeredAt).toBe(5)
  })

  it("re-registration under the same handle with a NEW did clears the stale did index", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zOld", agentCard: card("did:key:zOld"), registeredAt: 0 })
    await reg.put({ handle: "h", did: "did:key:zNew", agentCard: card("did:key:zNew"), registeredAt: 1 })
    expect(await reg.getByDid("did:key:zOld")).toBeUndefined()
    expect((await reg.getByDid("did:key:zNew"))?.handle).toBe("h")
  })

  it("re-registration under the same handle with the SAME did keeps the index (latest record)", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 1 })
    expect((await reg.getByDid("did:key:zA"))?.registeredAt).toBe(1)
  })

  it("getByDid is last-writer-wins for a SHARED DID (resolves to the most recent put)", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h1", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 0 })
    await reg.put({ handle: "h2", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 1 })
    expect((await reg.getByDid("did:key:zShared"))?.handle).toBe("h2")
  })

  it("remove deletes the record and reports existence; re-remove → false", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), registeredAt: 0 })
    expect(await reg.remove("h")).toBe(true)
    expect(await reg.getByHandle("h")).toBeUndefined()
    expect(await reg.getByDid("did:key:zA")).toBeUndefined()
    expect(await reg.remove("h")).toBe(false)
  })

  it("remove of an absent handle → false", async () => {
    const { reg } = await setup()
    expect(await reg.remove("absent")).toBe(false)
  })

  it("remove does NOT clobber a DID index re-pointed to another handle", async () => {
    const { reg } = await setup()
    await reg.put({ handle: "h1", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 0 })
    await reg.put({ handle: "h2", did: "did:key:zShared", agentCard: card("did:key:zShared"), registeredAt: 1 })
    // Removing h1 must not affect h2's claim on the shared DID.
    expect(await reg.remove("h1")).toBe(true)
    expect((await reg.getByDid("did:key:zShared"))?.handle).toBe("h2")
  })

  it("registrations survive a simulated restart (fresh adapter over the same db)", async () => {
    const { reg, handle } = await setup()
    await reg.put({ handle: "h", did: "did:key:zA", agentCard: card("did:key:zA"), keyAgreementPubKey: "x25519pub", registeredAt: 7 })
    const reg2 = new PgRegistryStore(handle.newPool())
    expect((await reg2.getByHandle("h"))?.keyAgreementPubKey).toBe("x25519pub")
    expect((await reg2.getByDid("did:key:zA"))?.handle).toBe("h")
  })
})
