import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import { CredentialManager } from "../security/credentials"
import { InviteManager } from "../security/invites"
import { RateLimiter } from "../security/rate-limit"
import { cryptoTokenSource, SequenceTokenSource } from "../security/tokens"

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

describe("InviteManager — closed membership", () => {
  it("issues a single-use invite that consumes once then fails", () => {
    const inv = new InviteManager(new SequenceTokenSource("inv"))
    const t = inv.issue()
    expect(t).toBe("inv-1")
    expect(inv.consume(t)).toBe(true)
    expect(inv.consume(t)).toBe(false) // reuse rejected
  })

  it("rejects an unknown token", () => {
    const inv = new InviteManager(new SequenceTokenSource())
    expect(inv.consume("never-issued")).toBe(false)
  })

  it("honors a multi-use cap", () => {
    const inv = new InviteManager(new SequenceTokenSource("inv"))
    const t = inv.issue(2)
    expect(inv.consume(t)).toBe(true)
    expect(inv.consume(t)).toBe(true)
    expect(inv.consume(t)).toBe(false) // exhausted
  })

  it("throws on a non-positive use cap", () => {
    const inv = new InviteManager(new SequenceTokenSource())
    expect(() => inv.issue(0)).toThrow(/uses must be >= 1/)
  })
})

describe("CredentialManager — rotating send-credentials", () => {
  it("mints a pair and resolves both directions", () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"))
    const { inboxAuth, sendCredential } = cm.rotate("h")
    expect(inboxAuth).toBe("c-1")
    expect(sendCredential).toBe("c-2")
    expect(cm.handleForInboxAuth("c-1")).toBe("h")
    expect(cm.canSendTo("c-2", "h")).toBe(true)
    expect(cm.handleForSendCredential("c-2")).toBe("h")
  })

  it("rotation revokes the prior pair", () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"))
    cm.rotate("h") // c-1 inbox, c-2 send
    const next = cm.rotate("h") // c-3 inbox, c-4 send
    expect(cm.handleForInboxAuth("c-1")).toBeNull()
    expect(cm.canSendTo("c-2", "h")).toBe(false)
    expect(cm.handleForInboxAuth(next.inboxAuth)).toBe("h")
    expect(cm.canSendTo(next.sendCredential, "h")).toBe(true)
  })

  it("a send credential is bound to exactly ONE handle", () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"))
    const { sendCredential } = cm.rotate("h1")
    expect(cm.canSendTo(sendCredential, "h2")).toBe(false)
  })

  it("unknown credentials resolve to null/false", () => {
    const cm = new CredentialManager(new SequenceTokenSource())
    expect(cm.handleForInboxAuth("nope")).toBeNull()
    expect(cm.handleForSendCredential("nope")).toBeNull()
    expect(cm.canSendTo("nope", "h")).toBe(false)
  })

  it("revoke clears credentials and is a no-op when absent", () => {
    const cm = new CredentialManager(new SequenceTokenSource("c"))
    const { inboxAuth, sendCredential } = cm.rotate("h")
    cm.revoke("h")
    expect(cm.handleForInboxAuth(inboxAuth)).toBeNull()
    expect(cm.canSendTo(sendCredential, "h")).toBe(false)
    expect(() => cm.revoke("absent")).not.toThrow()
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
