// at-rest-hashing.test — RF3: the high-entropy bearer secrets the relay persists
// (invite `token`, credential `inbox_auth` + `send_credential`) must be stored HASHED
// (SHA-256), never in the clear — so a DB / backup / replica leak yields only digests,
// not usable bearer tokens. The hashing happens at the STORE boundary so BOTH backends
// store a hash (parity preserved). The plaintext must not be recoverable from any
// stored row; a valid secret still authenticates; an invalid one still rejects.
//
// The Pg assertions inspect the RAW stored columns via the pool (the strongest proof —
// it reads what a `select *` / a backup would actually carry). The memory assertions
// prove the in-memory store holds the hash too (its `getCurrent` returns the digest,
// and the plaintext is not findable among its stored values).
import { describe, expect, it } from "vitest"

import { sha256Hex } from "../security/hash"
import { migratedPgMem } from "./pg-harness"
import { MemoryCredentialStore, MemoryInviteStore } from "../store/memory"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgInviteStore } from "../store/postgres/invites"

const IA = "inbox-auth-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SC = "send-cred-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const TOKEN = "invite-token-secret-cccccccccccccccccccccccccccc"

describe("RF3 — bearer secrets are hashed at rest (Postgres, raw-column proof)", () => {
  it("the credentials row stores the SHA-256 of inbox_auth + send_credential, not the plaintext", async () => {
    const { pool } = await migratedPgMem()
    const store = new PgCredentialStore(pool)
    await store.setCurrent("h", { inboxAuth: IA, sendCredential: SC })

    // Inspect the RAW row exactly as a `select *` / a backup would see it.
    const res = await pool.query(`select handle, inbox_auth, send_credential from credentials where handle = $1`, ["h"])
    const row = res.rows[0] as { handle: string; inbox_auth: string; send_credential: string }
    expect(row.inbox_auth).toBe(sha256Hex(IA))
    expect(row.send_credential).toBe(sha256Hex(SC))
    // The plaintext secrets appear NOWHERE in the stored row.
    const raw = JSON.stringify(row)
    expect(raw.includes(IA)).toBe(false)
    expect(raw.includes(SC)).toBe(false)
  })

  it("a valid credential still authenticates (presented plaintext is hashed for the lookup); an invalid one rejects", async () => {
    const { pool } = await migratedPgMem()
    const store = new PgCredentialStore(pool)
    await store.setCurrent("h", { inboxAuth: IA, sendCredential: SC })
    // Valid: present the PLAINTEXT secret → the store hashes it → resolves.
    expect(await store.handleForInboxAuth(IA)).toBe("h")
    expect(await store.handleForSendCredential(SC)).toBe("h")
    // Invalid: a wrong secret (and notably the HASH itself, in case a leaked digest is
    // replayed as a bearer) does not resolve.
    expect(await store.handleForInboxAuth("wrong")).toBeNull()
    expect(await store.handleForSendCredential(sha256Hex(SC))).toBeNull()
  })

  it("the invites row stores the SHA-256 of the token, not the plaintext; lookup-by-plaintext still works", async () => {
    const { pool } = await migratedPgMem()
    const store = new PgInviteStore(pool)
    await store.setRemaining(TOKEN, 2)
    const res = await pool.query(`select token, remaining from invites where token = $1`, [sha256Hex(TOKEN)])
    const row = res.rows[0] as { token: string; remaining: number } | undefined
    expect(row).toBeDefined()
    expect(row?.token).toBe(sha256Hex(TOKEN))
    // The plaintext token is NOT a row key (a leak of the table can't be replayed).
    const byPlain = await pool.query(`select token from invites where token = $1`, [TOKEN])
    expect(byPlain.rows).toHaveLength(0)
    // But the store's own API (which hashes) still resolves the plaintext token.
    expect(await store.getRemaining(TOKEN)).toBe(2)
    expect(await store.decrementOrDelete(TOKEN)).toBe(true)
    expect(await store.getRemaining(TOKEN)).toBe(1)
  })
})

describe("RF3 — bearer secrets are hashed at rest (memory store)", () => {
  it("the memory credential store holds the hash (getCurrent returns the digest, not the plaintext)", async () => {
    const store = new MemoryCredentialStore()
    await store.setCurrent("h", { inboxAuth: IA, sendCredential: SC })
    // getCurrent returns the STORED form = the SHA-256 digests (its only consumer is
    // the rotation revoke path, which feeds the result straight back to deleteFor).
    expect(await store.getCurrent("h")).toEqual({ inboxAuth: sha256Hex(IA), sendCredential: sha256Hex(SC) })
    // The plaintext still authenticates (the store hashes the presented value).
    expect(await store.handleForInboxAuth(IA)).toBe("h")
    expect(await store.handleForSendCredential(SC)).toBe("h")
  })

  it("the memory invite store holds the hashed token (lookup-by-plaintext still works)", async () => {
    const store = new MemoryInviteStore()
    await store.setRemaining(TOKEN, 1)
    expect(await store.getRemaining(TOKEN)).toBe(1)
    expect(await store.decrementOrDelete(TOKEN)).toBe(true)
    expect(await store.getRemaining(TOKEN)).toBeUndefined()
  })
})
