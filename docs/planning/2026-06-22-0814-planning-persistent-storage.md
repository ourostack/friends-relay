# Planning: Persistent storage backend for friends-relay

**Status**: NEEDS_REVIEW
**Created**: 2026-06-22 08:14

## Goal
The relay is deployed (`ouro-prod-friends-relay`, Azure Container Apps) on **in-memory storage (v1)** — a restart drops every registration, queued (sealed) inbox message, invite, and credential binding. Add a **persistent storage backend behind the existing storage seam** so the relay survives restarts, **without weakening the content-blind invariant** and **without disturbing the hermetic 100%-coverage test suite** (in-memory stays the default/test backend; the durable one is selected by env).

## Scope

### In Scope
- Audit + enumerate every piece of relay state that must survive a restart and its access pattern (done in this doc — see Context / References).
- A **durable backend implementation behind the storage interfaces** — additive. In-memory remains the default and the test backend; the durable backend is selected by config/env.
- Closing the **seam gap**: today only `InboxStore` + `RegistryStore` are behind interfaces. Invite state and credential bindings live in private `Map`s **inside** `InviteManager` / `CredentialManager`, constructed inside `Relay` (not injected, not swappable). Persisting them requires extracting their state behind a seam. (Exact shape of that seam is an Open Question.)
- Config wiring (`loadConfig` + `assembleRelay`) to select the backend from env, fail-loud on misconfig, and keep the in-memory default when unset.
- Hermetic unit tests for the durable backend (embedded/in-process instance or a fake — **never** a live Azure resource) that hold the 100%-coverage gate (lines/branches/functions/statements).
- A documented note (README + this doc) of exactly **what infra** the chosen backend needs to provision (the operator provisions it; see Out of Scope).

### Out of Scope
- **Azure provisioning of the backing store** (Postgres flexible server / storage account / mounted volume) — the operator handles this (personal-subscription boundary). We only state precisely what is needed.
- **The redeploy** of `ouro-prod-friends-relay` — operator handles it.
- TLS / reverse-proxy posture (already injected upstream; unchanged).
- Any change to the **wire protocol**, the A2A surface, the `RelayClient`, or the recipient-side seal/replay model. The recipient `SeenLedger` (replay dedup, keyed on the seal nonce) is **recipient-side only** — it is NOT relay state and is explicitly not in scope (see the note under Decisions Made).
- Persisting **rate-limiter token buckets** unless we decide it is wanted (Open Question — default recommendation: do NOT persist; a restart resetting the rate window is safe).
- Multi-replica / horizontal-scale concurrency hardening beyond what the chosen backend gives for free (the prod app is single-replica; see Open Questions).

