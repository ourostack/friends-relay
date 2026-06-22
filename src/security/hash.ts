// security/hash — at-rest hashing for the high-entropy bearer secrets the relay
// persists (invite tokens, inboxAuth + sendCredential). These are RANDOM, high-entropy
// secrets minted by `security/tokens` (32 bytes of CSPRNG, hex) — NOT low-entropy
// human passwords — so a single fast cryptographic hash (SHA-256) is the correct
// at-rest protection: it makes the stored value non-reversible (a DB/backup/replica
// leak yields only digests, never usable bearer tokens) while every access path stays
// an exact-match equality lookup (hash the presented value, compare digests). A slow
// password KDF (bcrypt/scrypt/argon2) would add no security here — there is no
// brute-forceable keyspace to slow down — and would make every auth check expensive.
import { createHash } from "node:crypto"

/** SHA-256 of `value`, hex-encoded. Deterministic: the same input always yields the
 * same digest, so an exact-match lookup hashes the presented secret and compares. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
