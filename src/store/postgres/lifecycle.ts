// store/postgres/lifecycle — atomic register / deregister of a handle. Each runs in ONE
// transaction holding the handle's advisory lock (the same lock inbox enqueue takes),
// so a deregistration removes the registration, credentials and queued mail together or
// not at all (a failure rolls everything back and the call can simply be retried), and
// a send can never interleave with it.
import type { HandleLifecycleStore } from "../interfaces"
import type { Registration } from "../../types"
import { lockHandle } from "./handle-lock"
import { UPSERT_REGISTRATION_SQL, registrationParams } from "./registry"
import { HandleBusyError } from "./schema"
import type { PgPool, PgPoolClient } from "./schema"

/** SQLSTATE `lock_not_available`: lock_timeout expired while waiting for the handle lock. */
const LOCK_NOT_AVAILABLE = "55P03"

export class PgHandleLifecycleStore implements HandleLifecycleStore {
  constructor(
    private readonly pool: PgPool,
    private readonly options: { lockTimeoutMs?: number } = {},
  ) {}

  async register(reg: Registration): Promise<boolean> {
    return this.inLockedTxn(reg.handle, async (client) => {
      const existing = await client.query(`select 1 from registrations where handle = $1`, [reg.handle])
      await client.query(UPSERT_REGISTRATION_SQL, registrationParams(reg))
      const created = existing.rows.length === 0
      if (created) {
        // A brand-new registration starts with an empty inbox: drop any rows an earlier
        // owner left behind (e.g. a failed cleanup).
        await client.query(`delete from inbox where handle = $1`, [reg.handle])
      }
      return created
    })
  }

  async deregister(handle: string): Promise<boolean> {
    return this.inLockedTxn(handle, async (client) => {
      await client.query(`delete from credentials where handle = $1`, [handle])
      const removed = await client.query(`delete from registrations where handle = $1 returning handle`, [handle])
      await client.query(`delete from inbox where handle = $1`, [handle])
      return removed.rows.length > 0
    })
  }

  /** BEGIN → handle lock → `work` → COMMIT; any error rolls the whole thing back. */
  private async inLockedTxn<T>(handle: string, work: (client: PgPoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(`begin`)
      await lockHandle(client, handle, this.options.lockTimeoutMs)
      const result = await work(client)
      await client.query(`commit`)
      return result
    } catch (err) {
      try {
        await client.query(`rollback`)
      } catch {
        /* the original error is what matters */
      }
      throw (err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE ? new HandleBusyError() : err
    } finally {
      client.release()
    }
  }
}
