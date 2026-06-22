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
 * tests pass a pg-mem pool (fully hermetic); the default builds a real `pg` Pool. */
export type PoolFactory = (databaseUrl: string) => PgPool

/** The production pool factory: a real `pg` Pool over the connection string. `pg`
 * connects LAZILY (on first query), so constructing the pool opens no socket; the
 * actual connect happens when `migrate` first queries. */
export function defaultPoolFactory(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl }) as unknown as PgPool
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
 * result into `assembleRelay`. */
export async function assemblePostgresStores(
  databaseUrl: string,
  bounds: InboxBounds,
  poolFactory: PoolFactory = defaultPoolFactory,
): Promise<PostgresStores> {
  const pool = poolFactory(databaseUrl)
  await migrate(pool)
  return buildPostgresStores(pool, bounds)
}
