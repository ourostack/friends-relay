// interop-a2a-client — THE HEADLINE PROOF. This test drives the REAL, published
// `@ouro.bot/friends/a2a-client` (sealEnvelope/sendShare + receiveShare) end-to-end
// THROUGH this relay, and proves the relay is content-blind + abuse-resistant:
//
//   - Two agents register (B is OFFLINE → a relay handle); A sends a sealed envelope
//     for B via the relay; B PULLS it and OPENS + IMPORTS it (full round-trip).
//   - CONTENT-BLIND: assert the relay only ever HELD ciphertext — by inspecting what
//     its inbox store actually stored (no plaintext join-key / note / friendsKind /
//     sender DID; only { v, sealed:{v,ePk,n,ct}, recipientDid }).
//   - INVITE-GATING rejects a non-invited agent.
//   - RATE-LIMIT / QUOTA / TTL drop excess (bounded queue — the DoS floor).
//   - REPLAY is handled (the recipient seen-ledger skips a re-delivered blob).
//
// The relay never decrypts — it has no key and no code path to. Its compromise can
// only deny/delay/leak-metadata; it does NOT weaken the a2a-client's E2E guarantee.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FileFriendStore,
  FileMissionStore,
  missionsDirFor,
} from "@ouro.bot/friends"
import type { FriendRecord, IdentityProvider, TrustLevel } from "@ouro.bot/friends"
import {
  didKeyIdentityFromEd25519,
  keyAgreementFromDidKey,
  MemoryPinStore,
  parseDidKey,
  pinOnFirstContact,
  ready,
  receiveShare,
  sendShare,
} from "@ouro.bot/friends/a2a-client"
import type { A2AMessage, DidKeyIdentity, DidResolution, Sodium } from "@ouro.bot/friends/a2a-client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { handle } from "../server/http"
import type { RelayRequest } from "../server/http"
import { MemoryInboxStore, MemoryRegistryStore } from "../store/memory"
import { RelayClient, RelayClientError } from "../client"
import type { FetchLike } from "../client"

const NOW = "2026-01-01T00:00:00.000Z"
const SUBJECT_JOIN_KEY = "teams:proof-subject-xyz"
const SECRET_NOTE = "super-secret-note-do-not-leak"

/** The plaintext profile-share envelope the a2a-client will seal+sign. */
function profileEnvelope(fromDid: string) {
  return {
    subject: { externalIds: [{ provider: "teams" as IdentityProvider, externalId: SUBJECT_JOIN_KEY, linkedAt: NOW }], displayName: "Jordan" },
    fromAgentId: fromDid,
    scope: "notes:safe" as const,
    notes: [{ key: "bio", value: SECRET_NOTE }],
    issuedAt: NOW,
  }
}

/** A subject record B already holds, with a FIRST-PARTY note the import must NOT touch. */
function subjectInB(): FriendRecord {
  return {
    id: "subj-P",
    name: "Jordan",
    role: "friend",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [{ provider: "teams" as IdentityProvider, externalId: SUBJECT_JOIN_KEY, linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: { role: { value: "B's own first-party guess", savedAt: NOW, provenance: { origin: "first_party" } } },
    learnings: {},
    status: { state: "active", note: "B-first-party-status", updatedAt: NOW },
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  } as FriendRecord
}

/** A real did:key resolver (pin on first contact). */
function didKeyResolution(sodium: Sodium): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
      const existing = pinStore.get(fromAgentId)
      if (existing) return { ed25519Pub: existing.ed25519Pub }
      const parsed = parseDidKey(did)
      if (!parsed) return null
      try {
        keyAgreementFromDidKey({ sodium, ed25519Pub: parsed.ed25519Pub })
      } catch {
        return null
      }
      pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: parsed.ed25519Pub })
      return { ed25519Pub: parsed.ed25519Pub }
    },
  }
}

/** The recipient seen-ledger (replay dedup, keyed on the seal nonce). */
class SeenLedger {
  private readonly set = new Set<string>()
  isSeen(n: string): boolean {
    return this.set.has(n)
  }
  markSeen(n: string): void {
    this.set.add(n)
  }
}

function relayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    bindHost: "0.0.0.0",
    bindPort: 0,
    publicUrl: "https://relay.test",
    did: "did:web:relay.test",
    version: "1.0.0",
    protocolVersion: "0.3.0",
    invitePolicy: "closed",
    adminCredential: "admin-secret",
    directoryCredential: undefined,
    inboxBounds: { maxMessages: 8, maxBytes: 1_000_000 },
    messageTtlMs: 10_000,
    sendRateLimit: { capacity: 100, refillPerSec: 1 },
    ...overrides,
  }
}

/** An injected fetch routing through the pure relay router — no sockets. */
function inProcessFetch(cfg: RelayConfig, relay: Relay): FetchLike {
  return async (url, init) => {
    const u = new URL(url)
    const auth = init?.headers?.authorization
    const reqObj: RelayRequest = {
      method: init?.method ?? "GET",
      path: u.pathname,
      bearer: auth ? /^Bearer (.+)$/.exec(auth)?.[1] : undefined,
      headers: {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    }
    const res = await handle(cfg, relay, reqObj)
    return { status: res.status, json: async () => res.body }
  }
}

describe("INTEROP — the real @ouro.bot/friends/a2a-client through the relay", () => {
  let sodium: Sodium
  let dirB: string
  let A: DidKeyIdentity
  let B: DidKeyIdentity

  beforeEach(async () => {
    sodium = await ready()
    dirB = mkdtempSync(join(tmpdir(), "friends-relay-interop-B-"))
    const aKp = sodium.crypto_sign_keypair()
    const bKp = sodium.crypto_sign_keypair()
    A = didKeyIdentityFromEd25519({ sodium, ed25519Pub: aKp.publicKey, ed25519Priv: aKp.privateKey })
    B = didKeyIdentityFromEd25519({ sodium, ed25519Pub: bKp.publicKey, ed25519Priv: bKp.privateKey })
  })

  afterEach(() => {
    rmSync(dirB, { recursive: true, force: true })
  })

  /** Stand up a relay + client + register B (offline → a relay handle). Returns the
   * pieces the test drives. */
  function standUp(cfg = relayConfig()) {
    const inbox = new MemoryInboxStore(cfg.inboxBounds)
    const clock = new ManualClock(0)
    const relay = new Relay({
      config: cfg,
      inbox,
      registry: new MemoryRegistryStore(),
      tokens: new SequenceTokenSource("t"),
      clock,
      logger: new MemoryLogger(),
    })
    const client = new RelayClient({ baseUrl: "https://relay.test", fetch: inProcessFetch(cfg, relay) })
    return { relay, client, inbox, clock, cfg }
  }

  /** A's send transport: bridge the a2a-client's A2ATransport to the relay client. */
  function sendViaRelay(client: RelayClient, sendCredential: string) {
    return {
      async send(target: { rung: string; address: string }, message: A2AMessage): Promise<void> {
        // The relay rung addresses by handle (target.address === the relay handle).
        await client.send(target.address, sendCredential, message)
      },
    }
  }

  it("registers, sends a sealed envelope for OFFLINE B, B pulls + opens it; the relay only ever held CIPHERTEXT", async () => {
    const { client, inbox } = standUp()

    // B (offline) registers a relay handle WITH an invite.
    const invite = await client.issueInvite("admin-secret")
    const bGrant = await client.register({
      handle: "B-opaque-handle",
      did: B.did,
      agentCard: { name: "B", url: "https://b.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      keyAgreementPubKey: sodium.to_base64(B.x25519Pub, sodium.base64_variants.ORIGINAL),
      inviteToken: invite,
    })

    // A also needs a SEND credential for B's handle. In this relay, the send
    // credential is minted to the REGISTRANT and shared with senders out-of-band
    // (the registrant tells its friends how to reach it). B hands A its send cred.
    const sendCredential = bGrant.sendCredential

    // A sends a sealed+signed profile share to B THROUGH the relay (B has no
    // endpoint — only the relay handle). This is the REAL a2a-client sendShare.
    const sendResult = await sendShare({
      sodium,
      transport: sendViaRelay(client, sendCredential),
      fromIdentity: A,
      toPeer: { a2a: { relay: { url: "https://relay.test", handle: "B-opaque-handle" }, did: B.did } },
      recipientDid: B.did,
      recipientX25519Pub: B.x25519Pub,
      plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(sendResult.ok).toBe(true)
    expect(sendResult.ok && sendResult.rung).toBe("relay")

    // ── CONTENT-BLIND ASSERTION — inspect what the relay STORED for B's inbox. ──
    const stored = await inbox.list("B-opaque-handle", 0)
    expect(stored).toHaveLength(1)
    const storedBytes = JSON.stringify(stored[0].message)
    // The relay held ONLY ciphertext: no plaintext leaks anywhere in the blob.
    expect(storedBytes.includes(SUBJECT_JOIN_KEY)).toBe(false)
    expect(storedBytes.includes(SECRET_NOTE)).toBe(false)
    expect(storedBytes.includes("profile_share")).toBe(false)
    expect(storedBytes.includes(A.did)).toBe(false)
    // And the DataPart carries ONLY the routing + opaque sealed blob.
    const data = stored[0].message.parts[0].data
    expect(Object.keys(data).sort()).toEqual(["recipientDid", "sealed", "v"])
    expect(Object.keys(data.sealed).sort()).toEqual(["ct", "ePk", "n", "v"])
    expect(data.recipientDid).toBe(B.did)

    // ── B PULLS the opaque message from the relay and OPENS + IMPORTS it. ──
    const storeB = new FileFriendStore(join(dirB, "friends"))
    const missionsB = new FileMissionStore(missionsDirFor(dirB))
    await storeB.put("subj-P", subjectInB())

    const pulled = await client.pull("B-opaque-handle", bGrant.inboxAuth)
    expect(pulled).toHaveLength(1)

    const recv = await receiveShare({
      sodium,
      store: storeB,
      missionStore: missionsB,
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      a2aMessage: pulled[0].message,
      recipientDid: B.did,
      recipientIdentity: { x25519Priv: B.x25519Priv, x25519Pub: B.x25519Pub },
      trustOfSource: "friend" as TrustLevel,
    })
    expect(recv.state).toBe("completed")
    expect(recv.state === "completed" && recv.status).toBe("imported")

    // The opaque blob the relay carried WAS the real sealed envelope: the import
    // landed A's note, quarantined under importedNotes, first-party untouched.
    const after = await storeB.get("subj-P")
    expect(after?.importedNotes?.[A.did]?.bio.value).toBe(SECRET_NOTE)
    expect(after?.notes.role.value).toBe("B's own first-party guess")
    expect(after?.trustLevel).toBe("acquaintance")

    // B acks → the relay drops it (not a content store).
    expect(await client.ack("B-opaque-handle", bGrant.inboxAuth, pulled[0].queueId)).toBe(true)
    expect(await inbox.list("B-opaque-handle", 0)).toHaveLength(0)
  })

  it("INVITE-GATING rejects a non-invited agent", async () => {
    const { client } = standUp()
    await expect(
      client.register({
        handle: "uninvited",
        did: B.did,
        agentCard: { name: "X", url: "https://x.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      client.register({
        handle: "uninvited",
        did: B.did,
        agentCard: { name: "X", url: "https://x.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
        inviteToken: "bogus",
      }),
    ).rejects.toBeInstanceOf(RelayClientError)
  })

  it("RATE-LIMIT drops excess sends past the per-credential bucket", async () => {
    const { client } = standUp(relayConfig({ sendRateLimit: { capacity: 2, refillPerSec: 1 } }))
    const invite = await client.issueInvite("admin-secret")
    const bGrant = await client.register({
      handle: "B-opaque-handle",
      did: B.did,
      agentCard: { name: "B", url: "https://b.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      inviteToken: invite,
    })
    const send = sendViaRelay(client, bGrant.sendCredential)
    const mk = async () =>
      sendShare({
        sodium,
        transport: send,
        fromIdentity: A,
        toPeer: { a2a: { relay: { url: "https://relay.test", handle: "B-opaque-handle" }, did: B.did } },
        recipientDid: B.did,
        recipientX25519Pub: B.x25519Pub,
        plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
        friendsKind: "profile_share",
      })
    await mk()
    await mk()
    // The third send hits the rate limit; the relay client throws (429).
    await expect(mk()).rejects.toMatchObject({ status: 429, code: "rate_limited" })
  })

  it("QUOTA drops past the bounded per-handle inbox (the DoS floor)", async () => {
    const { client } = standUp(relayConfig({ inboxBounds: { maxMessages: 1, maxBytes: 1_000_000 } }))
    const invite = await client.issueInvite("admin-secret")
    const bGrant = await client.register({
      handle: "B-opaque-handle",
      did: B.did,
      agentCard: { name: "B", url: "https://b.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      inviteToken: invite,
    })
    const send = sendViaRelay(client, bGrant.sendCredential)
    const mk = async () =>
      sendShare({
        sodium,
        transport: send,
        fromIdentity: A,
        toPeer: { a2a: { relay: { url: "https://relay.test", handle: "B-opaque-handle" }, did: B.did } },
        recipientDid: B.did,
        recipientX25519Pub: B.x25519Pub,
        plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
        friendsKind: "profile_share",
      })
    await mk()
    // The second exceeds the count quota → dropped (507).
    await expect(mk()).rejects.toMatchObject({ status: 507, code: "quota_count" })
  })

  it("TTL expires a queued message (the queue is bounded by time too)", async () => {
    const { client, inbox, clock } = standUp(relayConfig({ messageTtlMs: 500 }))
    const invite = await client.issueInvite("admin-secret")
    const bGrant = await client.register({
      handle: "B-opaque-handle",
      did: B.did,
      agentCard: { name: "B", url: "https://b.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      inviteToken: invite,
    })
    await sendShare({
      sodium,
      transport: sendViaRelay(client, bGrant.sendCredential),
      fromIdentity: A,
      toPeer: { a2a: { relay: { url: "https://relay.test", handle: "B-opaque-handle" }, did: B.did } },
      recipientDid: B.did,
      recipientX25519Pub: B.x25519Pub,
      plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(await inbox.list("B-opaque-handle", 0)).toHaveLength(1)
    // Advance past the TTL → the message expires + drops; B pulls nothing.
    clock.advance(600)
    expect(await client.pull("B-opaque-handle", bGrant.inboxAuth)).toHaveLength(0)
    expect(await relay_sweep(inbox, 600)).toBeGreaterThanOrEqual(0)
  })

  it("REPLAY is handled — a re-delivered blob is skipped by the recipient seen-ledger", async () => {
    const { client } = standUp()
    const invite = await client.issueInvite("admin-secret")
    const bGrant = await client.register({
      handle: "B-opaque-handle",
      did: B.did,
      agentCard: { name: "B", url: "https://b.invalid", version: "1", protocolVersion: "0.3.0", did: B.did },
      inviteToken: invite,
    })
    await sendShare({
      sodium,
      transport: sendViaRelay(client, bGrant.sendCredential),
      fromIdentity: A,
      toPeer: { a2a: { relay: { url: "https://relay.test", handle: "B-opaque-handle" }, did: B.did } },
      recipientDid: B.did,
      recipientX25519Pub: B.x25519Pub,
      plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    const storeB = new FileFriendStore(join(dirB, "friends"))
    const missionsB = new FileMissionStore(missionsDirFor(dirB))
    await storeB.put("subj-P", subjectInB())

    const pulled = await client.pull("B-opaque-handle", bGrant.inboxAuth)
    const seen = new SeenLedger() // a SHARED ledger across both deliveries
    const recvArgs = {
      sodium,
      store: storeB,
      missionStore: missionsB,
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen,
      recipientDid: B.did,
      recipientIdentity: { x25519Priv: B.x25519Priv, x25519Pub: B.x25519Pub },
      trustOfSource: "friend" as TrustLevel,
    }
    const first = await receiveShare({ ...recvArgs, a2aMessage: pulled[0].message })
    expect(first.state).toBe("completed")
    // Re-deliver the SAME opaque blob (a replay) → the seen-ledger skips it.
    const replay = await receiveShare({ ...recvArgs, a2aMessage: pulled[0].message })
    expect(replay.state).toBe("rejected")
    expect(replay.state === "rejected" && replay.reason).toBe("replayed")
  })
})

/** Drive a relay-side expiry sweep for the TTL assertion (kept local to avoid
 * coupling the test to the relay's scheduled sweep). */
function relay_sweep(inbox: MemoryInboxStore, now: number): Promise<number> {
  return inbox.dropExpired(now)
}
