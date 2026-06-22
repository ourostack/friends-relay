// store/postgres/credentials — the durable Postgres CredentialStore adapter. Pure
// persistence of handle → current (inboxAuth, sendCredential) pair against the
// Unit-0 `credentials` table; the rotation revoke-then-mint SEQUENCING lives in
// CredentialManager.
//
// `setCurrent` is `ON CONFLICT (handle) DO UPDATE`: replacing a handle's row
// atomically supersedes its prior pair, and because of the UNIQUE reverse indexes on
// `inbox_auth` + `send_credential`, the old tokens immediately stop resolving via the
// reverse lookups (their row no longer exists).
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
      [handle, pair.inboxAuth, pair.sendCredential],
    )
  }

  async getCurrent(handle: string): Promise<CredentialPair | undefined> {
    const res = await this.pool.query(`select inbox_auth, send_credential from credentials where handle = $1`, [handle])
    const row = res.rows[0] as { inbox_auth: string; send_credential: string } | undefined
    return row ? { inboxAuth: row.inbox_auth, sendCredential: row.send_credential } : undefined
  }

  async deleteFor(handle: string, pair: CredentialPair): Promise<void> {
    // Delete only if the handle's row still carries THIS pair (revoke). A stale pair
    // or an absent handle matches no row, so this is a safe no-op in those cases.
    await this.pool.query(
      `delete from credentials where handle = $1 and inbox_auth = $2 and send_credential = $3`,
      [handle, pair.inboxAuth, pair.sendCredential],
    )
  }

  async handleForInboxAuth(inboxAuth: string): Promise<string | null> {
    const res = await this.pool.query(`select handle from credentials where inbox_auth = $1`, [inboxAuth])
    const row = res.rows[0] as { handle: string } | undefined
    return row ? row.handle : null
  }

  async handleForSendCredential(sendCredential: string): Promise<string | null> {
    const res = await this.pool.query(`select handle from credentials where send_credential = $1`, [sendCredential])
    const row = res.rows[0] as { handle: string } | undefined
    return row ? row.handle : null
  }
}
