# Doing: Persistent storage backend for friends-relay (Postgres)

**Status**: drafting
**Execution Mode**: direct
**Created**: 2026-06-22 08:14
**Planning**: ./2026-06-22-0814-planning-persistent-storage.md
**Artifacts**: ./2026-06-22-0814-doing-persistent-storage/

## Execution Mode

- **pending**: Awaiting user approval before each unit starts (interactive)
- **spawn**: Spawn sub-agent for each unit (parallel/autonomous)
- **direct**: Execute units sequentially in current session (default)

Chosen: **direct**. The units form one tight dependency chain (the async-seam conversion underpins everything, then the adapters, then wiring, then parity/restart, then docs) and share a single coverage gate — sequential in one session is correct.

## Objective
The relay is deployed (`ouro-prod-friends-relay`, Azure Container Apps) on **in-memory storage (v1)** — a restart drops every registration, queued (sealed) inbox message, invite, and credential binding. Add a **durable Postgres backend behind the storage seam** so the relay survives restarts, **without weakening the content-blind invariant** and **without disturbing the hermetic 100%-coverage test suite** (in-memory stays the default/test backend; Postgres is selected only by env).

## Resolved design decisions (baked in from planning approval)
1. **Backend = Postgres** (Azure Database for PostgreSQL flexible server, burstable B1ms), driven by the **pure-JS `pg` driver** (`pg@8`). NOT SQLite-on-volume: an Azure Files mount is an SMB share where SQLite locking is unreliable / WAL unsupported, and a rolling deploy can momentarily run two writers — unacceptable corruption risk. `pg` is pure JS → **no native toolchain, no Dockerfile builder change**. Postgres is replica-count-agnostic.
2. **Seam shape = two new interfaces** `InviteStore` + `CredentialStore`, mirroring `InboxStore`/`RegistryStore`. Extract the managers' private-`Map` state behind these seams (logic-over-store; in-memory impls remain the default + test backend).
3. **Rate-limiter buckets are NOT persisted** — ephemeral by design; a restart safely loosens the window, never corrupts. `RateLimiter` stays in-memory and unchanged.
4. **Replica count is moot** under Postgres (no single-writer constraint). No change.
5. **Pure-JS `pg`** (follows from #1). Dev-only hermetic fake = **`pg-mem`** (in-process Postgres; `pg@8` 8.22.0 + `pg-mem` 3.0.14 both resolve, no native deps).

## THE CENTRAL ARCHITECTURAL FACT (validated against HEAD — read this before any unit)
The relay's **entire server side is synchronous today.** Verified by reading `relay.ts`, `store/{interfaces,memory}.ts`, `security/{invites,credentials,rate-limit,tokens}.ts`, `config.ts`, `server/{bootstrap,http}.ts`, `bin.ts`, and grepping all of `src/`: the only `async`/`Promise`/`await` in `src/` lives in `client/index.ts` (the `fetch` wrapper, already async — **unaffected**) and in test harnesses that already drive a real socket via `fetch`.

`pg` is **necessarily async** (`pool.query()` returns a `Promise`). Therefore the Postgres inbox/registry/invite/credential adapters cannot satisfy the current **synchronous** `InboxStore`/`RegistryStore` (and the new invite/credential) method signatures. **The storage seam must become async**, which cascades:

- `InboxStore` / `RegistryStore` / new `InviteStore` / `CredentialStore` methods → return `Promise<…>`.
- `MemoryInboxStore` / `MemoryRegistryStore` / new in-memory invite+credential stores → become `async` (trivial — bodies unchanged, just `async`).
- The security **managers** (`InviteManager`, `CredentialManager`) → become logic-over-store and their methods become `async` (they now `await` their store).
- `Relay` methods that touch a store — `register`, `deregister`, `enqueue`, `pull`, `ack`, `lookupByHandle`, `lookupByDid`, `sweepExpired`, `ownsInbox`, `issueInvite` — become `async`/return `Promise`.
- `handle()` (the pure router in `server/http.ts`) → becomes `async` / returns `Promise<RelayResponse>`. `createServer` already calls it inside an async-capable `req.on("end")` callback, so it just `await`s.
- `assembleRelay` → still sync-constructs the in-memory path, but gains an **async** Postgres path (the pool connects); `bin.ts` wraps startup in an `async` IIFE (it is coverage-excluded process wiring).
- **Test harnesses**: `relay.test.ts` (`makeRelay` + every assertion), `http.test.ts` router block, `bootstrap.test.ts`, and the interop content-blind assertion (`inbox.list(...)` → `await inbox.list(...)`) all gain `await`. The socket-level tests (`http.test.ts` `createServer` block, `client.test.ts`, `interop` send/pull/ack) **already** `await fetch(...)`, so they only change where they reach a store directly.

This async conversion is **Unit 1** and is a prerequisite for every Postgres unit. It is well-defined refactoring (not a blocker), but it is a **larger blast radius than the planning doc's "additive, relay core not edited" framing implied** — flagged explicitly in the conversion report.

## Completion Criteria
- [ ] Every state family from the audit persists through the Postgres backend, or is explicitly documented as intentionally ephemeral (rate-limiter buckets — with rationale).
- [ ] In-memory backend remains the default; with no `RELAY_STORE`/`DATABASE_URL` set, behavior + the existing hermetic suite are unchanged (modulo the mechanical sync→async signature shift, which is internal).
- [ ] Postgres backend selected purely by env/config; misconfiguration fails loud at startup (consistent with `loadConfig`'s fail-loud contract).
- [ ] Content-blind invariant preserved AND proven against Postgres: the durable inbox persists only `{ recipientDid (column for routing), opaque A2AMessage blob (jsonb), queueId, enqueuedAt, expiresAt, sizeBytes }` — no plaintext, no key, no decoded `sealed.ct`, never indexed on ciphertext. A test asserts the persisted/round-tripped row contains only the opaque blob + routing DID (mirroring the interop assertion against the Postgres adapter).
- [ ] Ordered-queue + ack/delete + per-handle count/byte quota + TTL semantics of `InboxStore` reproduced exactly by the Postgres adapter (the shared `store.test.ts` behavioral contract passes against BOTH backends).
- [ ] Re-registration credential rotation + invite single-use/capped consumption survive a **simulated restart** (new store instances over the same `pg-mem` db reload state).
- [ ] 100% coverage on all new code (no `v8 ignore` on new logic except the established `bin.ts` process-wiring pattern).
- [ ] All tests pass; `npm run typecheck` + `npm run lint` clean; no warnings.
- [ ] README "Deploy" section + Dockerfile note updated with the new env var(s) (`RELAY_STORE`, `DATABASE_URL`) and the one-line infra-to-provision note.

## Code Coverage Requirements
**MANDATORY: 100% coverage on all new code.**
- No `v8 ignore` on new code. The only sanctioned exclusions remain `src/index.ts` / `src/client/index.ts` barrels + `src/bin.ts` process wiring (per `vitest.config.ts`). New pure-type interface files (`InviteStore`/`CredentialStore` types) belong with the existing `interfaces.ts` pattern; if a new types-only file is added it follows the same coverage-exclusion rationale as `interfaces.ts` (pure types) — but prefer co-locating new interfaces in `src/store/interfaces.ts` (already excluded) to avoid a new exclusion entry.
- All branches covered: quota count-vs-byte drop, TTL expiry on enqueue/list/sweep, ack hit/miss, re-registration DID-reindex (incl. the "DID re-pointed to another handle" guard), invite exhausted-vs-unknown, credential rotation revoke / revoke-absent no-op, send-cred validate hit/miss.
- All error paths tested: Postgres connect/query failure surfaced as a loud startup/throw, not a silent swallow.
- Edge cases: empty queue, unknown handle, unknown queueId, expired-on-read pruning, re-ack idempotency, DID re-point across handles, exhausted invite, rotated-away credential.

### Hermetic-coverage blocker clause (per conversion directive)
The Postgres adapter's own unit tests **MUST be hermetic** — `pg-mem` (in-process), **never** a live Azure resource in CI — AND hold the 100% gate. Keep the adapter SQL within `pg-mem`'s supported surface (it implements `DELETE … RETURNING`, indexes incl. partial, `COUNT`/`COALESCE(SUM(...))`, parameterized queries, `ON CONFLICT … DO UPDATE`). **If a specific adapter branch genuinely cannot be exercised to 100% under `pg-mem`** (e.g. it depends on a Postgres builtin `pg-mem` does not implement), that is a **real blocker to STOP and flag** during execution — do NOT paper it over with a `v8 ignore`. The mitigation order is: (1) rephrase the SQL to a `pg-mem`-supported equivalent; (2) restructure the adapter so the branch is reachable via the seam; (3) only if both fail, surface it as a blocker for the operator.

## TDD Requirements
**Strict TDD — no exceptions:**
1. **Tests first**: Write failing tests BEFORE any implementation.
2. **Verify failure**: Run tests, confirm they FAIL (red).
3. **Minimal implementation**: Write just enough code to pass.
4. **Verify pass**: Run tests, confirm they PASS (green).
5. **Refactor**: Clean up, keep tests green.
6. **No skipping**: Never write implementation without a failing test first.

Note on Unit 1 (the async refactor): it is signature-preserving in behavior, so its "test-first" step is **converting the existing suites to `await` the now-async API and confirming red** (the existing assertions ARE the spec); the implementation step makes them green again. Coverage must remain 100% throughout.

## Reference: the content-blind assertion to replicate (verbatim, from `interop-a2a-client.test.ts`)
```ts
const stored = inbox.list("B-opaque-handle", 0)          // becomes: await inbox.list(...)
expect(stored).toHaveLength(1)
const storedBytes = JSON.stringify(stored[0].message)
expect(storedBytes.includes(SUBJECT_JOIN_KEY)).toBe(false)
expect(storedBytes.includes(SECRET_NOTE)).toBe(false)
expect(storedBytes.includes("profile_share")).toBe(false)
expect(storedBytes.includes(A.did)).toBe(false)
const data = stored[0].message.parts[0].data
expect(Object.keys(data).sort()).toEqual(["recipientDid", "sealed", "v"])
expect(Object.keys(data.sealed).sort()).toEqual(["ct", "ePk", "n", "v"])
expect(data.recipientDid).toBe(B.did)
```
The Postgres parity assertion (Unit 7) must: enqueue this sealed message via the Postgres inbox adapter, read the raw persisted row, and assert (a) the stored `message` jsonb round-trips to exactly `{v, sealed:{v,ePk,n,ct}, recipientDid}` with none of the plaintext substrings present, and (b) the table indexes only on `(handle, queue_id, expires_at)` + `recipient_did`, never on the ciphertext column.

## Env vars the relay will read (for the operator to wire)
- `RELAY_STORE` — backend selector. `memory` (default, unchanged) or `postgres`. Absent/empty ⇒ `memory`.
- `DATABASE_URL` — standard Postgres connection string (`postgres://user:pass@host:5432/dbname?sslmode=require`). **Required and validated when `RELAY_STORE=postgres`**; ignored otherwise. Fail-loud at `loadConfig` if `RELAY_STORE=postgres` and `DATABASE_URL` is missing/empty.
- (Optional, decide in Unit 5) `RELAY_PG_SSL` / pool-size knobs — only if needed; default to `sslmode` in the URL + library defaults to keep the surface minimal.

## Work Units

### Legend
⬜ Not started · 🔄 In progress · ✅ Done · ❌ Blocked

**Every unit header starts with a status emoji.**

### ⬜ Unit 0: Dependencies + Postgres schema/DDL constant (Setup)
**What**: Add `pg@^8` to `dependencies` and `pg-mem@^3` + `@types/pg` to `devDependencies` via `npm install` (updates `package-lock.json`; `npm ci` in CI + Dockerfile picks it up with no Dockerfile edit). Define the canonical DDL the Postgres adapters create/expect, in one module (e.g. `src/store/postgres/schema.ts`), as exported SQL strings:
- `inbox(handle text, queue_id text primary key, message jsonb not null, enqueued_at bigint not null, expires_at bigint not null, size_bytes int not null)` + index `(handle, expires_at)`; FIFO order by a monotonic `seq bigserial` (durable, survives restart — replaces the in-memory `seq` counter) so ordering is correct across restarts. `recipient_did` is NOT stored separately in the inbox (routing match happens in `Relay.enqueue` before the store call, against `registry`); the inbox holds only the opaque message + accounting metadata. (Confirm during Unit 2 whether a `recipient_did` column is wanted for symmetry; default: NOT needed — keep the inbox blind.)
- `registrations(handle text primary key, did text not null, agent_card jsonb not null, key_agreement_pubkey text, registered_at bigint not null)` + index on `did` (the by-DID lookup); re-registration = `ON CONFLICT (handle) DO UPDATE`, with the stale-DID-index semantics handled in SQL.
- `invites(token text primary key, remaining int not null)`.
- `credentials`: a shape that supports `inboxAuth → handle`, `sendCred → handle`, `handle → current pair`, and atomic rotation/revoke (e.g. `credentials(handle text primary key, inbox_auth text not null, send_credential text not null)` + unique indexes on `inbox_auth` and `send_credential` for the reverse lookups; rotation = `ON CONFLICT (handle) DO UPDATE`, which atomically replaces the old pair so the old tokens stop resolving).
**Output**: lockfile updated; `schema.ts` with exported DDL strings + a `migrate(pool)` that runs them idempotently (`create table if not exists` / `create index if not exists`).
**Acceptance**: `npm install` clean; `npm run typecheck` resolves `pg`/`pg-mem` types; DDL strings exist and are syntactically valid Postgres (verified by `pg-mem` accepting them in Unit 2's test bootstrap). No adapter logic yet.

### ⬜ Unit 1a: Make the storage seam async — convert tests to await (RED)
**What**: Widen `InboxStore` + `RegistryStore` method signatures in `src/store/interfaces.ts` to return `Promise<…>`. Update the existing suites (`store.test.ts`, `relay.test.ts`, `http.test.ts` router block, `bootstrap.test.ts`, and the interop content-blind direct `inbox.list` call) to `await` the now-async API. Do NOT yet change the implementations.
**Acceptance**: Tests are updated to `await` and the suite **FAILS to compile / FAILS** (red) because `Memory*`/`Relay`/`handle` still return sync values — confirming the spec is captured.

### ⬜ Unit 1b: Make the storage seam async — implementation (GREEN)
**What**: Make `MemoryInboxStore`/`MemoryRegistryStore` methods `async` (bodies unchanged). Propagate `async`/`await` through `Relay` (`register`/`deregister`/`enqueue`/`pull`/`ack`/`ownsInbox`/`issueInvite`/`lookupByHandle`/`lookupByDid`/`sweepExpired`), `handle()` in `server/http.ts` (now `async`, `await relay.*`), `assembleRelay` (in-memory path stays sync-constructed; return type adjusted as needed), and `bin.ts` (wrap startup in an async IIFE — coverage-excluded). `RateLimiter`/`tokens`/`clock` stay synchronous (not store-backed).
**Acceptance**: Full suite PASSES (green) again; `typecheck` + `lint` clean; **coverage still 100%**; no behavior change observable at the socket level (the `createServer`/`client`/`interop` socket tests pass unchanged in intent).

### ⬜ Unit 1c: Async seam — coverage & refactor
**What**: Confirm no branch regressed; tidy any awkward `Promise` plumbing; ensure the `EnqueueResult`/error unions are unchanged (only the wrapping `Promise` is new).
**Acceptance**: 100% coverage on all touched files; suite green; diff is signature-only (no logic drift) for the in-memory path.

### ⬜ Unit 2a: Postgres InboxStore adapter — tests (RED)
**What**: Write hermetic `pg-mem`-backed tests for a `PgInboxStore implements InboxStore`: enqueue/list/ack/dropExpired/depth over an in-process db (created via `pg-mem`'s `newDb().adapters.createPg()` → a `pg`-compatible `Pool`). Cover every branch the memory suite covers (count quota, byte quota, expired-not-counted-on-enqueue, list prunes expired, unknown handle empty, ack hit/miss/idempotent, dropExpired across handles, FIFO order across a simulated restart via a fresh adapter over the same db).
**Acceptance**: Tests exist and FAIL (no `PgInboxStore` yet).

### ⬜ Unit 2b: Postgres InboxStore adapter — implementation (GREEN)
**What**: Implement `PgInboxStore` against the Unit-0 schema using parameterized `pg` queries. FIFO via `order by seq`; quota via `select count(*), coalesce(sum(size_bytes),0) where handle=$1 and expires_at>$2`; enqueue inserts after the live-prune check (delete expired for the handle, or filter in the count) — mirror `MemoryInboxStore.livePrune` semantics exactly; ack via `delete … where handle=$1 and queue_id=$2 returning queue_id`; dropExpired via `delete … where expires_at<=$1` returning a count. Store `message` as `jsonb` (opaque round-trip).
**Acceptance**: Unit 2a tests PASS; 100% coverage of `PgInboxStore`; no `v8 ignore`.

### ⬜ Unit 2c: Postgres InboxStore — coverage & content-blind structural check
**What**: Add the per-adapter content-blind assertion: enqueue a sealed message, read the raw row, assert the `message` jsonb round-trips to exactly `{v, sealed:{v,ePk,n,ct}, recipientDid}` with no plaintext substrings, and assert the schema has no ciphertext index/column.
**Acceptance**: 100% coverage; content-blind structural test green.

### ⬜ Unit 3a: Postgres RegistryStore adapter — tests (RED)
**What**: Hermetic `pg-mem` tests for `PgRegistryStore implements RegistryStore`: put/getByHandle/getByDid/remove, plus the two tricky semantics proven for the memory store — re-registration with a NEW did clears the stale did index, and `remove` does NOT clobber a did index re-pointed to another handle.
**Acceptance**: Tests exist and FAIL.

### ⬜ Unit 3b: Postgres RegistryStore adapter — implementation (GREEN)
**What**: Implement `PgRegistryStore`. `put` = `insert … on conflict (handle) do update`; the stale-DID-index behavior falls out of `did` being a column (the by-did lookup is `select … where did=$1 order by registered_at desc limit 1` OR a unique constraint with last-writer-wins — choose to reproduce the memory contract exactly, incl. the shared-DID-across-handles case). `remove` = `delete … where handle=$1 returning handle`.
**Acceptance**: Unit 3a tests PASS; 100% coverage.

### ⬜ Unit 3c: Postgres RegistryStore — coverage & refactor
**What**: Confirm the shared-DID edge cases match memory semantics byte-for-byte; tidy queries.
**Acceptance**: 100% coverage; green.

### ⬜ Unit 4a: Extract InviteStore + CredentialStore seams — tests (RED)
**What**: Define `InviteStore` + `CredentialStore` interfaces (in `src/store/interfaces.ts`, async). Refactor `InviteManager`/`CredentialManager` to take a store and become thin logic-over-store; add in-memory impls (`MemoryInviteStore`, `MemoryCredentialStore`). Write/adjust `security.test.ts` (and `relay.test.ts`'s construction) to inject the in-memory stores and `await`. Inject the two stores through `RelayDeps`/`AssembleOverrides` (so `Relay` stops `new`-ing the managers' state; it constructs managers over injected stores, or receives managers — decide in 4b, default: inject the stores and have `Relay` build the managers, matching how it builds `RateLimiter` from injected primitives).
**Acceptance**: Tests updated to the seam + `await`, and FAIL (no stores/refactor yet).

### ⬜ Unit 4b: Extract InviteStore + CredentialStore seams — implementation (GREEN)
**What**: Implement `MemoryInviteStore`/`MemoryCredentialStore` (lift the existing `Map` logic behind the async interface). Rewire `InviteManager`/`CredentialManager` to delegate to their store. Thread the stores through `RelayDeps` + `assembleRelay` (default to the in-memory impls, exactly like `inbox`/`registry`). Update `bootstrap.test.ts` overrides accordingly.
**Acceptance**: Unit 4a tests PASS; existing invite/credential/rotation behavior preserved; 100% coverage; `relay.test.ts` + `interop` (which exercise invite-gating + rotation) green.

### ⬜ Unit 4c: Invite/Credential seams — coverage & refactor
**What**: Confirm rotation revoke, revoke-absent no-op, exhausted-invite, unknown-invite, send-cred validate hit/miss all covered through the new seam.
**Acceptance**: 100% coverage; green.

### ⬜ Unit 5a: Postgres Invite + Credential adapters — tests (RED)
**What**: Hermetic `pg-mem` tests for `PgInviteStore` + `PgCredentialStore` covering issue/consume(decrement→delete at 0)/unknown/exhausted, and rotate(atomic replace old pair)/revoke/revoke-absent/handleForInboxAuth/canSendTo/handleForSendCredential — including the restart-survival case (fresh adapter over the same db still resolves credentials + remaining invite uses).
**Acceptance**: Tests exist and FAIL.

### ⬜ Unit 5b: Postgres Invite + Credential adapters — implementation (GREEN)
**What**: Implement both against the Unit-0 schema. Invite consume = `update invites set remaining=remaining-1 where token=$1 and remaining>=1 returning remaining`, then delete at 0 (single statement or CTE). Credential rotate = `insert … on conflict (handle) do update set inbox_auth=…, send_credential=…` (atomically supersedes the old pair; the unique reverse indexes mean the old tokens no longer resolve). Reverse lookups = `select handle from credentials where inbox_auth=$1` / `where send_credential=$1`.
**Acceptance**: Unit 5a tests PASS; 100% coverage; no `v8 ignore`.

### ⬜ Unit 5c: Postgres Invite/Credential adapters — coverage & refactor
**What**: Confirm every branch (exhausted vs unknown invite; rotate-with-prior vs first-time; revoke vs revoke-absent) is covered hermetically.
**Acceptance**: 100% coverage; green.

### ⬜ Unit 6a: Config + bootstrap wiring (`RELAY_STORE`/`DATABASE_URL`) — tests (RED)
**What**: Extend `config.test.ts`: `RELAY_STORE` defaults to `memory`; `RELAY_STORE=postgres` with no/empty `DATABASE_URL` throws at `loadConfig` (fail-loud, message names the missing var); `RELAY_STORE=postgres` + valid `DATABASE_URL` parses into config. Extend `bootstrap.test.ts`: `assembleRelay` with `store=memory` builds the `Memory*` backends (unchanged); with `store=postgres` it constructs the four `Pg*` adapters from a pool (test injects a `pg-mem` pool via an override seam so this stays hermetic — add a `pool`/`poolFactory` override to `AssembleOverrides`, OR keep `assembleRelay` taking pre-built store overrides and add a separate `assemblePostgresStores(databaseUrl)` factory that the test drives with a `pg-mem` pool). Decide the seam in 6b; keep it hermetic.
**Acceptance**: Tests exist and FAIL.

### ⬜ Unit 6b: Config + bootstrap wiring — implementation (GREEN)
**What**: Add `store: "memory" | "postgres"` + `databaseUrl?: string` to `RelayConfig`; parse + fail-loud in `loadConfig`. In bootstrap, add a Postgres assembly path: build a `pg.Pool` from `databaseUrl`, run `migrate(pool)`, construct the four `Pg*` adapters, and pass them as the relay's stores. Keep the in-memory path the default. Ensure the `pg.Pool` construction is injectable/overridable so tests use a `pg-mem` pool (no live db). The raw `new Pool()` + real network connect is the only line that may follow the `bin.ts`-style process-wiring exclusion **iff** it cannot be hermetically covered — prefer making it injectable so it IS covered; flag if not.
**Acceptance**: Unit 6a tests PASS; misconfig fails loud; in-memory default unchanged; 100% coverage on new config/bootstrap logic (the actual live-network `connect()` is the only candidate for the documented process-wiring exclusion, justified inline if used).

### ⬜ Unit 6c: Wiring — coverage & refactor
**What**: Confirm both selector branches + the fail-loud branch are covered; tidy.
**Acceptance**: 100% coverage on the covered surface; green.

### ⬜ Unit 7a: Dual-backend parity suite (`store.test.ts`) — tests (RED)
**What**: Refactor `store.test.ts` into a parametrized suite that runs the **same** behavioral assertions over BOTH backends via a factory: `[{ name: "memory", make: () => new MemoryInboxStore(bounds) }, { name: "postgres", make: () => new PgInboxStore(pgMemPool) }]` (and likewise for registry, and the new invite/credential stores). Every assertion `await`s. Include the per-backend content-blind assertion (Unit 2c's check) so the proof runs over Postgres too.
**Acceptance**: The parametrized suite exists; the Postgres parametrization FAILS only where intended until wired (or passes if 2b/3b/5b are done — sequence so this is the consolidation step). Net: red before consolidation.

### ⬜ Unit 7b: Dual-backend parity suite — implementation (GREEN)
**What**: Wire the factory so both backends run identical assertions green. Resolve any semantic gaps surfaced (this is where a `pg-mem`-unsupported branch would show as a blocker — apply the blocker-clause mitigation order).
**Acceptance**: The full `store.test.ts` passes over BOTH backends; 100% coverage; content-blind proof passes against Postgres.

### ⬜ Unit 8a: Simulated-restart end-to-end test — tests (RED)
**What**: A new test (`src/__tests__/restart.test.ts`): build a `pg-mem` db, assemble a relay over Postgres adapters on that db, register an agent (mint invite, consume it, rotate credentials), enqueue a sealed message; then **discard the relay + adapters and rebuild fresh adapters over the SAME db** (simulating a process restart). Assert: the registration, the queued sealed message, the credential bindings (inboxAuth still drains, sendCredential still posts), and the invite's remaining-use state all survive; a single-use invite already consumed pre-restart is still rejected post-restart; rotation done pre-restart means the old credential is rejected post-restart.
**Acceptance**: Test exists and FAILS (until the full Postgres path is wired through assembly).

### ⬜ Unit 8b: Simulated-restart end-to-end test — implementation/wiring (GREEN)
**What**: Make it green using the Unit-6 assembly path with an injected `pg-mem` pool shared across the two relay instances.
**Acceptance**: Restart test passes; 100% coverage maintained; this is the headline durability proof.

### ⬜ Unit 9: README + Dockerfile env-var notes (Docs)
**What**: README "Deploy" section: add `RELAY_STORE` (`memory` default / `postgres`) and `DATABASE_URL` to the env table; add a one-line "Infra to provision (Postgres path): an Azure Database for PostgreSQL flexible server (burstable B1ms); set `RELAY_STORE=postgres` and `DATABASE_URL` (with `sslmode=require`) as injected env (a Container App secret)." Note the content-blind guarantee extends to the db (it holds ciphertext only; backups/telemetry of the db carry ciphertext only). Add a short Dockerfile comment that `pg` is pure-JS (no builder-stage toolchain change) and the backend is still env-selected.
**Acceptance**: README env table + infra note present and accurate; Dockerfile comment present; no behavior/code change; `lint`/`typecheck` unaffected.

## Execution
- **TDD strictly enforced**: tests → red → implement → green → refactor, per sub-unit.
- Commit after each sub-unit (1a, 1b, 1c, …). Push after each top-level unit completes.
- Run the full suite + coverage before marking any unit done.
- **All artifacts** (any scratch SQL, pg-mem repro snippets, coverage reports): `./2026-06-22-0814-doing-persistent-storage/`.
- **Fixes/blockers**: spawn a sub-agent immediately — except the one sanctioned STOP: if a Postgres adapter branch genuinely cannot reach 100% under `pg-mem` after the mitigation order, STOP and flag (do NOT `v8 ignore`).
- **Decisions made**: update this doc immediately + commit.
- **Hermetic invariant**: no test may touch a live Azure/Postgres resource. `pg-mem` only. The operator provisions the real Postgres + wires `DATABASE_URL`; this work plans code only.

## Progress Log
- 2026-06-22 08:14 Created from planning doc (Pass 1 first draft). Baked in the 5 resolved answers (Postgres + pure-JS `pg`; two new InviteStore/CredentialStore interfaces; rate-limiter buckets stay ephemeral; replica-moot; `pg-mem` hermetic fake). Validated against HEAD: confirmed the server side is fully synchronous and made the async-seam conversion an explicit foundational Unit 1 ahead of the adapters.
