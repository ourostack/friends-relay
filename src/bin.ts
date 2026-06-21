#!/usr/bin/env node
// bin — the thin shebang entrypoint. ALL logic lives in config/bootstrap/server
// (covered); this file is only the process.* wiring (bind, listen, log to stderr),
// excluded from the coverage gate exactly like friends excludes src/mcp/bin.ts.
import { loadConfig } from "./config"
import { assembleRelay } from "./server/bootstrap"
import { createServer } from "./server/http"

/* eslint-disable no-console -- the bin shim is the ONE place a process-level
   message to stderr is appropriate (startup/bind). It logs NO payload — only the
   bound address. @preserve */
const config = loadConfig()
const relay = assembleRelay(config)
const server = createServer(config, relay)

server.listen(config.bindPort, config.bindHost, () => {
  console.error(`friends-relay listening on ${config.bindHost}:${config.bindPort}`)
})
/* eslint-enable no-console */
