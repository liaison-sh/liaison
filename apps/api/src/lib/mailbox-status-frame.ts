// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The inbound `{ type: "status", scope: "mailbox" }` socket frame (blueprint
// Task 9.4, spec section 6.2, correction C7).
//
// Extracted from the socket handler so it can be tested on its own: a malformed
// frame from a client must be IGNORED, never fatal, and "ignored" is a property
// worth pinning with a test rather than an inline `if` nobody can drive.
//
// The frame carries an ASSERTION, not a fact. It says "this tab believes it holds
// an unlocked mailbox". The server stores it with a TTL and uses it for exactly
// one decision: whether it is worth ASKING the client to decrypt. Every real
// check (turn nonce, id scope, caps) happens in the browser, where the key is.

import type { MailboxUnlockEntry } from "~/infra/websocket-state/types"

/**
 * How long one assertion is trusted before the client must re-assert. Short
 * enough that a closed tab stops vouching quickly, long enough that a client
 * asserting on unlock plus on its existing ping cadence keeps it fresh.
 */
export const MAILBOX_UNLOCK_TTL_MS = 90_000

/** Key ids are a small keyring, not a channel: cap the list rather than store it. */
const MAX_KEY_IDS = 64
/** Open turns per client: a handful at most (each chat, a Run now, a job). */
const MAX_TURNS = 16

/**
 * Returns the entry to store, or null when the frame is not a mailbox status
 * frame or is malformed. Never throws.
 */
export function parseMailboxStatusFrame(
  data: unknown,
  now: number = Date.now(),
): MailboxUnlockEntry | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const frame = data as Record<string, unknown>
  if (frame.type !== "status" || frame.scope !== "mailbox") return null
  if (typeof frame.unlocked !== "boolean") return null
  const rawKeyIds = Array.isArray(frame.keyIds) ? frame.keyIds : []
  const keyIds = rawKeyIds
    .filter((k): k is number => typeof k === "number" && Number.isInteger(k))
    .slice(0, MAX_KEY_IDS)
  const entry: MailboxUnlockEntry = {
    unlocked: frame.unlocked,
    keyIds,
    expiresAt: now + MAILBOX_UNLOCK_TTL_MS,
  }
  // Only a client that sends the list can be read as "owns none of them".
  if (Array.isArray(frame.turns)) {
    entry.turns = frame.turns
      .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 128)
      .slice(0, MAX_TURNS)
  }
  return entry
}
