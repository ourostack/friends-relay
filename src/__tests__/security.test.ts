import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { CredentialManager } from "../security/credentials"
import { InviteManager } from "../security/invites"
import { RateLimiter } from "../security/rate-limit"
import { cryptoTokenSource, SequenceTokenSource } from "../security/tokens"
import { MemoryCredentialStore, MemoryInviteStore } from "../store/memory"

describe("tokens", () => {
  it("cryptoTokenSource mints distinct 64-hex-char tokens", () => {
    const a = cryptoTokenSource.mint()
    const b = cryptoTokenSource.mint()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  it("SequenceTokenSource is deterministic with a prefix", () => {
    const src = new SequenceTokenSource("inv")
    expect(src.mint()).toBe("inv-1")
    expect(src.mint()).toBe("inv-2")
    expect(new SequenceTokenSource().mint()).toBe("tok-1")
  })
})

describe("InviteManager — closed membership (logic over an InviteStore)", () => {
  it("issues a single-use invite that consumes once then fails", async () => {
    const inv = new InviteManager(new SequenceTokenSource("inv"), new MemoryInviteStore())
    const t = await inv.issue()
    expect(t).toBe("inv-1")
    expect(await inv.consume(t)).toBe(true)
    expect(await inv.consume(t)).toBe(false) // reuse rejected
  })

  it("rejects an unknown token", async () => {
    const inv = new InviteManager(new SequenceTokenSource(), new MemoryInviteStore())
    expect(await inv.consume("never-issued")).toBe(false)
  })

  it("honors a multi-use cap", async () => {
    const inv = new InviteManager(new SequenceTokenSource("inv"), new MemoryInviteStore())
    const t = await inv.issue(2)
    expect(await inv.consume(t)).toBe(true)
    expect(await inv.consume(t)).toBe(true)
    expect(await inv.consume(t)).toBe(false) // exhausted
  })

  it("throws on a non-positive use cap", async () => {
    const inv = new InviteManager(new SequenceTokenSource(), new MemoryInviteStore())
    await expect(inv.issue(0)).rejects.toThrow(/uses must be >= 1/)
  })
})

describe("CredentialManager — rotating send-credentials (logic over a CredentialStore)", () => {
  it("mints a pair and resolves both directions", async () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"), new MemoryCredentialStore())
    const { inboxAuth, sendCredential } = await cm.rotate("h")
    expect(inboxAuth).toBe("c-1")
    expect(sendCredential).toBe("c-2")
    expect(await cm.handleForInboxAuth("c-1")).toBe("h")
    expect(await cm.canSendTo("c-2", "h")).toBe(true)
    expect(await cm.handleForSendCredential("c-2")).toBe("h")
  })

  it("rotation revokes the prior pair", async () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"), new MemoryCredentialStore())
    await cm.rotate("h") // c-1 inbox, c-2 send
    const next = await cm.rotate("h") // c-3 inbox, c-4 send
    expect(await cm.handleForInboxAuth("c-1")).toBeNull()
    expect(await cm.canSendTo("c-2", "h")).toBe(false)
    expect(await cm.handleForInboxAuth(next.inboxAuth)).toBe("h")
    expect(await cm.canSendTo(next.sendCredential, "h")).toBe(true)
  })

  it("a send credential is bound to exactly ONE handle", async () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"), new MemoryCredentialStore())
    const { sendCredential } = await cm.rotate("h1")
    expect(await cm.canSendTo(sendCredential, "h2")).toBe(false)
  })

  it("unknown credentials resolve to null/false", async () => {
    const cm = new CredentialManager(new SequenceTokenSource(), new MemoryCredentialStore())
    expect(await cm.handleForInboxAuth("nope")).toBeNull()
    expect(await cm.handleForSendCredential("nope")).toBeNull()
    expect(await cm.canSendTo("nope", "h")).toBe(false)
  })

  it("revoke clears credentials and is a no-op when absent", async () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"), new MemoryCredentialStore())
    const { inboxAuth, sendCredential } = await cm.rotate("h")
    await cm.revoke("h")
    expect(await cm.handleForInboxAuth(inboxAuth)).toBeNull()
    expect(await cm.canSendTo(sendCredential, "h")).toBe(false)
    await expect(cm.revoke("absent")).resolves.toBeUndefined()
  })
})

describe("RateLimiter — token bucket", () => {
  it("allows up to capacity then denies", () => {
    const clock = new ManualClock(0)
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 }, clock)
    expect(rl.take("k")).toBe(true)
    expect(rl.take("k")).toBe(true)
    expect(rl.take("k")).toBe(false) // empty
  })

  it("refills over time", () => {
    const clock = new ManualClock(0)
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 }, clock)
    expect(rl.take("k")).toBe(true)
    expect(rl.take("k")).toBe(false)
    clock.advance(1000) // +1 token
    expect(rl.take("k")).toBe(true)
  })

  it("caps refill at capacity", () => {
    const clock = new ManualClock(0)
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 10 }, clock)
    rl.take("k")
    rl.take("k") // empty
    clock.advance(10_000) // would add 100 tokens, capped at 2
    expect(rl.take("k")).toBe(true)
    expect(rl.take("k")).toBe(true)
    expect(rl.take("k")).toBe(false)
  })

  it("keys are independent", () => {
    const clock = new ManualClock(0)
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 }, clock)
    expect(rl.take("a")).toBe(true)
    expect(rl.take("b")).toBe(true) // b has its own bucket
    expect(rl.take("a")).toBe(false)
  })

  it("does not refill when time has not advanced", () => {
    const clock = new ManualClock(5000)
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 }, clock)
    expect(rl.take("k")).toBe(true)
    // Same instant — no refill branch taken.
    expect(rl.take("k")).toBe(false)
  })
})

describe("ManualClock", () => {
  it("advances and sets", () => {
    const c = new ManualClock(10)
    expect(c.now()).toBe(10)
    c.advance(5)
    expect(c.now()).toBe(15)
    c.set(100)
    expect(c.now()).toBe(100)
  })

  it("defaults to 0", () => {
    expect(new ManualClock().now()).toBe(0)
  })
})
