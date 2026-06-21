// message — opaque A2A message validation + sizing. The relay validates that an
// inbound message is well-formed A2A with exactly one relay-blind DataPart, extracts
// ONLY the routing `recipientDid`, and measures its size — WITHOUT ever reading the
// sealed ciphertext. This mirrors a2a-client's `unwrapDataPart` validation so a
// message the real client emits passes, and a malformed one is refused at the door.
import type { A2AMessage, FriendsDataPartPayload, SealedBlob } from "./types"

/** Validate the opaque A2A message shape. Returns the routing payload (recipientDid
 * + the opaque sealed blob) on success, or null on ANY malformed shape. The relay
 * reads `recipientDid` (routing) and treats `sealed` as an opaque blob it never
 * decodes. */
export function validateOpaqueMessage(msg: unknown): FriendsDataPartPayload | null {
  if (!msg || typeof msg !== "object") return null
  const m = msg as Partial<A2AMessage>
  if (typeof m.messageId !== "string" || m.messageId.length === 0) return null
  if (m.role !== "agent") return null
  if (!Array.isArray(m.parts) || m.parts.length !== 1) return null
  const part = m.parts[0]
  if (!part || typeof part !== "object" || part.kind !== "data") return null
  const data = (part as { data?: unknown }).data
  if (!data || typeof data !== "object") return null
  const d = data as Partial<FriendsDataPartPayload>
  if (typeof d.recipientDid !== "string" || d.recipientDid.length === 0) return null
  if (typeof d.v !== "number") return null
  if (!isSealedBlob(d.sealed)) return null
  return { v: d.v, sealed: d.sealed, recipientDid: d.recipientDid }
}

/** Structural check of the opaque sealed blob — that the four base64 fields are
 * present and string/number-typed. The relay NEVER decodes or decrypts them; it
 * only confirms the envelope is shaped like ciphertext, not that it can read it. */
function isSealedBlob(value: unknown): value is SealedBlob {
  if (!value || typeof value !== "object") return false
  const b = value as Record<string, unknown>
  return (
    typeof b.v === "number" &&
    typeof b.ePk === "string" &&
    typeof b.n === "string" &&
    typeof b.ct === "string"
  )
}

/** The serialized byte size of an opaque message (for quota accounting — legitimate
 * metadata the relay sees). */
export function messageSizeBytes(msg: A2AMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8")
}
