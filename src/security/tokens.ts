// security/tokens — the opaque-secret generator. Invite tokens, send credentials,
// and inbox-auth bearers are all high-entropy random strings minted here. The
// random source is INJECTABLE so tests are deterministic; the default is
// node:crypto's CSPRNG.
import { randomBytes } from "node:crypto"

/** A source of cryptographically-random hex tokens. Injectable for tests. */
export interface TokenSource {
  /** Mint a fresh opaque token (URL-safe hex). */
  mint(): string
}

/** The production token source — node:crypto CSPRNG, 32 bytes hex. */
export const cryptoTokenSource: TokenSource = {
  mint: () => randomBytes(32).toString("hex"),
}

/** A deterministic token source for tests: emits `${prefix}-${n}`. */
export class SequenceTokenSource implements TokenSource {
  private n = 0

  constructor(private readonly prefix = "tok") {}

  mint(): string {
    this.n += 1
    return `${this.prefix}-${this.n}`
  }
}
