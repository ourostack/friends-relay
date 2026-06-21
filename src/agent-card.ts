// agent-card — the relay's OWN A2A agent card (fork 14: the relay is itself an A2A
// agent, with a card + DID, so an agent can verify it reached the EXPECTED relay —
// TLS cert + the relay's DID — even though no one trusts the relay with content).
// The relay advertises NO content capability beyond enqueue/dequeue; it asserts no
// transport security scheme here (the E2E overlay is the real security; the relay's
// bearer scheme is deploy/host config).
import type { RelayAgentCard } from "./types"

export interface BuildRelayCardInput {
  /** The relay's public base URL (its A2A service endpoint). Injected config. */
  url: string
  /** The relay's own DID (did:key / did:web). Injected config. */
  did: string
  /** The relay's version string. */
  version: string
  /** The A2A protocol version it speaks. */
  protocolVersion: string
  /** Optional human name (defaults to a generic label — no operator/infra ref). */
  name?: string
}

/** Build the relay's A2A agent card. */
export function buildRelayAgentCard(input: BuildRelayCardInput): RelayAgentCard {
  return {
    name: input.name ?? "friends-relay",
    description:
      "A content-blind, abuse-resistant A2A relay + directory for friends-using agents. " +
      "Store-and-forward of sealed ciphertext for offline/NAT'd peers — it carries opaque " +
      "envelopes and can never read, forge, tamper, re-target, replay-to-effect, or escalate.",
    url: input.url,
    version: input.version,
    protocolVersion: input.protocolVersion,
    did: input.did,
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {},
    security: [],
  }
}
