// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The fingerprint of an approval's payload: what the human saw is what runs.
 *
 * The approval card shows `current_payload`, and a requesting agent (or an injected turn) may edit
 * the editable fields of a pending request (`approvals/edit.ts`) after the card is rendered. A
 * decision therefore carries the hash of the payload it was made on, and an approve whose hash no
 * longer matches the stored payload is refused (409 `payload_changed`) before anything is claimed
 * or run. The card then reloads and shows the new payload for a fresh decision.
 *
 * The hash covers the tool name and the canonical JSON of the payload (keys sorted), so key order
 * and jsonb round-tripping never change it. It is a fingerprint for change detection, not a secret.
 */
import { createHash } from "node:crypto"

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
}

/** A stored payload is an object, or a JSON string of one when the driver round-trips jsonb as text. */
function asPayloadObject(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function approvalPayloadHash(toolName: string, currentPayload: unknown): string {
  const payload = asPayloadObject(currentPayload)
  return createHash("sha256")
    .update(`${toolName}\n${canonical(payload)}`)
    .digest("hex")
}
