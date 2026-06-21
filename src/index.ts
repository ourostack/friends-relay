// @ouro.bot/friends-relay — a content-blind, abuse-resistant A2A relay + directory
// for friends-using agents. The relay does store-and-forward of CIPHERTEXT: an
// offline/NAT'd recipient's sealed envelopes are queued; it pulls them (A2A
// tasks/list-style) or is webhook-pushed. The relay carries the SealedEnvelope
// OPAQUELY — it can never read, forge, tamper, re-target, replay-to-effect, or
// escalate (those are defeated client-side by @ouro.bot/friends/a2a-client's
// sign-then-seal overlay, which the relay does not — cannot — weaken).
//
// This barrel exposes the relay core + its assembly + the HTTP surface so a host can
// embed the relay. The thin HTTP CLIENT a friends-using agent imports lives at
// @ouro.bot/friends-relay/client.

// ── core ──
export { Relay } from "./relay"
export type { RelayDeps, RegisterInput, EnqueueInput, RegisterError, EnqueueError, InboxError } from "./relay"

// ── config ──
export { loadConfig } from "./config"
export type { RelayConfig, InvitePolicy } from "./config"

// ── the relay's own A2A card ──
export { buildRelayAgentCard } from "./agent-card"
export type { BuildRelayCardInput } from "./agent-card"

// ── opaque-message validation ──
export { validateOpaqueMessage, messageSizeBytes } from "./message"

// ── storage (swappable backend seam) ──
export type { InboxStore, RegistryStore, EnqueueResult } from "./store/interfaces"
export { MemoryInboxStore, MemoryRegistryStore } from "./store/memory"
export type { InboxBounds } from "./store/memory"

// ── security primitives ──
export { RateLimiter } from "./security/rate-limit"
export type { RateLimitConfig } from "./security/rate-limit"
export { InviteManager } from "./security/invites"
export { CredentialManager } from "./security/credentials"
export { cryptoTokenSource, SequenceTokenSource } from "./security/tokens"
export type { TokenSource } from "./security/tokens"

// ── clock + logger seams ──
export { systemClock, ManualClock } from "./clock"
export type { Clock } from "./clock"
export { silentLogger, MemoryLogger } from "./logger"
export type { Logger, LogLevel, LogFields } from "./logger"

// ── HTTP surface + assembly ──
export { handle, createServer, parseBearer, toRelayRequest } from "./server/http"
export type { RelayRequest, RelayResponse } from "./server/http"
export { assembleRelay } from "./server/bootstrap"
export type { AssembleOverrides } from "./server/bootstrap"

// ── shared types ──
export type {
  A2AMessage,
  A2ADataPart,
  FriendsDataPartPayload,
  SealedBlob,
  PublicAgentCard,
  QueuedMessage,
  Registration,
  RegistrationGrant,
  RelayAgentCard,
} from "./types"
