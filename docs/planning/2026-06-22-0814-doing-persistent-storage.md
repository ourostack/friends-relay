# Doing: Persistent storage backend for friends-relay (Postgres)

**Status**: READY_FOR_EXECUTION
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

## Pass-3 validation findings (probed against pg-mem 3.0.14 + pg 8.22.0 — de-risks the adapter SQL)
Verified in a scratch install (not the repo) that every SQL shape the adapters need is supported by the hermetic harness, so **there is no hermetic-coverage blocker** — the whole adapter surface is reachable under `pg-mem`:
- **`pg` adapter API**: `import { newDb } from "pg-mem"` → `const { Pool, Client } = newDb().adapters.createPg()`. A `new Pool()` is `pg`-API-compatible (`.query(text, params)` → `{ rows, rowCount }`). This is the exact bootstrap the test units (2a/3a/5a/6a/7/8) should use.
- **Quota aggregation**: `select count(*)::int, coalesce(sum(size_bytes),0)::int where handle=$1 and expires_at>$2` — works.
- **Ack**: `delete … where handle=$1 and queue_id=$2 returning queue_id` returns the row + correct `rowCount` — works (drives ack hit/miss).
- **jsonb opaque round-trip**: a `jsonb` column round-trips to a JS object (`{v,sealed:{…},recipientDid}`) — works (content-blind storage).
- **Re-registration**: `insert … on conflict (handle) do update set …=excluded.…` — works.
- **Invite decrement**: `update … set remaining = remaining - 1 … returning remaining` — works **iff spaced** (see Unit 5b gotcha).
- **Credential rotation + reverse indexes**: unique indexes on `inbox_auth`/`send_credential` + `on conflict (handle) do update` atomically supersede the old pair; old tokens stop resolving (rowCount 0) — works.
- **Simulated restart mechanism (CONFIRMED — Unit 8 depends on this)**: a **fresh `new Pool()` over the SAME `newDb()` instance retains all rows.** So "restart" = build a `newDb()`, run the relay over adapters using one pool, then construct fresh adapters/a fresh pool over the *same* `newDb()` and assert state survived. No file/socket needed.

## Env vars the relay will read (for the operator to wire)
- `RELAY_STORE` — backend selector. `memory` (default, unchanged) or `postgres`. Absent/empty ⇒ `memory`.
- `DATABASE_URL` — standard Postgres connection string (`postgres://user:pass@host:5432/dbname?sslmode=require`). **Required and validated when `RELAY_STORE=postgres`**; ignored otherwise. Fail-loud at `loadConfig` if `RELAY_STORE=postgres` and `DATABASE_URL` is missing/empty.
- (Optional, decide in Unit 5) `RELAY_PG_SSL` / pool-size knobs — only if needed; default to `sslmode` in the URL + library defaults to keep the surface minimal.

## Work Units

### Legend
⬜ Not started · 🔄 In progress · ✅ Done · ❌ Blocked

**Every unit header starts with a status emoji.**