## Completion Criteria
- [ ] Every state family identified in the audit either persists through the durable backend or is explicitly documented as intentionally ephemeral (with rationale).
- [ ] In-memory backend remains the default; with no persistence env set, behavior + tests are byte-for-byte unchanged.
- [ ] Durable backend selected purely by env/config; misconfiguration fails loud at startup (consistent with `loadConfig`'s existing fail-loud contract).
- [ ] Content-blind invariant preserved and proven: the durable inbox persists only `{ recipientDid, opaque A2AMessage blob, queueId, enqueuedAt, expiresAt, sizeBytes }` — no plaintext, no key, no decoded `sealed.ct`. A test asserts the persisted form contains only the opaque blob (mirroring the interop test's "only ever held ciphertext" assertion against the new backend).
- [ ] Ordered-queue + ack/delete + per-handle count/byte quota + TTL semantics of `InboxStore` are reproduced exactly by the durable backend (the existing `store.test.ts` behavioral contract passes against it).
- [ ] Re-registration credential rotation + invite single-use/capped consumption survive a simulated restart (state reloaded from the durable store).
- [ ] 100% coverage on all new code (no `v8 ignore` on new logic except the established bin/process-wiring pattern).
- [ ] All tests pass; `npm run typecheck` + `npm run lint` clean; no warnings.
- [ ] README "Deploy" section updated with the new backend env var(s) and the one-line infra-to-provision note.

## Code Coverage Requirements
**MANDATORY: 100% coverage on all new code.**
- No `[ExcludeFromCodeCoverage]` / `v8 ignore` on new code (the only sanctioned exclusions are the existing barrels + `bin.ts` process wiring; a new durable `bin`-style shim, if any, follows that same documented pattern).
- All branches covered (quota count vs byte drop, TTL expiry, ack hit/miss, re-registration DID-reindex, invite exhausted vs unknown, credential rotation revoke).
- All error paths tested (backend connect/IO failure surfaced as a loud startup/throw, not a silent swallow).
- Edge cases: empty queue, unknown handle, unknown queueId, expired-on-read pruning, re-ack idempotency, DID re-point across handles, exhausted invite, rotated-away credential.

## Open Questions
- [ ] **BACKEND CHOICE (the central design question).** The discriminating requirement is the **ordered, ack-able, per-handle queue with TTL + count/byte quota** — registrations/invites/credentials are trivial key-value. Three realistic options for a low-cost personal ACA substrate. My recommendation is **(A) SQLite via a mounted Azure Files volume**, with **(B) Postgres** as the fallback if a single-file store on a network volume is judged too fragile. Need your call:
  - **(A) Embedded SQLite on a mounted volume** (e.g. `better-sqlite3`). Pros: zero extra Azure service to run/pay for (just an Azure Files share mounted into the container), trivially models the ordered queue (autoincrement rowid = FIFO) + ack (DELETE by id) + TTL (WHERE expiresAt > now) + quota (COUNT/SUM), synchronous API → simplest code, fully hermetic tests (in-process / `:memory:` or a temp file). Cons: single-writer (fine — prod is single-replica), SQLite on a *network* file share (Azure Files = SMB) has known locking caveats; mitigated by single-replica + WAL, but it is the real risk. Native module (`better-sqlite3`) must compile in the `node:20-slim` image (needs build toolchain in the builder stage) — or use `node:sqlite` (Node 22+, **not** available on our Node 20 base) / a pure-JS engine.
  - **(B) Azure Database for PostgreSQL (flexible server, burstable B1ms).** Pros: a real ordered queue with robust concurrency (`SELECT … ORDER BY id`, `DELETE … RETURNING`, partial indexes for TTL), trivially correct multi-writer if we ever scale out, mature `pg` driver (pure JS, compiles cleanly). Cons: a standing managed service = monthly cost + an extra thing to provision/patch; heaviest operationally for a personal substrate.
  - **(C) Azure Table Storage.** Pros: cheapest managed option, durable, simple KV. Cons: **poor fit for the ack-able ordered queue** — no native FIFO ordering / atomic dequeue, TTL must be swept manually, byte-quota aggregation is awkward; it would fight the inbox's core semantics. (Azure *Queue* Storage has its own visibility-timeout model but does not give per-handle isolation or random-access ack-by-id cleanly.) **Not recommended** given the queue-with-ack requirement.
- [ ] **Seam shape for invites + credentials (architecture decision).** To persist invite + credential state we must externalize the private `Map`s now inside `InviteManager` / `CredentialManager`. Two shapes:
  - **(i) Two new store interfaces** (`InviteStore`, `CredentialStore`) alongside `InboxStore`/`RegistryStore`; the managers take a store and become thin logic-over-store (mirrors how `Relay` already depends only on interfaces). Cleanest, most consistent with the existing seam, but a larger refactor + injects the stores through `RelayDeps`.
  - **(ii) A single `RelayStateStore` facade** the durable backend implements once, persisting all non-inbox KV state together. Fewer moving parts, fewer interfaces, but coarser-grained and less aligned with the current one-interface-per-concern style.
  - My lean: **(i)** — it matches the established pattern and keeps each concern independently testable, which the 100%-coverage culture rewards.
- [ ] **Persist rate-limiter buckets?** Default recommendation **no** (a restart resetting the token-bucket window is safe — it only briefly *loosens* limits, never corrupts; persisting per-credential buckets adds write volume + a hot-path dependency for marginal benefit). Confirm you agree, or flag if you want buckets durable.
- [ ] **Single-replica assumption.** Is `ouro-prod-friends-relay` pinned to **one** replica (min=max=1)? The in-memory design already assumes single-writer-per-inbox. Option (A) SQLite *requires* effectively-single-writer; option (B) Postgres tolerates many. Confirm the replica count so the backend choice is sound.
- [ ] **Native-module tolerance.** Are you OK adding a backend with a **native** dependency (`better-sqlite3`) — i.e. the Docker build gains a compile toolchain in the builder stage — or do you prefer a **pure-JS** driver (which favors Postgres/`pg`, or a pure-JS SQLite like `sql.js` with its own tradeoffs)? This materially influences (A) vs (B).

## Decisions Made
- **The relay holds NO message-replay ledger** (confirmed by reading the source): replay dedup is entirely recipient-side (`SeenLedger` in the interop test stands in for the recipient agent, keyed on the seal nonce). The brief's "used-credential/replay state" maps, on the relay side, to **invite single-use/capped consumption** + **credential rotation/revocation bindings** — those are the only "use-once / revoke" state the relay owns. There is no relay-side replay state to persist. (This is a finding to confirm, not an assumption to bury.)
- **Additive, behind the seam.** In-memory backends stay the default + test backend; the durable backend is an adapter selected by env. The relay core (`relay.ts`) keeps depending only on interfaces and is not edited for backend choice (it may change only if we adopt seam-shape (i) for invites/credentials).
- **Planning-doc location**: this repo had no `docs/`/task-doc convention (only `README.md`), so I am establishing **`docs/planning/`** inside the repo as the task-doc home. (Flag if you'd rather they live elsewhere / outside the repo.)
- **No time estimates** (per planner discipline).

## Context / References

### State audit — what exists, where it lives, whether it's behind the seam
| State family | Where it lives today | Behind store seam? | Access pattern | Must persist? |
|---|---|---|---|---|
| **Registrations** (`handle → {card, did, pinned key, registeredAt}`) | `MemoryRegistryStore` (`src/store/memory.ts`) via `RegistryStore` (`src/store/interfaces.ts`) | **Yes** | Key-value, dual-index by handle + DID; put/get/get-by-did/remove; re-registration may re-point the DID index | **Yes** |
| **Inbox queues** (per-handle ordered queue of opaque sealed `A2AMessage`) | `MemoryInboxStore` (`src/store/memory.ts`) via `InboxStore` | **Yes** | **Ordered FIFO queue** + ack/delete by queueId + TTL prune + per-handle count & byte quota + cross-handle expiry sweep. **This is the discriminating requirement.** | **Yes** |
| **Invites** (`token → remaining uses`) | `InviteManager` private `Map` (`src/security/invites.ts`), constructed inside `Relay` | **No** | Key-value; issue (mint+set), consume (decrement, delete at 0) | **Yes** (else a minted invite is lost on restart; single-use enforcement resets) |
| **Credential bindings** (`inboxAuth → handle`, `sendCred → handle`, `handle → current pair`) | `CredentialManager` private `Map`s (`src/security/credentials.ts`), constructed inside `Relay` | **No** | Key-value, multi-index; rotate (revoke old + mint new), revoke, resolve-handle-for-auth, validate send | **Yes** (else every issued inboxAuth/sendCredential is invalidated on restart — all agents must re-register) |
| **Rate-limit buckets** (`sendCred → token bucket`) | `RateLimiter` private `Map` (`src/security/rate-limit.ts`), constructed inside `Relay` | **No** | Hot-path read/write per send; clock-driven refill | **Probably NOT** (ephemeral-by-design; restart resets the window safely — see Open Questions) |

### Key files
- `src/store/interfaces.ts` — the swappable seam (pure types; coverage-excluded). `InboxStore` + `RegistryStore`.
- `src/store/memory.ts` — reference in-memory backends (`MemoryInboxStore`, `MemoryRegistryStore`); the v1 + test default. `InboxBounds`.
- `src/relay.ts` — core; constructs `InviteManager`/`CredentialManager`/`RateLimiter` **internally** (lines ~83–87), depends on `InboxStore`/`RegistryStore` via `RelayDeps`.
- `src/server/bootstrap.ts` — `assembleRelay()`: **the single place** concrete backends are chosen (`overrides.inbox ?? new MemoryInboxStore(...)`, etc.). The durable adapter is selected here.
- `src/config.ts` — `loadConfig()` 12-factor env parsing, **fail-loud** on invalid combos; `RelayConfig`. New backend-selection env lands here.
- `src/security/invites.ts`, `src/security/credentials.ts`, `src/security/rate-limit.ts` — the not-yet-seamed managers.
- `src/security/tokens.ts` — `TokenSource` (injectable; `SequenceTokenSource` for deterministic tests).
- `src/clock.ts` — injectable `Clock` (`ManualClock` for deterministic TTL/refill tests).
- `src/types.ts` — `SealedBlob` / `FriendsDataPartPayload` / `A2AMessage` / `QueuedMessage` / `Registration`. Confirms the only readable field in a queued message is `recipientDid`; `sealed.{ePk,n,ct}` are base64 ciphertext.
- `src/message.ts` — `validateOpaqueMessage` (shape-only, never content) + `messageSizeBytes` (quota metadata).
- `src/__tests__/store.test.ts` — the behavioral contract the durable inbox/registry must also satisfy (good candidate to parametrize over backends).
- `src/__tests__/interop-a2a-client.test.ts` — the headline "relay only ever held ciphertext" proof against the real `@ouro.bot/friends/a2a-client`; the content-blind assertion pattern to replicate for the durable backend.
- `src/__tests__/relay.test.ts` — invite/credential/rotation/quota/TTL behavior at the core level.
- `vitest.config.ts` — v8 coverage, 100% thresholds, `interfaces.ts`/barrels/`bin.ts` excluded.
- `Dockerfile` — `node:20-slim`, two-stage build; a native module would need build deps in the `build` stage. (Node 20 → `node:sqlite` builtin is unavailable.)
- `.github/workflows/coverage.yml` — CI gate: typecheck + lint + `test:coverage`. No publish job. Tests must stay hermetic (no live Azure).

### Content-blind invariant — where persistence could weaken it (and why it won't)
- The only relay-visible field of a queued message is `recipientDid` (routing — unavoidable, already visible in v1). Everything in `sealed` is base64 ciphertext the relay has no key for.
- **Risk surface for the persistence layer:** (1) serializing the message — must store the `A2AMessage` opaquely (JSON blob / bytes), never destructure `sealed.ct` into a queryable column; (2) indexing — index only on `(handle, queueId, expiresAt)` and `recipientDid`, never on ciphertext; (3) logging — the durable adapter must follow the existing logger discipline (it logs handle/size/decision, **never** payload); (4) backups/telemetry of the backing store hold ciphertext only (same guarantee as v1 — worth a one-line note for the operator).
- A dedicated test will assert the persisted/round-tripped inbox row contains only the opaque blob (no plaintext join-key / note / `friendsKind` / sender DID), mirroring `interop-a2a-client.test.ts`'s existing assertion but against the durable backend.

## Notes
Scratchpad (implementation specifics will move into the doing doc on conversion):
- Likely inbox schema (SQLite path): `inbox(handle TEXT, queue_id TEXT PRIMARY KEY, message_json TEXT, enqueued_at INTEGER, expires_at INTEGER, size_bytes INTEGER)`, plus index `(handle, expires_at)`. FIFO = `ORDER BY rowid`. queueId can stay relay-assigned (`q{seq}`) but the seq must become durable/monotonic across restart (per-handle or global) — a detail for the doing doc.
- `dropExpired` / quota math map to `DELETE … WHERE expires_at <= ?` and `SELECT COUNT(*), COALESCE(SUM(size_bytes),0)`.
- `store.test.ts` is written against concrete `Memory*` classes; converting it (or adding a sibling) to run the **same** assertions over both backends is the cleanest way to guarantee semantic parity + coverage. Decide in conversion whether to parametrize or duplicate.
- If seam-shape (i) is chosen, `RelayDeps` grows `invites`/`credentials` stores and `Relay` stops `new`-ing the managers — touches `relay.ts` + `bootstrap.ts` + the relay tests' `makeRelay` helper.
- Whatever backend wins, keep an in-process/temp-file mode so the durable adapter's own unit tests need no network and no Azure.

## Progress Log
- 2026-06-22 08:14 Created — investigated relay source (store interfaces, in-memory backends, security managers, relay core, config, bootstrap, http, tests, Dockerfile, CI). Enumerated the 5 state families, confirmed no relay-side replay ledger, identified the seam gap (invites + credentials not behind interfaces), captured the content-blind risk surface, and framed the backend choice as the central open question.
- 2026-06-22 08:16 Committed initial draft. Status: NEEDS_REVIEW — awaiting answers to the 5 open questions (backend choice, seam shape, rate-limiter persistence, replica count, native-module tolerance) before refining.
