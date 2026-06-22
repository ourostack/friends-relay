#!/usr/bin/env node
// bin — the thin shebang entrypoint. ALL logic lives in config/bootstrap/server
// (covered); this file is only the process.* wiring (bind, listen, log to stderr),
// excluded from the coverage gate exactly like friends excludes src/mcp/bin.ts.
import { loadConfig } from "./config"
import { assemblePostgresStores, assembleRelay } from "./server/bootstrap"
import { createServer } from "./server/http"

/* eslint-disable no-console -- the bin shim is the ONE place a process-level
   message to stderr is appropriate (startup/bind). It logs NO payload — only the
   bound address. @preserve */
// Startup is wrapped in an async IIFE: the Postgres backend path (selected by
// RELAY_STORE=postgres) connects a pool + runs the idempotent schema migration,
// both async. The in-memory default path stays synchronous.
void (async () => {
  const config = loadConfig()
  // When postgres is selected, build the durable stores (connect the pool + migrate)
  // and pass them as overrides; otherwise assembleRelay uses the in-memory default.
  const relay =
    config.store === "postgres"
      ? assembleRelay(config, await assemblePostgresStores(config.databaseUrl as string, config.inboxBounds))
      : assembleRelay(config)
  const server = createServer(config, relay)

  server.listen(config.bindPort, config.bindHost, () => {
    console.error(`friends-relay listening on ${config.bindHost}:${config.bindPort}`)
  })
})()
/* eslint-enable no-console */
