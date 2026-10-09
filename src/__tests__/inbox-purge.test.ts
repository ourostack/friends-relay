import { describe, expect, it } from "vitest"

import { MemoryInboxStore } from "../store/memory"
import { PgInboxStore } from "../store/postgres/inbox"
import type { InboxStore } from "../store/interfaces"
import type { A2AMessage } from "../types"
import { migratedPgMem } from "./pg-harness"

const BOUNDS = { maxMessages: 10, maxBytes: 1_000_000 }
const msg = (id: string): A2AMessage => ({ messageId: id, role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct: id }, recipientDid: "did:key:zB" } }] })

describe.each([
  ["memory", async (): Promise<InboxStore> => new MemoryInboxStore(BOUNDS)],
  ["postgres (pg-mem)", async (): Promise<InboxStore> => new PgInboxStore((await migratedPgMem()).pool, BOUNDS)],
])("InboxStore.purge — %s", (_name, make) => {
  it("removes every message for that handle only and reports the count", async () => {
    const inbox = await make()
    await inbox.enqueue({ handle: "h", message: msg("a"), enqueuedAt: 0, expiresAt: 1000, sizeBytes: 10 })
    await inbox.enqueue({ handle: "h", message: msg("b"), enqueuedAt: 0, expiresAt: 1000, sizeBytes: 10 })
    await inbox.enqueue({ handle: "other", message: msg("c"), enqueuedAt: 0, expiresAt: 1000, sizeBytes: 10 })
    expect(await inbox.purge("h")).toBe(2)
    expect(await inbox.list("h", 0)).toEqual([])
    expect(await inbox.depth("other", 0)).toBe(1)
    expect(await inbox.purge("h")).toBe(0)
  })
})
