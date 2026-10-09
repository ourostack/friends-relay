// store/postgres/handle-lock — the per-handle advisory lock shared by every operation
// that must not interleave on one handle: inbox enqueue/purge and the registration
// lifecycle (register / deregister). Held for the rest of the current transaction.
import type { PgPoolClient } from "./schema"

/** Class id of the two-key advisory lock (ASCII "RELY"), so this relay's locks cannot
 * collide with another application's advisory locks in the same database. */
export const ADVISORY_LOCK_CLASS_ID = 1380272473

/** How long an operation waits for the per-handle lock before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000

/** Take the per-handle lock for the rest of the current transaction, waiting at most
 * `timeoutMs`. */
export async function lockHandle(client: PgPoolClient, handle: string, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<void> {
  // An integer literal: SET LOCAL takes no parameters.
  await client.query(`set local lock_timeout = ${Math.trunc(timeoutMs)}`)
  await client.query(`select pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS_ID}, hashtext($1))`, [handle])
}
