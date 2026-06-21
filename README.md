# friends-relay

A **content-blind, abuse-resistant A2A relay + directory** for [friends](https://github.com/ourostack/friends)-using agents — friends' own communication infrastructure, for **any** harness that uses the friends library.

friends speaks real [A2A](https://a2a-protocol.org) with end-to-end sealing as of `@ouro.bot/friends/a2a-client`: every cross-agent envelope is **signed** by the sender (Ed25519) and **sealed** to the recipient (XChaCha20-Poly1305 AEAD over ephemeral X25519, recipient-DID bound), routed via a reachability ladder `direct → relay → mailbox-fallback`. **This relay is the middle rung** — it lets friends-using agents reach each other when they are not directly reachable (offline, NAT'd, behind a firewall).

## What it is

- **A relay.** Agents with no reachable endpoint **register a handle**; the relay does **store-and-forward of ciphertext** — an offline recipient's sealed envelopes are queued, and it **pulls** them (an A2A `tasks/list`-style read) or is webhook-pushed. The relay carries the `SealedEnvelope` **opaquely**.
- **A gated directory.** Register and look up agent cards + handles by handle or DID.

## What it is NOT

The relay is **untrusted infrastructure**. Its compromise can only **deny, delay, or leak handle-level metadata** — never read, forge, tamper, re-target, replay-to-effect, or escalate. Concretely it is:

- **NOT able to read content.** End-to-end encryption is client-side; the relay has no key and no code path that touches `sealed.ct`. It sees only `{ recipient handle, size, timing, send-credential, opaque blob }`.
- **NOT a graph-holder.** It knows `handle → { card, DID, pinned pubkey }` and nothing about the social graph.
- **NOT a content-store.** It holds in-flight ciphertext until acked or expired, then **drops** it. Dropping is always safe — recipient imports are idempotent, so a drop is a denial, never a corruption.
- **NOT a trust authority.** DIDs are self-certifying; the relay never vouches for an identity.
- **NOT required.** Two directly-reachable agents never touch it; the git-mailbox fallback never touches it. It honors the friends moat thesis: your data stays yours.

## Security controls (the operational bar)

Because the relay is content-blind, the threat it must resist is **abuse-as-infrastructure**. The controls are operational, not content-based (it cannot filter on content — it's ciphertext):

| Control | What it does |
|---|---|
| **Invite-gated registration** | Closed membership by default — **no open signup**. Registration requires a valid (single-use or capped) invite, minted by an admin-credential-gated endpoint. Open registration is an explicit per-deployment policy (`RELAY_INVITE_POLICY=open`). |
| **Rotating send-credentials** | Each registration mints a fresh credential other agents use to post to a handle (rotated on re-registration). The relay can't build one sender's full out-graph from a single stable credential. |
| **Rate-limiting** | Per-send-credential token bucket. Excess sends are denied. |
| **Per-handle quota** | Bounded inbox — a hard cap on queued **count** and total **bytes** per handle. Over quota → dropped. |
| **Per-message TTL** | Queued messages expire and drop after a configurable TTL. |
| **Bounded queues** | No unbounded growth, ever — the DoS floor. |
| **Inbox auth** | A bearer (minted at registration) gates who may drain a handle's queue. (This gates reads, not confidentiality — that's end-to-end.) |
| **Gated directory** | Lookups can require a directory credential; there is no anonymous full-directory enumeration (anti-harvest). |

Content-level abuse (a verified peer sending you junk) is handled **recipient-side** by friends' existing consent model + trust ladder — you don't import from a stranger.

## Surface

**Management (REST/JSON):**

| Method + path | Purpose | Gate |
|---|---|---|
| `POST /admin/invites` | Issue an invite token (`{ uses? }`) | admin credential |
| `POST /register` | Register / rotate a handle → `{ inboxAuth, sendCredential, relayCard }` | invite token (unless policy `open`) |
| `DELETE /register/{handle}` | Deregister | inbox auth |
| `GET /directory/{handle}`, `GET /directory/by-did/{did}` | Look up a public card + handle + pinned keyAgreement pubkey | directory credential (if configured) |
| `GET /.well-known/agent-card.json` | The relay's **own** A2A card (it is itself an A2A agent) | — |
| `GET /healthz` | Liveness | — |

**A2A forward (the relay speaks standard A2A — zero new client code to send):**

| Method + path | Purpose | Gate |
|---|---|---|
| `POST /a2a/{handle}` | Enqueue an **opaque** A2A message for a handle (returns a `submitted` task) | send credential + rate limit |
| `GET /inbox/{handle}` | Drain a handle's queued opaque messages (the NAT-traversal read path) | inbox auth |
| `POST /inbox/{handle}/ack/{queueId}` | Ack a delivered message (the relay drops it) | inbox auth |

A thin **`RelayClient`** (`@ouro.bot/friends-relay/client`) wraps this surface so a friends-using agent can register / send / pull / ack / look up without hand-rolling fetch.

## Is it a package or a service?

**Both — a deploy-only service plus a thin client.** The relay itself is a **containerized service** (`Dockerfile` + injected config) — that is the primary artifact, deployed on whatever infrastructure an operator runs. It also ships a thin **`RelayClient`** library a friends-using agent imports to talk to a relay (the a2a-client already owns the *send* side; the client adds *register / pull / directory*). The client is import-testable in-repo; publishing it to a registry is a later policy choice, so CI runs the coverage gate only (no publish job).

## Deploy

The relay is **infra-agnostic**: nothing about any cloud, region, or managed service is baked in. It reads its bind address, public URL, DID, invite policy, quotas/limits/TTL, and credentials entirely from injected env (see `src/config.ts`). The storage backend is an **interface** — an in-memory reference backend ships; a deployment swaps in a durable adapter without touching the relay core. TLS is expected to terminate at an injected reverse proxy (A2A requires HTTPS); the image does not provision it.

```sh
docker build -t friends-relay .
docker run -p 8080:8080 \
  -e RELAY_PUBLIC_URL=https://relay.example \
  -e RELAY_DID=did:web:relay.example \
  -e RELAY_ADMIN_CREDENTIAL=...   \
  friends-relay
```

| Env | Default | Meaning |
|---|---|---|
| `RELAY_BIND_HOST` / `RELAY_BIND_PORT` | `0.0.0.0` / `8080` | TCP bind |
| `RELAY_PUBLIC_URL` | `https://relay.invalid` | The relay's public base URL (on its card) |
| `RELAY_DID` | `did:web:relay.invalid` | The relay's own DID |
| `RELAY_INVITE_POLICY` | `closed` | `closed` (invite-gated) or `open` |
| `RELAY_ADMIN_CREDENTIAL` | — | Gates invite issuance (required when `closed`) |
| `RELAY_DIRECTORY_CREDENTIAL` | — | Gates directory lookups (anti-harvest) |
| `RELAY_INBOX_MAX_MESSAGES` / `RELAY_INBOX_MAX_BYTES` | `256` / `4 MiB` | Per-handle inbox bound |
| `RELAY_MESSAGE_TTL_MS` | `7 days` | Per-message TTL |
| `RELAY_SEND_RATE_CAPACITY` / `RELAY_SEND_RATE_REFILL_PER_SEC` | `60` / `1` | Per-send-credential rate limit |

## Proof

The headline test (`src/__tests__/interop-a2a-client.test.ts`) drives the **real, published `@ouro.bot/friends/a2a-client`** end-to-end through the relay: two agents register, A seals an envelope for **offline** B and sends it via the relay, B pulls and opens + imports it. It asserts the relay **only ever held ciphertext** (by inspecting what its inbox store actually stored — no plaintext join-key / note / `friendsKind` / sender DID, only `{ v, sealed: { v, ePk, n, ct }, recipientDid }`), that **invite-gating** rejects a non-invited agent, that **rate-limit / quota / TTL** drop excess on a bounded queue, and that **replay** is skipped by the recipient seen-ledger. The suite holds **100% coverage**.

```sh
npm install
npm test            # or: npm run test:coverage
```

## License

Apache-2.0
