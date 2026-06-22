// security/invites — invite-gated registration: closed membership by default, NO
// open signup. An invite token is minted by an admin-credential-gated path and
// consumed once at registration. Single-use by default; a token may be minted with a
// use cap (e.g. handing one invite to a small fleet). Open registration is a
// per-deployment POLICY override (config), never the default.
//
// This is the LOGIC layer over an InviteStore (pure persistence). The manager owns
// the use-cap guard + the issuance/consumption policy; the store owns the durable
// counter + the atomic decrement-or-delete.
import type { InviteStore } from "../store/interfaces"
import type { TokenSource } from "./tokens"

/** Manages invite issuance + single-use/capped consumption over an InviteStore. */
export class InviteManager {
  constructor(
    private readonly tokens: TokenSource,
    private readonly store: InviteStore,
  ) {}

  /** Issue an invite with `uses` permitted registrations (default 1, single-use).
   * Returns the token. Throws on a non-positive cap (a guard against a useless
   * invite). */
  async issue(uses = 1): Promise<string> {
    if (uses < 1) {
      throw new Error("invite: uses must be >= 1")
    }
    const token = this.tokens.mint()
    await this.store.setRemaining(token, uses)
    return token
  }

  /** Consume one use of `token`. Returns true if it was valid + had a use left
   * (and decrements it); false if unknown or exhausted. A reused single-use token
   * fails here — closed-membership enforcement. The atomic decrement is the store's. */
  async consume(token: string): Promise<boolean> {
    return this.store.decrementOrDelete(token)
  }
}
