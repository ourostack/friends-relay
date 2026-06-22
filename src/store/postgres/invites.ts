// store/postgres/invites — the durable Postgres InviteStore adapter. Pure
// persistence of token → remaining-use counters against the Unit-0 `invites` table;
// the single-use / cap ENFORCEMENT lives in InviteManager.
//
// AT REST (RF3): the invite token is a high-entropy bearer secret, so the `token`
// column holds its SHA-256 DIGEST, never the plaintext — a DB/backup/replica leak
// yields no usable invite. Every method hashes the presented token, so the primary-key
// equality lookup is transparent.
import { sha256Hex } from "../../security/hash"
import type { InviteStore } from "../interfaces"
import type { PgPool } from "./schema"

export class PgInviteStore implements InviteStore {
  constructor(private readonly pool: PgPool) {}

  async setRemaining(token: string, remaining: number): Promise<void> {
    await this.pool.query(
      `insert into invites (token, remaining) values ($1, $2)
       on conflict (token) do update set remaining = excluded.remaining`,
      [sha256Hex(token), remaining],
    )
  }

  async getRemaining(token: string): Promise<number | undefined> {
    const res = await this.pool.query(`select remaining from invites where token = $1`, [sha256Hex(token)])
    const row = res.rows[0] as { remaining: number } | undefined
    return row ? Number(row.remaining) : undefined
  }

  async decrementOrDelete(token: string): Promise<boolean> {
    // Atomic decrement guarded by `remaining >= 1`. NOTE: the arithmetic MUST be
    // spaced (`remaining - 1`) — pg-mem's parser rejects the unspaced `remaining-1`
    // (it reads `-1` as a negative int literal). Real Postgres accepts both; we use
    // the spaced form so the hermetic suite passes too.
    const key = sha256Hex(token)
    const res = await this.pool.query(
      `update invites set remaining = remaining - 1 where token = $1 and remaining >= 1 returning remaining`,
      [key],
    )
    if (res.rows.length === 0) {
      // Unknown or exhausted (no row with remaining >= 1).
      return false
    }
    const remaining = Number((res.rows[0] as { remaining: number }).remaining)
    if (remaining === 0) {
      await this.pool.query(`delete from invites where token = $1`, [key])
    }
    return true
  }
}
