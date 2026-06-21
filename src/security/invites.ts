// security/invites — invite-gated registration: closed membership by default, NO
// open signup. An invite token is minted by an admin-credential-gated path and
// consumed once at registration. Single-use by default; a token may be minted with a
// use cap (e.g. handing one invite to a small fleet). Open registration is a
// per-deployment POLICY override (config), never the default.
import type { TokenSource } from "./tokens"

interface InviteRecord {
  /** Remaining uses (single-use → 1). Decremented on consume; 0 ⇒ exhausted. */
  remaining: number
}

/** Manages invite issuance + single-use/capped consumption. */
export class InviteManager {
  private readonly invites = new Map<string, InviteRecord>()

  constructor(private readonly tokens: TokenSource) {}

  /** Issue an invite with `uses` permitted registrations (default 1, single-use).
   * Returns the token. Throws on a non-positive cap (a guard against a useless
   * invite). */
  issue(uses = 1): string {
    if (uses < 1) {
      throw new Error("invite: uses must be >= 1")
    }
    const token = this.tokens.mint()
    this.invites.set(token, { remaining: uses })
    return token
  }

  /** Consume one use of `token`. Returns true if it was valid + had a use left
   * (and decrements it); false if unknown or exhausted. A reused single-use token
   * fails here — closed-membership enforcement. */
  consume(token: string): boolean {
    const rec = this.invites.get(token)
    if (!rec || rec.remaining < 1) return false
    rec.remaining -= 1
    if (rec.remaining === 0) {
      this.invites.delete(token)
    }
    return true
  }
}
