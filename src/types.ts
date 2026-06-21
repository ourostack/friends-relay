// types — the relay's data model. The defining property: the relay carries an A2A
// message OPAQUELY. It models the message's STRUCTURE (so it can validate the
// envelope is well-formed A2A and route by recipient) but it NEVER reaches into
// the sealed ciphertext. `friendsKind`, the sender DID, the signature, and the
// payload all live INSIDE `sealed.ct` (sign-then-seal, client-side) — the relay
// has no key and no code path to read any of it.
//
// These shapes mirror `@ouro.bot/friends/a2a-client`'s on-the-wire types exactly,
// so a message the real a2a-client emits round-trips through the relay unchanged.

/** The opaque sealed blob the relay carries. Every field is base64 CIPHERTEXT (or
 * a public ephemeral key) — none of it is readable without the recipient's private
 * key, which the relay does not have. Mirrors a2a-client `SealedBlob`. */
export interface SealedBlob {
  /** Overlay version (bound into the AEAD AD client-side). */
  v: number
  /** The sender's ephemeral X25519 public key (base64). Public, but useless alone. */
  ePk: string
  /** The AEAD nonce (base64). Also the recipient-side replay-dedup key. */
  n: string
  /** The AEAD ciphertext+tag (base64). The relay can NEVER decrypt this. */
  ct: string
}

/** The relay-blind DataPart payload. `recipientDid` is the routing target (the
 * relay sees the recipient regardless — unavoidable). Nothing else is readable. */
export interface FriendsDataPartPayload {
  v: number
  sealed: SealedBlob
  recipientDid: string
}

/** An A2A Part — the relay only ever carries the `data` kind. */
export interface A2ADataPart {
  kind: "data"
  data: FriendsDataPartPayload
}

/** An A2A Message carrying exactly one friends DataPart. The relay treats this as
 * an opaque unit: it validates the shape, routes by the DataPart's recipientDid,
 * and forwards it byte-for-byte. */
export interface A2AMessage {
  messageId: string
  role: "agent"
  parts: A2ADataPart[]
}

/** A public A2A agent card (the registrant's card — public-by-design in A2A). The
 * relay stores and serves it in the directory; it never inspects its meaning. The
 * shape is permissive on purpose (the relay is not the card's schema authority). */
export interface PublicAgentCard {
  name: string
  url: string
  version: string
  protocolVersion: string
  did: string
  [key: string]: unknown
}

/** A queued message in a handle's inbox. The relay holds it until acked or expired,
 * then DROPS it (not a content store). It is content-blind: `message` is opaque. */
export interface QueuedMessage {
  /** A relay-assigned queue id (for ack/get). Distinct from the A2A messageId. */
  queueId: string
  /** The opaque A2A message (ciphertext + routing only). */
  message: A2AMessage
  /** When it was enqueued (ms epoch) — for TTL. */
  enqueuedAt: number
  /** When it expires and becomes droppable (ms epoch). */
  expiresAt: number
  /** Serialized size in bytes — metadata the relay legitimately sees (quota). */
  sizeBytes: number
}

/** A registration record. The relay knows handle → {card, did, pinned key, auth}.
 * It knows NOTHING about the social graph (not a graph-holder). */
export interface Registration {
  /** The opaque relay handle (the routing alias; need not equal the DID). */
  handle: string
  /** The registrant's DID (== its agentId in the friends model). */
  did: string
  /** The registrant's public agent card (directory). */
  agentCard: PublicAgentCard
  /** The recipient's X25519 keyAgreement public key (base64), pinned for discovery.
   * Optional — a directory consumer may also read it from the card/DID. */
  keyAgreementPubKey?: string
  /** When the handle was registered (ms epoch). */
  registeredAt: number
}

/** The result of a successful registration handed back to the registrant. */
export interface RegistrationGrant {
  handle: string
  /** Bearer token to DRAIN this handle's inbox (pull). Rotated on re-registration. */
  inboxAuth: string
  /** The SEND credential other agents present to post to this handle. Rotating by
   * default — minimizes the relay's ability to link a sender's full out-graph. */
  sendCredential: string
}

/** The relay's own A2A agent card (it is itself an A2A agent). */
export interface RelayAgentCard {
  name: string
  description: string
  url: string
  version: string
  protocolVersion: string
  did: string
  capabilities: { streaming: boolean; pushNotifications: boolean }
  /** No transport security scheme is asserted here — the E2E overlay is the real
   * security; transport authn (the relay's bearer scheme) is host/deploy config. */
  securitySchemes: Record<string, never>
  security: never[]
}
