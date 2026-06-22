import { describe, expect, it } from "vitest"

import { loadConfig } from "../config"

describe("loadConfig — 12-factor, infra-agnostic", () => {
  it("defaults to a CLOSED invite policy and requires an admin credential", () => {
    expect(() => loadConfig({ RELAY_ADMIN_CREDENTIAL: "" })).toThrow(/RELAY_ADMIN_CREDENTIAL is required/)
  })

  it("accepts a closed policy with an admin credential and applies defaults", () => {
    const cfg = loadConfig({ RELAY_ADMIN_CREDENTIAL: "admin-secret" })
    expect(cfg.invitePolicy).toBe("closed")
    expect(cfg.adminCredential).toBe("admin-secret")
    expect(cfg.bindHost).toBe("0.0.0.0")
    expect(cfg.bindPort).toBe(8080)
    expect(cfg.publicUrl).toBe("https://relay.invalid")
    expect(cfg.did).toBe("did:web:relay.invalid")
    expect(cfg.protocolVersion).toBe("0.3.0")
    expect(cfg.inboxBounds).toEqual({ maxMessages: 256, maxBytes: 4 * 1024 * 1024 })
    expect(cfg.messageTtlMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(cfg.sendRateLimit).toEqual({ capacity: 60, refillPerSec: 1 })
    expect(cfg.directoryCredential).toBeUndefined()
  })

  it("an OPEN policy needs no admin credential", () => {
    const cfg = loadConfig({ RELAY_INVITE_POLICY: "open" })
    expect(cfg.invitePolicy).toBe("open")
    expect(cfg.adminCredential).toBeUndefined()
  })

  it("reads every override from env", () => {
    const cfg = loadConfig({
      RELAY_INVITE_POLICY: "open",
      RELAY_BIND_HOST: "127.0.0.1",
      RELAY_BIND_PORT: "9000",
      RELAY_PUBLIC_URL: "https://r.example",
      RELAY_DID: "did:web:r.example",
      RELAY_VERSION: "2.0.0",
      RELAY_PROTOCOL_VERSION: "0.4.0",
      RELAY_DIRECTORY_CREDENTIAL: "dir-secret",
      RELAY_INBOX_MAX_MESSAGES: "10",
      RELAY_INBOX_MAX_BYTES: "2048",
      RELAY_MESSAGE_TTL_MS: "60000",
      RELAY_SEND_RATE_CAPACITY: "5",
      RELAY_SEND_RATE_REFILL_PER_SEC: "2",
    })
    expect(cfg.bindHost).toBe("127.0.0.1")
    expect(cfg.bindPort).toBe(9000)
    expect(cfg.publicUrl).toBe("https://r.example")
    expect(cfg.did).toBe("did:web:r.example")
    expect(cfg.version).toBe("2.0.0")
    expect(cfg.protocolVersion).toBe("0.4.0")
    expect(cfg.directoryCredential).toBe("dir-secret")
    expect(cfg.inboxBounds).toEqual({ maxMessages: 10, maxBytes: 2048 })
    expect(cfg.messageTtlMs).toBe(60000)
    expect(cfg.sendRateLimit).toEqual({ capacity: 5, refillPerSec: 2 })
  })

  it("treats an empty-string numeric env as the default", () => {
    const cfg = loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_BIND_PORT: "" })
    expect(cfg.bindPort).toBe(8080)
  })

  it("throws on a non-integer numeric env", () => {
    expect(() => loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_BIND_PORT: "abc" })).toThrow(/must be a positive integer/)
  })

  it("throws on a non-positive numeric env", () => {
    expect(() => loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_INBOX_MAX_MESSAGES: "0" })).toThrow(/must be a positive integer/)
  })

  it("defaults RELAY_STORE to memory with no databaseUrl", () => {
    const cfg = loadConfig({ RELAY_INVITE_POLICY: "open" })
    expect(cfg.store).toBe("memory")
    expect(cfg.databaseUrl).toBeUndefined()
  })

  it("treats an empty RELAY_STORE as memory (default)", () => {
    const cfg = loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "" })
    expect(cfg.store).toBe("memory")
  })

  it("accepts RELAY_STORE=postgres with a valid DATABASE_URL", () => {
    const cfg = loadConfig({
      RELAY_INVITE_POLICY: "open",
      RELAY_STORE: "postgres",
      DATABASE_URL: "postgres://u:p@host:5432/db?sslmode=require",
    })
    expect(cfg.store).toBe("postgres")
    expect(cfg.databaseUrl).toBe("postgres://u:p@host:5432/db?sslmode=require")
  })

  it("FAILS LOUD when RELAY_STORE=postgres but DATABASE_URL is missing", () => {
    expect(() => loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "postgres" })).toThrow(/DATABASE_URL is required/)
  })

  it("FAILS LOUD when RELAY_STORE=postgres but DATABASE_URL is empty", () => {
    expect(() => loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "postgres", DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/)
  })

  it("FAILS LOUD on an unrecognized RELAY_STORE value", () => {
    expect(() => loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "sqlite" })).toThrow(/RELAY_STORE/)
  })

  it("ignores DATABASE_URL when RELAY_STORE is memory", () => {
    const cfg = loadConfig({ RELAY_INVITE_POLICY: "open", RELAY_STORE: "memory", DATABASE_URL: "postgres://ignored" })
    expect(cfg.store).toBe("memory")
    expect(cfg.databaseUrl).toBeUndefined()
  })

  it("defaults the env bag to process.env", () => {
    // Calling with no arg must not throw for the structure (process.env in CI has no
    // RELAY_* set → closed policy with no admin credential → it throws). We assert it
    // reaches the closed-policy guard, proving the default bag was read.
    const prev = process.env.RELAY_INVITE_POLICY
    process.env.RELAY_INVITE_POLICY = "open"
    try {
      expect(loadConfig().invitePolicy).toBe("open")
    } finally {
      if (prev === undefined) delete process.env.RELAY_INVITE_POLICY
      else process.env.RELAY_INVITE_POLICY = prev
    }
  })
})
