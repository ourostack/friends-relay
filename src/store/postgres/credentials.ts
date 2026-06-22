// store/postgres/credentials — the durable Postgres CredentialStore adapter. Pure
// persistence of handle → current (inboxAuth, sendCredential) pair against the
// Unit-0 `credentials` table; the rotation revoke-then-mint SEQUENCING lives in
// CredentialManager.
//
// `setCurrent` is `ON CONFLICT (handle) DO UPDATE`: replacing a handle's row
// atomically supersedes its prior pair, and because of the UNIQUE reverse indexes on
// `inbox_auth` + `send_credential`, the old tokens immediately stop resolving via the
// reverse lookups (their row no longer exists).
//
// AT REST (RF3): inboxAuth + sendCredential are high-entropy bearer secrets, so the
// `inbox_auth` + `send_credential` columns hold their SHA-256 DIGESTS, never the
// plaintext — a DB/backup/replica leak yields no usable bearer. The boundary is
// uniform: `setCurrent` + the reverse lookups hash the presented plaintext;
// `getCurrent` returns the stored DIGESTS (the columns already hold digests); its only
// consumer is the rotation revoke path, which feeds the result straight to `deleteFor`,
// so `deleteFor` matches its input AS-GIVEN (already digests) and does NOT re-hash.
import { sha256Hex } from "../../security/hash"
import type { CredentialPair, CredentialStore } from "../interfaces"
import type { PgPool } from "./schema"

export class PgCredentialStore implements CredentialStore {
  constructor(private readonly pool: PgPool) {}

  async setCurrent(handle: string, pair: CredentialPair): Promise<void> {
    await this.pool.query(
      `insert into credentials (handle, inbox_auth, send_credential) values ($1, $2, $3)
       on conflict (handle) do update set
         inbox_auth = excluded.inbox_auth,
         send_credential = excluded.send_credential`,
      [handle, sha256Hex(pair.inboxAuth), sha256Hex(pair.sendCredential)],
    )
  }

  async getCurrent(handle: string): Promise<CredentialPair | undefined> {
    // Returns the stored DIGEST pair (the columns hold SHA-256 digests). The rotation
    // revoke path feeds this straight to `deleteFor` (stored-form in, stored-form out).
    const res = await this.pool.query(`select inbox_auth, send_credential from credentials where handle = $1`, [handle])
    const row = res.rows[0] as { inbox_auth: string; send_credential: string } | undefined
    return row ? { inboxAuth: row.inbox_auth, sendCredential: row.send_credential } : undefined
  }

  async deleteFor(handle: string, pair: CredentialPair): Promise<void> {
    // `pair` is already in stored (digest) form — the production caller passes the
    // result of `getCurrent`. Delete only if the handle's row still carries THIS pair
    // (revoke). A stale pair or an absent handle matches no row → a safe no-op.
    await this.pool.query(
      `delete from credentials where handle = $1 and inbox_auth = $2 and send_credential = $3`,
      [handle, pair.inboxAuth, pair.sendCredential],
    )
  }

  async handleForInboxAuth(inboxAuth: string): Promise<string | null> {
    const res = await this.pool.query(`select handle from credentials where inbox_auth = $1`, [sha256Hex(inboxAuth)])
    const row = res.rows[0] as { handle: string } | undefined
    return row ? row.handle : null
  }

  async handleForSendCredential(sendCredential: string): Promise<string | null> {
    const res = await this.pool.query(`select handle from credentials where send_credential = $1`, [sha256Hex(sendCredential)])
    const row = res.rows[0] as { handle: string } | undefined
    return row ? row.handle : null
  }
}
