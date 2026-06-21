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
import { MemoryInboxStore, MemoryRegistryStore } from "../store/memory"
import type { InboxStore, RegistryStore } from "../store/interfaces"

/** Optional overrides for assembly (tests inject a manual clock / capturing logger /
 * deterministic token source / a durable backend). Anything omitted defaults to the
 * production reference. */
export interface AssembleOverrides {
  inbox?: InboxStore
  registry?: RegistryStore
  tokens?: TokenSource
  clock?: Clock
  logger?: Logger
}

/** Build a Relay from config. The in-memory backends are the v1 reference; a
 * deployment passes durable adapters via `overrides`. */
export function assembleRelay(config: RelayConfig, overrides: AssembleOverrides = {}): Relay {
  const inbox = overrides.inbox ?? new MemoryInboxStore(config.inboxBounds)
  const registry = overrides.registry ?? new MemoryRegistryStore()
  const tokens = overrides.tokens ?? cryptoTokenSource
  const clock = overrides.clock ?? systemClock
  const logger = overrides.logger ?? silentLogger
  return new Relay({ config, inbox, registry, tokens, clock, logger })
}
