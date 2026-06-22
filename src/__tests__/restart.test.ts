// restart.test — THE HEADLINE DURABILITY PROOF. Assemble a relay over the Postgres
// adapters on a pg-mem db, drive a full lifecycle (mint+consume invite, register →
// rotate credentials, enqueue a sealed message), then SIMULATE A PROCESS RESTART by
// discarding the relay + its adapters and rebuilding a fresh relay over a NEW pool on
// the SAME db. Everything durable must survive: the registration, the queued sealed
// message, the credential bindings (inboxAuth still drains, sendCredential still
// posts), and the invite's remaining-use state. A single-use invite consumed
// pre-restart stays rejected; a credential rotated away pre-restart stays rejected.
//
// This is what the in-memory backend CANNOT do (a restart drops it all) and is the
// whole point of the Postgres backend.
import { describe, expect, it } from "vitest"

import { ManualClock } from "../clock"
import type { RelayConfig } from "../config"
import { loadConfig } from "../config"
import { MemoryLogger } from "../logger"
import { Relay } from "../relay"
import { SequenceTokenSource } from "../security/tokens"
import { assemblePostgresStores, assembleRelay } from "../server/bootstrap"
import { makePgMem } from "./pg-harness"
import type { PgMemHandle } from "./pg-harness"
import type { A2AMessage } from "../types"

function sealed(recipientDid: string, ct = "Y2lwaGVydGV4dA=="): A2AMessage {
  return { messageId: "m-seal", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: { v: 1, ePk: "ePk", n: "nonce", ct }, recipientDid } }] }
}

/** Build a relay over the Postgres adapters on `handle`'s db. Each call makes a FRESH
 * pool over the same db (the migrate is idempotent), so calling it twice models a
 * process restart. A deterministic token source keeps credentials predictable WITHIN
 * one relay instance; across "restarts" the bindings are read from the db, not the
 * token source, so durability — not token determinism — is what's under test. */
async function buildRelay(handle: PgMemHandle, config: RelayConfig, tokenPrefix: string): Promise<Relay> {
  const stores = await assemblePostgresStores(config.databaseUrl as string, config.inboxBounds, () => handle.newPool())
  return assembleRelay(config, {
    ...stores,
    tokens: new SequenceTokenSource(tokenPrefix),
    clock: new ManualClock(0),
    logger: new MemoryLogger(),
  })
}

