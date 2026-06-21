import { describe, expect, it } from "vitest"

import { buildRelayAgentCard } from "../agent-card"
import { systemClock } from "../clock"
import { MemoryLogger, silentLogger } from "../logger"
import { messageSizeBytes, validateOpaqueMessage } from "../message"
import type { A2AMessage } from "../types"

function goodMessage(): A2AMessage {
  return {
    messageId: "m1",
    role: "agent",
    parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "ePk", n: "nonce", ct: "cipher" }, recipientDid: "did:key:zB" } }],
  }
}

describe("buildRelayAgentCard", () => {
  it("builds the relay's own A2A card with no content capability", () => {
    const card = buildRelayAgentCard({ url: "https://r", did: "did:web:r", version: "1.0.0", protocolVersion: "0.3.0" })
    expect(card.name).toBe("friends-relay")
    expect(card.url).toBe("https://r")
    expect(card.did).toBe("did:web:r")
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
    expect(card.securitySchemes).toEqual({})
    expect(card.security).toEqual([])
    expect(card.description).toMatch(/content-blind/)
  })

  it("honors a custom name", () => {
    const card = buildRelayAgentCard({ url: "u", did: "d", version: "1", protocolVersion: "0.3.0", name: "my-relay" })
    expect(card.name).toBe("my-relay")
  })
})

describe("validateOpaqueMessage — shape only, never content", () => {
  it("accepts a well-formed A2A message and returns ONLY routing + opaque blob", () => {
    const r = validateOpaqueMessage(goodMessage())
    expect(r).toEqual({ v: 1, sealed: { v: 1, ePk: "ePk", n: "nonce", ct: "cipher" }, recipientDid: "did:key:zB" })
  })

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a number", 5],
  ])("rejects %s", (_label, input) => {
    expect(validateOpaqueMessage(input)).toBeNull()
  })

  it("rejects a missing/empty messageId", () => {
    const m = goodMessage()
    expect(validateOpaqueMessage({ ...m, messageId: "" })).toBeNull()
    expect(validateOpaqueMessage({ ...m, messageId: 5 as unknown as string })).toBeNull()
  })

  it("rejects a wrong role", () => {
    expect(validateOpaqueMessage({ ...goodMessage(), role: "user" })).toBeNull()
  })

  it("rejects a non-single parts array", () => {
    expect(validateOpaqueMessage({ ...goodMessage(), parts: [] })).toBeNull()
    const two = goodMessage()
    expect(validateOpaqueMessage({ ...two, parts: [two.parts[0], two.parts[0]] })).toBeNull()
    expect(validateOpaqueMessage({ ...goodMessage(), parts: "x" as unknown as A2AMessage["parts"] })).toBeNull()
  })

  it("rejects a non-data part", () => {
    expect(validateOpaqueMessage({ ...goodMessage(), parts: [{ kind: "text" } as never] })).toBeNull()
    expect(validateOpaqueMessage({ ...goodMessage(), parts: [null as never] })).toBeNull()
  })

  it("rejects a missing/ill-typed data", () => {
    expect(validateOpaqueMessage({ ...goodMessage(), parts: [{ kind: "data" } as never] })).toBeNull()
    expect(validateOpaqueMessage({ ...goodMessage(), parts: [{ kind: "data", data: "x" } as never] })).toBeNull()
  })

  it("rejects a missing/empty recipientDid", () => {
    const m = goodMessage()
    const bad = { ...m, parts: [{ kind: "data" as const, data: { v: 1, sealed: m.parts[0].data.sealed, recipientDid: "" } }] }
    expect(validateOpaqueMessage(bad)).toBeNull()
  })

  it("rejects a non-number v", () => {
    const m = goodMessage()
    const bad = { ...m, parts: [{ kind: "data" as const, data: { v: "1" as unknown as number, sealed: m.parts[0].data.sealed, recipientDid: "did:key:zB" } }] }
    expect(validateOpaqueMessage(bad)).toBeNull()
  })

  it.each([
    ["missing sealed", undefined],
    ["sealed not an object", "x"],
    ["sealed missing ct", { v: 1, ePk: "e", n: "n" }],
    ["sealed ct not a string", { v: 1, ePk: "e", n: "n", ct: 5 }],
    ["sealed v not a number", { v: "1", ePk: "e", n: "n", ct: "c" }],
    ["sealed ePk not a string", { v: 1, ePk: 5, n: "n", ct: "c" }],
    ["sealed n not a string", { v: 1, ePk: "e", n: 5, ct: "c" }],
  ])("rejects a malformed sealed blob (%s)", (_label, sealed) => {
    const m = goodMessage()
    const bad = { ...m, parts: [{ kind: "data" as const, data: { v: 1, sealed: sealed as never, recipientDid: "did:key:zB" } }] }
    expect(validateOpaqueMessage(bad)).toBeNull()
  })
})

describe("messageSizeBytes", () => {
  it("measures the serialized JSON byte length", () => {
    const size = messageSizeBytes(goodMessage())
    expect(size).toBe(Buffer.byteLength(JSON.stringify(goodMessage()), "utf8"))
    expect(size).toBeGreaterThan(0)
  })
})

describe("logger seams", () => {
  it("silentLogger is a no-op that does not throw", () => {
    expect(() => silentLogger.log("info", "x", { handle: "h" })).not.toThrow()
  })

  it("MemoryLogger collects entries and defaults fields to {}", () => {
    const log = new MemoryLogger()
    log.log("warn", "evt", { reason: "r" })
    log.log("info", "evt2")
    expect(log.entries).toEqual([
      { level: "warn", event: "evt", fields: { reason: "r" } },
      { level: "info", event: "evt2", fields: {} },
    ])
  })
})

describe("systemClock", () => {
  it("returns a wall-clock timestamp near Date.now", () => {
    const before = Date.now()
    const t = systemClock.now()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })
})
