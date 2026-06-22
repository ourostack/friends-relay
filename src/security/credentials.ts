// security/credentials — the two credential families the relay mints at
// registration:
//
//   1. inboxAuth  — a bearer a registrant presents to DRAIN its own handle's queue
//                   (the pull/ack auth). Gates WHO can read a handle's inbox; it
//                   does NOT gate confidentiality (that's E2E, client-side).
//   2. sendCredential — what other agents present to POST to a handle. ROTATING by
//                   default: a fresh credential per registration, so the relay can't
//                   build one sender's full out-graph from one stable credential. The
//                   send credential is the rate-limit SUBJECT.
//
// Both are opaque random strings (security/tokens). Re-registration ROTATES both,
// invalidating the prior pair.
//
// This is the LOGIC layer over a CredentialStore (pure persistence). The manager owns
// the rotation revoke-then-mint sequencing + the canSendTo binding check; the store
// owns the durable bindings + reverse lookups.
import type { CredentialPair, CredentialStore } from "../store/interfaces"
import type { TokenSource } from "./tokens"

/** Manages credential → handle bindings for inbox-drain and send auth, over a
 * CredentialStore. */
export class CredentialManager {
  constructor(
    private readonly tokens: TokenSource,
    private readonly store: CredentialStore,
  ) {}

  /** Mint (or ROTATE) the credential pair for `handle`. A prior pair for the same
   * handle is revoked first. Returns the fresh pair. */
  async rotate(handle: string): Promise<CredentialPair> {
    const prev = await this.store.getCurrent(handle)
    if (prev) {
      await this.store.deleteFor(handle, prev)
    }
    const inboxAuth = this.tokens.mint()
    const sendCredential = this.tokens.mint()
    const pair: CredentialPair = { inboxAuth, sendCredential }
    await this.store.setCurrent(handle, pair)
    return pair
  }

  /** Revoke a handle's credentials entirely (deregistration). No-op if absent. */
  async revoke(handle: string): Promise<void> {
    const prev = await this.store.getCurrent(handle)
    if (prev) {
      await this.store.deleteFor(handle, prev)
    }
  }

  /** Resolve an inboxAuth bearer to the handle it may drain, or null. */
  async handleForInboxAuth(token: string): Promise<string | null> {
    return this.store.handleForInboxAuth(token)
  }

  /** Validate that `sendCredential` may post to `handle`. A send credential is
   * bound to ONE recipient handle (it does not grant posting to arbitrary handles). */
  async canSendTo(sendCredential: string, handle: string): Promise<boolean> {
    return (await this.store.handleForSendCredential(sendCredential)) === handle
  }

  /** Resolve a send credential to the handle it may post to (for rate-limit keying
   * + metrics), or null. */
  async handleForSendCredential(sendCredential: string): Promise<string | null> {
    return this.store.handleForSendCredential(sendCredential)
  }
}