describe("simulated restart — durability over the Postgres backend", () => {
  const config = loadConfig({ RELAY_INVITE_POLICY: "closed", RELAY_ADMIN_CREDENTIAL: "admin", RELAY_STORE: "postgres", DATABASE_URL: "postgres://ignored" })
  const RECIPIENT_DID = "did:key:zRecipient"

  it("registration + queued message + credentials + invite state all survive a restart", async () => {
    const handle = makePgMem()

    // ── before restart: relay #1 over a fresh pool on the db ──
    const relay1 = await buildRelay(handle, config, "t")
    // Mint a 2-use invite, consume ONE use to register.
    const invite = await relay1.issueInvite(2)
    const reg = await relay1.register({
      handle: "B",
      did: RECIPIENT_DID,
      agentCard: { name: "B", url: "https://b", version: "1", protocolVersion: "0.3.0", did: RECIPIENT_DID },
      keyAgreementPubKey: "x25519pub",
      inviteToken: invite,
    })
    expect(reg.ok).toBe(true)
    if (!reg.ok) return
    const { inboxAuth, sendCredential } = reg.grant
    // A friend posts a sealed message to B's handle.
    const enq = await relay1.enqueue({ handle: "B", sendCredential, message: sealed(RECIPIENT_DID) })
    expect(enq.ok).toBe(true)

    // ── RESTART: discard relay1 + its pool; build relay #2 over the SAME db ──
    const relay2 = await buildRelay(handle, config, "t2")

    // (1) The registration survived (directory still resolves B by handle + DID).
    expect((await relay2.lookupByHandle("B"))?.keyAgreementPubKey).toBe("x25519pub")
    expect((await relay2.lookupByDid(RECIPIENT_DID))?.handle).toBe("B")

    // (2) The queued sealed message survived AND is still content-blind.
    const pulled = await relay2.pull("B", inboxAuth)
    expect(pulled.ok).toBe(true)
    if (!pulled.ok) return
    expect(pulled.messages).toHaveLength(1)
    expect(pulled.messages[0].message.parts[0].data.sealed.ct).toBe("Y2lwaGVydGV4dA==")
    expect(Object.keys(pulled.messages[0].message.parts[0].data).sort()).toEqual(["recipientDid", "sealed", "v"])

    // (3) The credential bindings survived: inboxAuth still drains (proven by the
    // successful pull above), and sendCredential still posts a NEW message.
    const enq2 = await relay2.enqueue({ handle: "B", sendCredential, message: sealed(RECIPIENT_DID, "c2") })
    expect(enq2.ok).toBe(true)

    // (4) The invite's remaining use survived: it had 2 uses, 1 consumed pre-restart,
    // so ONE use remains and registers a second handle post-restart.
    const reg2 = await relay2.register({
      handle: "C",
      did: "did:key:zC",
      agentCard: { name: "C", url: "https://c", version: "1", protocolVersion: "0.3.0", did: "did:key:zC" },
      inviteToken: invite,
    })
    expect(reg2.ok).toBe(true)
  })

  it("a single-use invite consumed pre-restart stays rejected post-restart", async () => {
    const handle = makePgMem()
    const relay1 = await buildRelay(handle, config, "t")
    const invite = await relay1.issueInvite() // single-use
    const first = await relay1.register({
      handle: "B",
      did: RECIPIENT_DID,
      agentCard: { name: "B", url: "https://b", version: "1", protocolVersion: "0.3.0", did: RECIPIENT_DID },
      inviteToken: invite,
    })
    expect(first.ok).toBe(true)

    // RESTART, then try to reuse the now-exhausted invite.
    const relay2 = await buildRelay(handle, config, "t2")
    const reused = await relay2.register({
      handle: "C",
      did: "did:key:zC",
      agentCard: { name: "C", url: "https://c", version: "1", protocolVersion: "0.3.0", did: "did:key:zC" },
      inviteToken: invite,
    })
    expect(reused).toEqual({ ok: false, error: "invite_invalid" })
  })

  it("a credential rotated away pre-restart stays rejected post-restart", async () => {
    const handle = makePgMem()
    const relay1 = await buildRelay(handle, config, "t")
    const invite = await relay1.issueInvite(2)
    const first = await relay1.register({
      handle: "B",
      did: RECIPIENT_DID,
      agentCard: { name: "B", url: "https://b", version: "1", protocolVersion: "0.3.0", did: RECIPIENT_DID },
      inviteToken: invite,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const oldSend = first.grant.sendCredential
    const oldInbox = first.grant.inboxAuth
    // Re-register the SAME handle → ROTATE (the old pair is revoked).
    const second = await relay1.register({
      handle: "B",
      did: RECIPIENT_DID,
      agentCard: { name: "B", url: "https://b", version: "1", protocolVersion: "0.3.0", did: RECIPIENT_DID },
      inviteToken: invite,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    // RESTART. The OLD credentials must still be rejected; the NEW ones still work.
    const relay2 = await buildRelay(handle, config, "t2")
    expect(await relay2.enqueue({ handle: "B", sendCredential: oldSend, message: sealed(RECIPIENT_DID) })).toEqual({ ok: false, error: "bad_send_credential" })
    expect(await relay2.pull("B", oldInbox)).toEqual({ ok: false, error: "bad_inbox_auth" })
    expect((await relay2.enqueue({ handle: "B", sendCredential: second.grant.sendCredential, message: sealed(RECIPIENT_DID) })).ok).toBe(true)
    expect((await relay2.pull("B", second.grant.inboxAuth)).ok).toBe(true)
  })
})
