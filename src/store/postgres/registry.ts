// store/postgres/registry — the durable Postgres RegistryStore adapter. It
// reproduces MemoryRegistryStore's directory semantics EXACTLY against the Unit-0
// `registrations` table.
//
// The subtle part is `getByDid`: the memory store's byDid index points at the MOST
// RECENTLY `put` registration for a DID (last-writer-wins), and `remove` only clears
// the DID index if it still points at the removed handle. We reproduce both WITHOUT
// a stored reverse index by computing getByDid by RECENCY (`order by registered_at
// desc, handle desc limit 1`). Then:
//   - re-registration with a NEW did "clears the stale index" for free: the handle's
//     row now carries the new DID, and no other handle holds the old one, so
//     getByDid(oldDid) finds nothing.
//   - remove "doesn't clobber a re-pointed shared DID" for free: there is no index to
//     clobber — getByDid is recomputed each call, so removing h1 still resolves a
//     shared DID to the surviving h2.
// `did` is therefore a PLAIN (non-unique) column so multiple handles may carry it.
import type { RegistryStore } from "../interfaces"
import type { PgPool } from "./schema"
import type { PublicAgentCard, Registration } from "../../types"

/** A row as read back from `registrations`. `agent_card` is jsonb (parsed to an
 * object by pg); `key_agreement_pubkey` is `text` (null when absent). */
interface RegistrationRow {
  handle: string
  did: string
  agent_card: PublicAgentCard
  key_agreement_pubkey: string | null
  registered_at: number | string
}

export class PgRegistryStore implements RegistryStore {
  constructor(private readonly pool: PgPool) {}

  async put(reg: Registration): Promise<void> {
    await this.pool.query(
      `insert into registrations (handle, did, agent_card, key_agreement_pubkey, registered_at)
       values ($1, $2, $3, $4, $5)
       on conflict (handle) do update set
         did = excluded.did,
         agent_card = excluded.agent_card,
         key_agreement_pubkey = excluded.key_agreement_pubkey,
         registered_at = excluded.registered_at`,
      [reg.handle, reg.did, JSON.stringify(reg.agentCard), reg.keyAgreementPubKey ?? null, reg.registeredAt],
    )
  }

  async getByHandle(handle: string): Promise<Registration | undefined> {
    const res = await this.pool.query(`select * from registrations where handle = $1`, [handle])
    const row = res.rows[0] as RegistrationRow | undefined
    return row ? rowToRegistration(row) : undefined
  }

  async getByDid(did: string): Promise<Registration | undefined> {
    // Last-writer-wins: the most recently registered handle for this DID (recency,
    // not a stored index) — reproduces the memory store's byDid semantics.
    const res = await this.pool.query(
      `select * from registrations where did = $1 order by registered_at desc, handle desc limit 1`,
      [did],
    )
    const row = res.rows[0] as RegistrationRow | undefined
    return row ? rowToRegistration(row) : undefined
  }

  async remove(handle: string): Promise<boolean> {
    const res = await this.pool.query(`delete from registrations where handle = $1 returning handle`, [handle])
    return res.rows.length > 0
  }
}

/** Map a raw `registrations` row to a Registration. A null `key_agreement_pubkey`
 * becomes `keyAgreementPubKey: undefined` (present-but-undefined, mirroring the
 * memory store's optional field). */
function rowToRegistration(row: RegistrationRow): Registration {
  return {
    handle: row.handle,
    did: row.did,
    agentCard: row.agent_card,
    keyAgreementPubKey: row.key_agreement_pubkey ?? undefined,
    registeredAt: Number(row.registered_at),
  }
}
