// server/bootstrap — assemble a Relay from config + the reference backends. The
// production backends are swapped in HERE (the only place that picks concrete
// adapters); the relay core never names one. This keeps the wiring in one testable
// function, away from the process.* shim in bin.ts.
import { systemClock } from "../clock"
import type { Clock } from "../clock"
import type { RelayConfig } from "../config"
import { silentLogger } from "../logger"
import type { Logger } from "../logger"
import { Relay } from "../relay"
import { cryptoTokenSource } from "../security/tokens"
import type { TokenSource } from "../security/tokens"
import {
  MemoryCredentialStore,
  MemoryInboxStore,
  MemoryInviteStore,
  MemoryRegistryStore,
} from "../store/memory"
import type { InboxBounds } from "../store/memory"
import type { CredentialStore, InboxStore, InviteStore, RegistryStore } from "../store/interfaces"
import { Pool } from "pg"
import { PgCredentialStore } from "../store/postgres/credentials"
import { PgInboxStore } from "../store/postgres/inbox"
import { PgInviteStore } from "../store/postgres/invites"
import { PgRegistryStore } from "../store/postgres/registry"
import { migrate } from "../store/postgres/schema"
import type { PgPool } from "../store/postgres/schema"

/** Optional overrides for assembly (tests inject a manual clock / capturing logger /
 * deterministic token source / a durable backend). Anything omitted defaults to the
 * production reference. */
export interface AssembleOverrides {
  inbox?: InboxStore
  registry?: RegistryStore
  invites?: InviteStore
  credentials?: CredentialStore
  tokens?: TokenSource
  clock?: Clock
  logger?: Logger
}

/** Build a Relay from config. The in-memory backends are the v1 reference; a
 * deployment passes durable adapters via `overrides`. `assembleRelay` stays SYNC and
 * store-agnostic: when `config.store === "postgres"` the caller (bin.ts) builds the
 * durable stores via `assemblePostgresStores` (async — it connects + migrates) and
 * passes them here as overrides. */
export function assembleRelay(config: RelayConfig, overrides: AssembleOverrides = {}): Relay {
  const inbox = overrides.inbox ?? new MemoryInboxStore(config.inboxBounds)
  const registry = overrides.registry ?? new MemoryRegistryStore()
  const invites = overrides.invites ?? new MemoryInviteStore()
  const credentials = overrides.credentials ?? new MemoryCredentialStore()
  const tokens = overrides.tokens ?? cryptoTokenSource
  const clock = overrides.clock ?? systemClock
  const logger = overrides.logger ?? silentLogger
  return new Relay({ config, inbox, registry, invites, credentials, tokens, clock, logger })
}

/** The four durable stores the Postgres backend provides. */
export interface PostgresStores {
  inbox: InboxStore
  registry: RegistryStore
  invites: InviteStore
  credentials: CredentialStore
}

/** A factory that builds a pg-compatible pool from a connection string. Injectable so
 * tests pass a pg-mem pool (fully hermetic); the default builds a real `pg` Pool. The
 * optional `logger` is used by the default factory for the pool's `'error'` listener
 * (a static event only); injected test factories ignore it. */
export type PoolFactory = (databaseUrl: string, logger?: Logger) => PgPool

/** The production pool factory: a real `pg` Pool over the connection string. `pg`
 * connects LAZILY (on first query), so constructing the pool opens no socket; the
 * actual connect happens when `migrate` first queries.
 *
 * It attaches an `'error'` listener: `pg-pool` emits `'error'` on an IDLE-client
 * backend failure (a DB failover / restart / network blip on a pooled connection that
 * is not currently executing a query). With NO listener, node's EventEmitter THROWS on
 * `emit('error', …)` → the process crashes. The listener logs a STATIC event name only
 * (`pg_pool_error`) — it deliberately does NOT pass the error (or the connection
 * string) into the log, so nothing that could carry the connection string / content
 * can leak. */
export function defaultPoolFactory(databaseUrl: string, logger: Logger = silentLogger): PgPool {
  const pool = new Pool({ connectionString: databaseUrl })
  pool.on("error", () => {
    logger.log("error", "pg_pool_error")
  })
  return pool as unknown as PgPool
}

/** Construct the four Pg adapters around an ALREADY-CONNECTED, ALREADY-MIGRATED pool.
 * Pure + synchronous — it does NOT create the pool or run the migration (that is
 * `assemblePostgresStores`'s job). The inbox adapter is bounded by `bounds`
 * (config.inboxBounds), exactly like the in-memory inbox. */
export function buildPostgresStores(pool: PgPool, bounds: InboxBounds): PostgresStores {
  return {
    inbox: new PgInboxStore(pool, bounds),
    registry: new PgRegistryStore(pool),
    invites: new PgInviteStore(pool),
    credentials: new PgCredentialStore(pool),
  }
}

/** Create the Postgres pool (via `poolFactory`), run the idempotent schema
 * migration, and return the four durable stores. This is the async pool/migrate work
 * that `assembleRelay` deliberately stays out of; `bin.ts` calls this then passes the
 * result into `assembleRelay`. `logger` is forwarded to the pool factory so the default
 * factory's `'error'` listener can log a static event (it defaults to `silentLogger`). */
export async function assemblePostgresStores(
  databaseUrl: string,
  bounds: InboxBounds,
  poolFactory: PoolFactory = defaultPoolFactory,
  logger: Logger = silentLogger,
): Promise<PostgresStores> {
  const pool = poolFactory(databaseUrl, logger)
  await migrate(pool)
  return buildPostgresStores(pool, bounds)
}
