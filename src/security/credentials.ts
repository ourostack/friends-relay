// security/credentials — the two credential families the relay mints at
// registration:
//
//   1. inboxAuth  — a bearer a registrant presents to DRAIN its own handle's queue
//                   (the pull/ack auth). Gates WHO can read a handle's inbox; it
//                   does NOT gate confidentiality (that's E2E, client-side).
//   2. sendCredential — what other agents present to POST to a handle. ROTATING by
//                   default (fork 12): a fresh credential per registration, so the
//                   relay can't build one sender's full out-graph from one stable
//                   credential. The send credential is the rate-limit SUBJECT.
//
// Both are opaque random strings (security/tokens). Re-registration ROTATES both,
// invalidating the prior pair.
import type { TokenSource } from "./tokens"

/** Tracks credential → handle bindings for inbox-drain and send auth. */
export class CredentialManager {
  /** inboxAuth bearer → the handle it may drain. */
  private readonly inboxAuthToHandle = new Map<string, string>()
  /** sendCredential → the handle it may post to. */
  private readonly sendCredToHandle = new Map<string, string>()
  /** handle → its current (inboxAuth, sendCredential), so rotation can revoke the old. */
  private readonly current = new Map<string, { inboxAuth: string; sendCredential: string }>()

  constructor(private readonly tokens: TokenSource) {}

  /** Mint (or ROTATE) the credential pair for `handle`. A prior pair for the same
   * handle is revoked. Returns the fresh pair. */
  rotate(handle: string): { inboxAuth: string; sendCredential: string } {
    const prev = this.current.get(handle)
    if (prev) {
      this.inboxAuthToHandle.delete(prev.inboxAuth)
      this.sendCredToHandle.delete(prev.sendCredential)
    }
    const inboxAuth = this.tokens.mint()
    const sendCredential = this.tokens.mint()
    this.inboxAuthToHandle.set(inboxAuth, handle)
    this.sendCredToHandle.set(sendCredential, handle)
    this.current.set(handle, { inboxAuth, sendCredential })
    return { inboxAuth, sendCredential }
  }

  /** Revoke a handle's credentials entirely (deregistration). No-op if absent. */
  revoke(handle: string): void {
    const prev = this.current.get(handle)
    if (!prev) return
    this.inboxAuthToHandle.delete(prev.inboxAuth)
    this.sendCredToHandle.delete(prev.sendCredential)
    this.current.delete(handle)
  }

  /** Resolve an inboxAuth bearer to the handle it may drain, or null. */
  handleForInboxAuth(token: string): string | null {
    return this.inboxAuthToHandle.get(token) ?? null
  }

  /** Validate that `sendCredential` may post to `handle`. A send credential is
   * bound to ONE recipient handle (it does not grant posting to arbitrary handles). */
  canSendTo(sendCredential: string, handle: string): boolean {
    return this.sendCredToHandle.get(sendCredential) === handle
  }

  /** Resolve a send credential to the handle it may post to (for rate-limit keying
   * + metrics), or null. */
  handleForSendCredential(sendCredential: string): string | null {
    return this.sendCredToHandle.get(sendCredential) ?? null
  }
}
