import { describe, expect, it } from "vitest"

import { migratedPgMem } from "./pg-harness"
import { PgInviteStore } from "../store/postgres/invites"
import { PgCredentialStore } from "../store/postgres/credentials"

async function inviteSetup(): Promise<{ store: PgInviteStore; handle: Awaited<ReturnType<typeof migratedPgMem>>["handle"] }> {
  const { pool, handle } = await migratedPgMem()
  return { store: new PgInviteStore(pool), handle }
}

async function credSetup(): Promise<{ store: PgCredentialStore; handle: Awaited<ReturnType<typeof migratedPgMem>>["handle"] }> {
  const { pool, handle } = await migratedPgMem()
  return { store: new PgCredentialStore(pool), handle }
}

const pair = (i: string, s: string) => ({ inboxAuth: i, sendCredential: s })

describe("PgInviteStore over pg-mem", () => {
  it("setRemaining + getRemaining round-trip; unknown is undefined", async () => {
    const { store } = await inviteSetup()
    expect(await store.getRemaining("t")).toBeUndefined()
    await store.setRemaining("t", 3)
    expect(await store.getRemaining("t")).toBe(3)
  })

  it("setRemaining is idempotent on re-issue (upsert the same token)", async () => {
    const { store } = await inviteSetup()
    await store.setRemaining("t", 1)
    await store.setRemaining("t", 5)
    expect(await store.getRemaining("t")).toBe(5)
  })

  it("decrementOrDelete: unknown → false", async () => {
    const { store } = await inviteSetup()
    expect(await store.decrementOrDelete("nope")).toBe(false)
  })

  it("decrementOrDelete: single-use consumes once then is gone", async () => {
    const { store } = await inviteSetup()
    await store.setRemaining("t", 1)
    expect(await store.decrementOrDelete("t")).toBe(true)
    expect(await store.getRemaining("t")).toBeUndefined()
    expect(await store.decrementOrDelete("t")).toBe(false)
  })

  it("decrementOrDelete: multi-use decrements then deletes at 0", async () => {
    const { store } = await inviteSetup()
    await store.setRemaining("t", 2)
    expect(await store.decrementOrDelete("t")).toBe(true)
    expect(await store.getRemaining("t")).toBe(1)
    expect(await store.decrementOrDelete("t")).toBe(true)
    expect(await store.getRemaining("t")).toBeUndefined()
    expect(await store.decrementOrDelete("t")).toBe(false)
  })

  it("a token at 0 is treated as exhausted (no negative remaining)", async () => {
    const { store } = await inviteSetup()
    await store.setRemaining("t", 0)
    expect(await store.decrementOrDelete("t")).toBe(false)
    // It must not have gone negative.
    expect(await store.getRemaining("t")).toBe(0)
  })

  it("remaining invite uses survive a simulated restart", async () => {
    const { store, handle } = await inviteSetup()
    await store.setRemaining("t", 2)
    await store.decrementOrDelete("t") // 1 left
    const store2 = new PgInviteStore(handle.newPool())
    expect(await store2.getRemaining("t")).toBe(1)
    expect(await store2.decrementOrDelete("t")).toBe(true) // last use
    expect(await store2.decrementOrDelete("t")).toBe(false) // exhausted post-restart
  })
})

describe("PgCredentialStore over pg-mem", () => {
  it("setCurrent records the pair + both reverse lookups", async () => {
    const { store } = await credSetup()
    await store.setCurrent("h", pair("ia", "sc"))
    expect(await store.getCurrent("h")).toEqual(pair("ia", "sc"))
    expect(await store.handleForInboxAuth("ia")).toBe("h")
    expect(await store.handleForSendCredential("sc")).toBe("h")
  })

  it("setCurrent AGAIN atomically supersedes the prior pair (old tokens stop resolving)", async () => {
    const { store } = await credSetup()
    await store.setCurrent("h", pair("ia1", "sc1"))
    await store.setCurrent("h", pair("ia2", "sc2"))
    expect(await store.handleForInboxAuth("ia1")).toBeNull()
    expect(await store.handleForSendCredential("sc1")).toBeNull()
    expect(await store.handleForInboxAuth("ia2")).toBe("h")
    expect(await store.handleForSendCredential("sc2")).toBe("h")
    expect(await store.getCurrent("h")).toEqual(pair("ia2", "sc2"))
  })

  it("deleteFor removes the binding when the current pair matches", async () => {
    const { store } = await credSetup()
    await store.setCurrent("h", pair("ia", "sc"))
    await store.deleteFor("h", pair("ia", "sc"))
    expect(await store.getCurrent("h")).toBeUndefined()
    expect(await store.handleForInboxAuth("ia")).toBeNull()
    expect(await store.handleForSendCredential("sc")).toBeNull()
  })

  it("deleteFor is a no-op when the handle is absent", async () => {
    const { store } = await credSetup()
    await expect(store.deleteFor("absent", pair("ia", "sc"))).resolves.toBeUndefined()
  })

  it("deleteFor is a no-op when the pair no longer matches (already rotated away)", async () => {
    const { store } = await credSetup()
    await store.setCurrent("h", pair("ia2", "sc2"))
    await store.deleteFor("h", pair("ia1", "sc1")) // stale pair
    // Current binding untouched.
    expect(await store.getCurrent("h")).toEqual(pair("ia2", "sc2"))
    expect(await store.handleForInboxAuth("ia2")).toBe("h")
  })

  it("unknown reverse lookups resolve to null; getCurrent unknown is undefined", async () => {
    const { store } = await credSetup()
    expect(await store.handleForInboxAuth("nope")).toBeNull()
    expect(await store.handleForSendCredential("nope")).toBeNull()
    expect(await store.getCurrent("nope")).toBeUndefined()
  })

  it("two handles hold independent bindings (a send cred is bound to ONE handle)", async () => {
    const { store } = await credSetup()
    await store.setCurrent("h1", pair("ia1", "sc1"))
    await store.setCurrent("h2", pair("ia2", "sc2"))
    expect(await store.handleForSendCredential("sc1")).toBe("h1")
    expect(await store.handleForSendCredential("sc2")).toBe("h2")
  })

  it("credential bindings survive a simulated restart", async () => {
    const { store, handle } = await credSetup()
    await store.setCurrent("h", pair("ia", "sc"))
    const store2 = new PgCredentialStore(handle.newPool())
    expect(await store2.handleForInboxAuth("ia")).toBe("h")
    expect(await store2.handleForSendCredential("sc")).toBe("h")
    expect(await store2.getCurrent("h")).toEqual(pair("ia", "sc"))
  })

  it("rotation done pre-restart means the OLD credential is rejected post-restart", async () => {
    const { store, handle } = await credSetup()
    await store.setCurrent("h", pair("ia1", "sc1"))
    await store.setCurrent("h", pair("ia2", "sc2")) // rotate
    const store2 = new PgCredentialStore(handle.newPool())
    expect(await store2.handleForInboxAuth("ia1")).toBeNull()
    expect(await store2.handleForSendCredential("sc1")).toBeNull()
    expect(await store2.handleForInboxAuth("ia2")).toBe("h")
  })
})