### ✅ Unit 0: Dependencies + Postgres schema/DDL constant (Setup)
**What**: Add `pg@^8` to `dependencies` and `pg-mem@^3` + `@types/pg` to `devDependencies` via `npm install` (updates `package-lock.json`; `npm ci` in CI + Dockerfile picks it up with no Dockerfile edit). Define the canonical DDL the Postgres adapters create/expect, in one module (e.g. `src/store/postgres/schema.ts`), as exported SQL strings:
- `inbox(handle text, queue_id text primary key, message jsonb not null, enqueued_at bigint not null, expires_at bigint not null, size_bytes int not null, seq bigserial)` + index `(handle, expires_at)`; FIFO order by the monotonic `seq bigserial` (durable, survives restart — replaces the in-memory `seq` counter) so ordering is correct across restarts. **PINNED: the inbox does NOT store `recipient_did`** — the recipient-DID match happens in `Relay.enqueue` against the `registry` BEFORE the inbox `enqueue` call (verified at `relay.ts:200-203`: `if (payload.recipientDid !== reg.did) return recipient_mismatch`), so the inbox never needs it. The inbox holds only the opaque `message` jsonb + accounting metadata. This also keeps the inbox maximally blind (no routing-identity column beyond `handle`).
- `registrations(handle text primary key, did text not null, agent_card jsonb not null, key_agreement_pubkey text, registered_at bigint not null)` + index on `did` (the by-DID lookup); re-registration = `ON CONFLICT (handle) DO UPDATE`, with the stale-DID-index semantics handled in SQL.
- `invites(token text primary key, remaining int not null)`.
- `credentials`: a shape that supports `inboxAuth → handle`, `sendCred → handle`, `handle → current pair`, and atomic rotation/revoke (e.g. `credentials(handle text primary key, inbox_auth text not null, send_credential text not null)` + unique indexes on `inbox_auth` and `send_credential` for the reverse lookups; rotation = `ON CONFLICT (handle) DO UPDATE`, which atomically replaces the old pair so the old tokens stop resolving).
**Output**: lockfile updated; `schema.ts` with exported DDL strings + a `migrate(pool)` that runs them idempotently (`create table if not exists` / `create index if not exists`).
**Acceptance**: `npm install` clean; `npm run typecheck` resolves `pg`/`pg-mem` types; DDL strings exist and are syntactically valid Postgres (verified by `pg-mem` accepting them in Unit 2's test bootstrap). No adapter logic yet.

### ✅ Unit 1a: Make the storage seam async — convert tests to await (RED)
**What**: Widen `InboxStore` + `RegistryStore` method signatures in `src/store/interfaces.ts` to return `Promise<…>`. Update the existing suites (`store.test.ts`, `relay.test.ts`, `http.test.ts` router block, `bootstrap.test.ts`, and the interop content-blind direct `inbox.list` call) to `await` the now-async API. Do NOT yet change the implementations.
**Acceptance**: Tests are updated to `await` and the suite **FAILS to compile / FAILS** (red) because `Memory*`/`Relay`/`handle` still return sync values — confirming the spec is captured.

### ✅ Unit 1b: Make the storage seam async — implementation (GREEN)
**What**: Make `MemoryInboxStore`/`MemoryRegistryStore` methods `async` (bodies unchanged). Propagate `async`/`await` through `Relay` (`register`/`deregister`/`enqueue`/`pull`/`ack`/`ownsInbox`/`issueInvite`/`lookupByHandle`/`lookupByDid`/`sweepExpired`), `handle()` in `server/http.ts` (now `async`, `await relay.*`), `assembleRelay` (in-memory path stays sync-constructed; return type adjusted as needed), and `bin.ts` (wrap startup in an async IIFE — coverage-excluded). `RateLimiter`/`tokens`/`clock` stay synchronous (not store-backed).
**Acceptance**: Full suite PASSES (green) again; `typecheck` + `lint` clean; **coverage still 100%**; no behavior change observable at the socket level (the `createServer`/`client`/`interop` socket tests pass unchanged in intent).

### ✅ Unit 1c: Async seam — coverage & refactor
**What**: Confirm no branch regressed; tidy any awkward `Promise` plumbing; ensure the `EnqueueResult`/error unions are unchanged (only the wrapping `Promise` is new).
**Acceptance**: 100% coverage on all touched files; suite green; diff is signature-only (no logic drift) for the in-memory path.

### ✅ Unit 2a: Postgres InboxStore adapter — tests (RED)
**What**: Write hermetic `pg-mem`-backed tests for a `PgInboxStore implements InboxStore`: enqueue/list/ack/dropExpired/depth over an in-process db (created via `pg-mem`'s `newDb().adapters.createPg()` → a `pg`-compatible `Pool`). Cover every branch the memory suite covers (count quota, byte quota, expired-not-counted-on-enqueue, list prunes expired, unknown handle empty, ack hit/miss/idempotent, dropExpired across handles, FIFO order across a simulated restart via a fresh adapter over the same db).
**Acceptance**: Tests exist and FAIL (no `PgInboxStore` yet).

### ✅ Unit 2b: Postgres InboxStore adapter — implementation (GREEN)
**What**: Implement `PgInboxStore` against the Unit-0 schema using parameterized `pg` queries. FIFO via `order by seq`; quota via `select count(*), coalesce(sum(size_bytes),0) where handle=$1 and expires_at>$2`; enqueue inserts after the live-prune check (delete expired for the handle, or filter in the count) — mirror `MemoryInboxStore.livePrune` semantics exactly; ack via `delete … where handle=$1 and queue_id=$2 returning queue_id`; dropExpired via `delete … where expires_at<=$1` returning a count. Store `message` as `jsonb` (opaque round-trip).
**Acceptance**: Unit 2a tests PASS; 100% coverage of `PgInboxStore`; no `v8 ignore`.

### ✅ Unit 2c: Postgres InboxStore — coverage & content-blind structural check
**What**: Add the per-adapter content-blind assertion: enqueue a sealed message, read the raw row, assert the `message` jsonb round-trips to exactly `{v, sealed:{v,ePk,n,ct}, recipientDid}` with no plaintext substrings, and assert the schema has no ciphertext index/column.
**Acceptance**: 100% coverage; content-blind structural test green.

### ✅ Unit 3a: Postgres RegistryStore adapter — tests (RED)
**What**: Hermetic `pg-mem` tests for `PgRegistryStore implements RegistryStore`: put/getByHandle/getByDid/remove, plus the two tricky semantics proven for the memory store — re-registration with a NEW did clears the stale did index, and `remove` does NOT clobber a did index re-pointed to another handle.
**Acceptance**: Tests exist and FAIL.

### ✅ Unit 3b: Postgres RegistryStore adapter — implementation (GREEN)
**What**: Implement `PgRegistryStore` with `did` as a plain (non-unique) column so multiple handles may carry the same DID (the shared-DID case). Pin these query shapes (no alternatives):
- `put` = `insert into registrations(handle,did,agent_card,key_agreement_pubkey,registered_at) values ($1,$2,$3,$4,$5) on conflict (handle) do update set did=excluded.did, agent_card=excluded.agent_card, key_agreement_pubkey=excluded.key_agreement_pubkey, registered_at=excluded.registered_at`.
- `getByHandle` = `select * from registrations where handle=$1`.
- `getByDid` = `select * from registrations where did=$1 order by registered_at desc, handle desc limit 1` — **last-writer-wins**, reproducing the memory store's "byDid points at the most recently `put` registration for that DID" semantics (so when h2 re-claims a shared DID after h1, by-did resolves to h2).
- `remove` = `delete from registrations where handle=$1 returning handle` (existence via `rowCount`). Because `getByDid` is computed by recency rather than a stored index, removing h1 cannot clobber h2's claim on a shared DID — the "remove must not clobber a re-pointed DID" contract holds for free. The "re-registration with a NEW did clears the stale did index" contract also holds: after h re-registers with a new DID, `getByDid(oldDid)` finds no row (h's row now carries the new DID and no other handle holds oldDid).
**Acceptance**: Unit 3a tests PASS (incl. both tricky semantics); 100% coverage.

### ✅ Unit 3c: Postgres RegistryStore — coverage & refactor
**What**: Confirm the shared-DID edge cases match memory semantics byte-for-byte; tidy queries.
**Acceptance**: 100% coverage; green.

### ✅ Unit 4a: Extract InviteStore + CredentialStore seams — tests (RED)
**What**: Define `InviteStore` + `CredentialStore` interfaces (in `src/store/interfaces.ts`, async). Refactor `InviteManager`/`CredentialManager` to take a store and become thin logic-over-store; add in-memory impls (`MemoryInviteStore`, `MemoryCredentialStore`). Write/adjust `security.test.ts` (and `relay.test.ts`'s construction) to inject the in-memory stores and `await`. **Pinned seam shape (no alternative): add `invites: InviteStore` + `credentials: CredentialStore` to `RelayDeps` (and to `AssembleOverrides`); `Relay`'s constructor builds `InviteManager`/`CredentialManager` over those injected stores — exactly mirroring how it already builds `RateLimiter` from `deps.config`/`deps.clock`. `Relay` stops owning the managers' state but keeps owning the managers.** The `InviteStore` surface = `issue(token, uses)` / `consume(token): boolean`-equivalent decomposed into the store primitives the manager needs (e.g. `setRemaining(token, n)`, `getRemaining(token)`, `decrementOrDelete(token): boolean`); the `CredentialStore` surface = `setCurrent(handle, pair)` / `getCurrent(handle)` / `deleteFor(handle, pair)` / `handleForInboxAuth(token)` / `handleForSendCredential(token)`. Keep the manager as the logic layer (the use-cap guard, the rotation revoke-then-mint sequencing) and the store as pure persistence.
**Acceptance**: Tests updated to the seam + `await`, and FAIL (no stores/refactor yet).

### ✅ Unit 4b: Extract InviteStore + CredentialStore seams — implementation (GREEN)
**What**: Implement `MemoryInviteStore`/`MemoryCredentialStore` (lift the existing `Map` logic behind the async interface). Rewire `InviteManager`/`CredentialManager` to delegate to their store. Thread the stores through `RelayDeps` + `assembleRelay` (default to the in-memory impls, exactly like `inbox`/`registry`). Update `bootstrap.test.ts` overrides accordingly.
**Acceptance**: Unit 4a tests PASS; existing invite/credential/rotation behavior preserved; 100% coverage; `relay.test.ts` + `interop` (which exercise invite-gating + rotation) green.

### ✅ Unit 4c: Invite/Credential seams — coverage & refactor
**What**: Confirm rotation revoke, revoke-absent no-op, exhausted-invite, unknown-invite, send-cred validate hit/miss all covered through the new seam.
**Acceptance**: 100% coverage; green.

### ✅ Unit 5a: Postgres Invite + Credential adapters — tests (RED)
**What**: Hermetic `pg-mem` tests for `PgInviteStore` + `PgCredentialStore` covering issue/consume(decrement→delete at 0)/unknown/exhausted, and rotate(atomic replace old pair)/revoke/revoke-absent/handleForInboxAuth/canSendTo/handleForSendCredential — including the restart-survival case (fresh adapter over the same db still resolves credentials + remaining invite uses).
**Acceptance**: Tests exist and FAIL.

### ✅ Unit 5b: Postgres Invite + Credential adapters — implementation (GREEN)
**What**: Implement both against the Unit-0 schema. Invite consume = `update invites set remaining = remaining - 1 where token=$1 and remaining >= 1 returning remaining`, then delete at 0 (single statement or CTE). **GOTCHA (verified against pg-mem 3.0.14 in Pass 3): write arithmetic spaced — `remaining - 1`, NOT `remaining-1` — pg-mem's parser rejects the unspaced form** (`Unexpected int token "-1"`). Credential rotate = `insert … on conflict (handle) do update set inbox_auth=excluded.inbox_auth, send_credential=excluded.send_credential` (atomically supersedes the old pair; the unique reverse indexes mean the old tokens no longer resolve — verified). Reverse lookups = `select handle from credentials where inbox_auth=$1` / `where send_credential=$1`.
**Acceptance**: Unit 5a tests PASS; 100% coverage; no `v8 ignore`.

### ✅ Unit 5c: Postgres Invite/Credential adapters — coverage & refactor
**What**: Confirm every branch (exhausted vs unknown invite; rotate-with-prior vs first-time; revoke vs revoke-absent) is covered hermetically.
**Acceptance**: 100% coverage; green.

### ✅ Unit 6a: Config + bootstrap wiring (`RELAY_STORE`/`DATABASE_URL`) — tests (RED)
**What**: Extend `config.test.ts`: `RELAY_STORE` defaults to `memory`; `RELAY_STORE=postgres` with no/empty `DATABASE_URL` throws at `loadConfig` (fail-loud, message names the missing var); `RELAY_STORE=postgres` + valid `DATABASE_URL` parses into config; an unrecognized `RELAY_STORE` value throws (fail-loud). Extend `bootstrap.test.ts` using the **pinned seam (no alternative)**: factor the Postgres store construction into an exported pure function `buildPostgresStores(pool, bounds): { inbox; registry; invites; credentials }` (synchronously constructs the four `Pg*` adapters around an injected pool — it does NOT create the pool; **`bounds` added during execution because `PgInboxStore` is bounded**), plus an exported async `assemblePostgresStores(databaseUrl, bounds, poolFactory = defaultPoolFactory): Promise<…stores>` that creates the pool, runs `migrate(pool)`, then returns `buildPostgresStores(pool)`. Tests drive `buildPostgresStores` + `assemblePostgresStores` with a `pg-mem` pool by passing a `poolFactory` that returns the `pg-mem` `Pool` (fully hermetic). `assembleRelay` gains a thin branch: when `config.store === "postgres"`, the caller is expected to have built the stores via `assemblePostgresStores` and pass them as overrides — i.e. `assembleRelay` itself stays synchronous and store-agnostic; the async pool/migrate work lives in `assemblePostgresStores`, which `bin.ts` calls.
**Acceptance**: Tests exist and FAIL.

### ✅ Unit 6b: Config + bootstrap wiring — implementation (GREEN)
**What**: Add `store: "memory" | "postgres"` + `databaseUrl?: string` to `RelayConfig`; parse + fail-loud in `loadConfig` (missing `DATABASE_URL` under postgres; unrecognized `RELAY_STORE`). Implement `buildPostgresStores(pool)` (sync, wraps the four adapters) and `assemblePostgresStores(databaseUrl, poolFactory?)` (async: create pool via `poolFactory`, `await migrate(pool)`, return `buildPostgresStores(pool)`). Update `bin.ts` (coverage-excluded process wiring): when `config.store === "postgres"`, `await assemblePostgresStores(config.databaseUrl!)` and pass the stores into `assembleRelay(config, stores)`; else `assembleRelay(config)`. The in-memory default path is unchanged. The ONLY non-hermetic line is the default `poolFactory`'s `new Pool({ connectionString })` (a real network handle) — it is exercised by tests via an injected `pg-mem` `poolFactory`, so the default factory body is the single candidate for the `bin.ts`-style exclusion **iff** v8 still marks the default-arg expression uncovered; prefer structuring so the default factory is covered (e.g. its construction runs under a `pg-mem` connection string in a test) and only fall back to the documented exclusion if genuinely unreachable — then justify inline.
**Acceptance**: Unit 6a tests PASS; misconfig fails loud (both branches); in-memory default unchanged; 100% coverage on `buildPostgresStores` + `assemblePostgresStores` + the new `loadConfig` branches (any residual uncovered line is ONLY the real-network default `poolFactory`, justified inline if the exclusion is used).

### ✅ Unit 6c: Wiring — coverage & refactor
**What**: Confirm both selector branches + the fail-loud branch are covered; tidy.
**Acceptance**: 100% coverage on the covered surface; green.

### ✅ Unit 7a: Dual-backend parity suite (`store.test.ts`) — parametrize over memory (RED→GREEN for memory)
**What**: This is a **consolidation/refactor** unit (the `Pg*` adapters already exist + are individually tested by Units 2/3/5; their bespoke per-adapter tests from 2a/3a/5a are retained). Refactor `store.test.ts` from concrete `Memory*` calls into a parametrized suite driven by a backend table, starting with ONLY the memory row wired:
```ts
const backends = [
  { name: "memory", makeInbox: () => new MemoryInboxStore(bounds), makeRegistry: () => new MemoryRegistryStore(), makeInvite: () => new MemoryInviteStore(), makeCred: () => new MemoryCredentialStore() },
  // postgres row added in 7b
]
```
Every assertion becomes `await`-based (it already had to in Unit 1a). Because Unit 1 already made the memory stores async, the memory parametrization should pass; the RED here is mechanical (the refactor's intermediate compile state) — do not contrive a fake failure. The unit's real gate is that the memory parametrization is green and structurally ready for a second row.
**Acceptance**: `store.test.ts` runs every behavioral assertion over the `memory` backend via the factory; green; coverage 100%.

### ✅ Unit 7b: Dual-backend parity suite — add the Postgres row (GREEN)
**What**: Add the `postgres` backend row to the table, each `make*` returning a `Pg*` adapter over a fresh `pg-mem` pool + migrated schema (per-test or per-suite `beforeEach` builds `newDb().adapters.createPg()`). Add the per-backend content-blind assertion (Unit 2c's check) into the shared body so the "only ciphertext" proof runs over Postgres too. Resolve any semantic gap the shared assertions surface (this is the consolidation point where a `pg-mem`-unsupported branch would show as a blocker — apply the blocker-clause mitigation order; Pass-3 probing found none).
**Acceptance**: The full `store.test.ts` passes identically over BOTH backends; 100% coverage; content-blind proof passes against Postgres.

### ✅ Unit 8a: Simulated-restart end-to-end test — tests (RED)
**What**: A new test (`src/__tests__/restart.test.ts`): build a `pg-mem` db, assemble a relay over Postgres adapters on that db, register an agent (mint invite, consume it, rotate credentials), enqueue a sealed message; then **discard the relay + adapters and rebuild fresh adapters over the SAME db** (simulating a process restart). Assert: the registration, the queued sealed message, the credential bindings (inboxAuth still drains, sendCredential still posts), and the invite's remaining-use state all survive; a single-use invite already consumed pre-restart is still rejected post-restart; rotation done pre-restart means the old credential is rejected post-restart.
**Acceptance**: Test exists and FAILS (until the full Postgres path is wired through assembly).

### ✅ Unit 8b: Simulated-restart end-to-end test — implementation/wiring (GREEN)
**What**: Make it green using the Unit-6 path: a single `pg-mem` `newDb()` shared across both relay instances. Build relay #1 via `assembleRelay(config, await assemblePostgresStores(url, () => pgMemPool1))` where `pgMemPool1 = db.adapters.createPg().Pool` (the migrate runs once); register/enqueue/rotate/consume-invite through relay #1's async API. Then build relay #2 over a **fresh** `Pool` from the SAME `db` (`assemblePostgresStores(url, () => pgMemPool2)`; `migrate` is idempotent `create … if not exists`, so re-running is safe) and assert all state survived through relay #2's API. (Pass-3 confirmed a fresh pool over the same `newDb()` retains rows.)
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

### Execution
- **DECISION (Unit 0, pg-mem harness):** pg-mem 3.0.14's **default strict mode** rejects the schema's `create table if not exists (...)` statements (inline `not null`/`primary key` constraints) when run through the `pg` **Pool adapter** — it throws `NotSupported: AST … parts have not been read by the query planner`. This is a pg-mem **AST-coverage limitation, NOT a real SQL incompatibility** (production Postgres accepts the DDL natively; Pass-3 probed individual DML through a default Pool but did not run the full `create table if not exists` DDL through it). **Resolved cleanly** by constructing the test db with `newDb({ noAstCoverageCheck: true })` — purely a test-harness concern (lives in `src/__tests__/pg-harness.ts`); the production DDL in `src/store/postgres/schema.ts` is unchanged plain Postgres. No schema rephrase, no blocker. Validated the ENTIRE adapter SQL surface end-to-end under this harness (artifact: `scratch-schema-validate.mjs` — DDL idempotent, jsonb round-trip, quota agg, ack RETURNING hit/miss, dropExpired, getByDid recency + remove-without-clobber, invite spaced-decrement, unspaced gotcha rejected, credential rotation supersede, fresh-pool-over-same-db restart).
- **DECISION (Unit 0, coverage):** `vitest.config.ts` has `include: ["src/**/*.ts"]`, so v8 instruments `schema.ts` even before any adapter imports it → it reports 0% and fails the gate. Therefore `schema.ts` is covered NOW (not deferred to Unit 2) by a focused `schema.test.ts` driving `migrate(pool)` against pg-mem + asserting the four tables/columns + idempotency + the content-blind no-`recipient_did`/no-`ct` column invariant. The pinned seam: `schema.ts` exports a structural `PgPool` interface (NOT `import type { Pool } from "pg"`) so the store layer stays driver-agnostic and the `no-restricted-imports` store rule is satisfied; both the real `pg` Pool and the pg-mem Pool satisfy it.
- **DECISION (Unit 2b, branch coverage):** the adapter's `ack`/`dropExpired` originally returned `res.rowCount ?? 0`, but `rowCount: number | null` (the `@types/pg` type) creates a null-branch pg-mem can never exercise (it always returns a number) → 75% branch coverage. Resolved per the blocker-clause mitigation order (restructure, NOT v8 ignore): both now return `res.rows.length` from the `returning queue_id` clause (one row per deleted row = the exact count, always a number, no dead branch). Branch count dropped 297→295 — the branches were genuinely dead. 100% branch coverage restored hermetically.
- **DECISION (Unit 2c, content-blind index assertion):** pg-mem 3.0.14 does NOT implement `pg_indexes`, so the "no ciphertext index" claim cannot be asserted via the catalog hermetically. Resolved by asserting the strictly stronger, sufficient property: the `inbox` table has NO ciphertext column (verified via `information_schema.columns`) — and an index can only reference an existing column, so column-absence makes a ciphertext index structurally impossible; the schema DDL itself indexes only `(handle, expires_at)` + the `queue_id` PK. Combined with the raw-row round-trip + no-plaintext-substring assertions, the content-blind invariant is proven against Postgres.
- **DECISION (Unit 4c, store-primitive coverage):** three `MemoryInviteStore`/`MemoryCredentialStore` branches are NOT reachable through the managers — `getRemaining` (the InviteManager only uses `setRemaining`+`decrementOrDelete`), `setCurrent`'s supersede-prior branch (the manager calls `deleteFor(prev)` BEFORE `setCurrent`, so prev is already gone), and `deleteFor`'s no-op branch (the manager always passes the matching current pair). These are legitimate store-contract primitives (the Pg adapter + Unit-7 parity suite exercise them, and they belong to the store's own contract). Covered NOW via direct `MemoryInviteStore`/`MemoryCredentialStore` tests in `store.test.ts` (their eventual Unit-7 parametrization home) — NOT papered over. 100% restored.
- **DECISION (Unit 6b, signature — minor doc deviation):** the doc pinned `buildPostgresStores(pool)` / `assemblePostgresStores(url, poolFactory?)`, but `PgInboxStore` is BOUNDED (needs `InboxBounds`, an oversight in the pin — the inbox adapter has always taken bounds). Resolved by threading `config.inboxBounds`: `buildPostgresStores(pool, bounds)` + `assemblePostgresStores(databaseUrl, bounds, poolFactory = defaultPoolFactory)`. `bin.ts` calls `assemblePostgresStores(config.databaseUrl!, config.inboxBounds)`. Everything else matches the pin (assembleRelay stays sync + store-agnostic; the async pool/migrate lives in assemblePostgresStores). Faithful to the design intent.
- **DECISION (Unit 6b, default-factory coverage — NO exclusion needed):** the only non-hermetic line is `defaultPoolFactory`'s `new Pool({ connectionString })`. Resolved per the doc's preferred path WITHOUT a v8 ignore: `pg` connects LAZILY (no socket on construction), so a direct hermetic test constructs a real Pool via `defaultPoolFactory(...)` and immediately `.end()`s it (zero queries → zero network). Result: `bootstrap.ts` is 100% covered with NO exclusion entry. (The earlier worry that the `poolFactory` default-arg would be marked uncovered did not materialize under v8 v4.)
- **NOTE (Unit 8):** the assembly path (`assemblePostgresStores`/`assembleRelay`) was built in Unit 6, so the restart test (`restart.test.ts`) passed GREEN on first run — there was no honest RED to contrive (same principle the doc applied to Unit 7a: "do not contrive a fake failure"). 8a = authoring the durability assertions; 8b = confirming they pass over the Unit-6 path. The proof is real (not trivially passing): it builds relay #2 over a FRESH pool on the SAME `pg-mem` db; against the memory backend relay #2 would start empty and every assertion would fail — durability is exactly what distinguishes the Postgres path.
- 2026-06-22 08:36 Unit 0 complete: added `pg@^8.22.0` (dependency), `pg-mem@^3.0.14` + `@types/pg@^8.20.0` (devDeps); created `src/store/postgres/schema.ts` (4-table DDL + idempotent `migrate(pool)` + structural `PgPool`), `src/__tests__/pg-harness.ts` (shared pg-mem harness), `src/__tests__/schema.test.ts` (8 tests). Suite 165 pass; coverage 100%/100%/100%/100%; typecheck + lint clean. Branch `feat/persistent-storage` off origin/main 68ffe1a (docs cherry-picked).

### Planning passes
- 2026-06-22 08:14 Created from planning doc (Pass 1 first draft). Baked in the 5 resolved answers (Postgres + pure-JS `pg`; two new InviteStore/CredentialStore interfaces; rate-limiter buckets stay ephemeral; replica-moot; `pg-mem` hermetic fake). Validated against HEAD: confirmed the server side is fully synchronous and made the async-seam conversion an explicit foundational Unit 1 ahead of the adapters.
- 2026-06-22 08:23 Pass 1 committed.
- 2026-06-22 08:23 Pass 2 (granularity): every feature already split tests→impl→coverage (a/b/c); each sub-unit atomic + one-session + has What/Acceptance. Confirmed Unit 0 (deps + 4-table DDL) is a legitimately-bundled setup unit (DDL is one cohesive deliverable); no further breakdown needed. No structural changes.
- 2026-06-22 08:23 Pass 3 (validation): read interfaces/memory/relay/security/config/bootstrap/bin/http + store.test.ts at HEAD; confirmed the server side is 100% synchronous (only `client/index.ts` + socket-level tests are async). Probed pg-mem 3.0.14 + pg 8.22.0 in a scratch install: confirmed `newDb().adapters.createPg()` → `{Pool,Client}`, jsonb round-trip, count/coalesce-sum, DELETE…RETURNING+rowCount, ON CONFLICT…DO UPDATE, unique reverse-index rotation supersede, and the fresh-pool-over-same-db restart mechanism. Caught the pg-mem unspaced-arithmetic parser quirk (`remaining-1` rejected) and baked the `remaining - 1` fix + gotcha into Unit 5b. Net: no hermetic-coverage blocker — full adapter surface is reachable under pg-mem. Added a Pass-3 findings block.
- 2026-06-22 08:26 Pass 4 (ambiguity): resolved every doer-facing fork. Pinned Unit 3b registry query shapes (did as plain column + last-writer-wins `getByDid`, recency-computed so remove can't clobber a shared DID — verified faithful to both memory edge-case tests). Pinned Unit 4a invite/credential seam (stores on `RelayDeps`/`AssembleOverrides`, manager-builds-over-store mirroring `RateLimiter`) with concrete store surfaces. Pinned Unit 6 wiring seam (`buildPostgresStores(pool)` sync + `assemblePostgresStores(url, poolFactory?)` async; `assembleRelay` stays sync/store-agnostic; `bin.ts` does the async pool/migrate) and made the only-non-hermetic-line exclusion explicit. Made Unit 7a/7b red/green honest (consolidation, no contrived failure). Pinned Unit 8b restart mechanism to one shared `newDb()` + idempotent migrate. Closed the inbox `recipient_did` decision (NOT stored; match is pre-store at relay.ts:200-203). No residual ambiguity → no Open-Questions deferral / no STOP.
- 2026-06-22 08:27 Pass 5 (quality): scanned the doc — 24 unit headers, all 24 prefixed `### ⬜`; 24 Acceptance lines (one per unit); zero TBD/TODO/decide-later items; completion criteria + 100%-coverage requirements + hermetic blocker clause all present; header fields complete. Flipped Status drafting → READY_FOR_EXECUTION.
