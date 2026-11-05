// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server-side gate on what a client-job payload may contain.
//
// A client job exists because the server may no longer read a body. Every
// enqueue therefore passes through here, on the HOST side of the sandbox
// boundary, so a compromised or merely careless app bundle cannot widen the
// queue into a plaintext side channel. The mail bundle also builds its payloads
// from an allowlist; this is the check that does not depend on it doing so.
//
// The rule is not "no plaintext", which is unenforceable. It is narrower and
// checkable: no key whose NAME says content, no string long enough to be a
// body, and a small total size. Envelope facts (addresses, labels, filenames,
// ids, dates, counts) all fit comfortably inside those bounds.

/** Key names that mean "this is content", normalised to letters only. */
const FORBIDDEN_KEYS = new Set([
  "subject",
  "snippet",
  "body",
  "textbody",
  "htmlbody",
  "bodytext",
  "bodyhtml",
  "text",
  "html",
  "excerpt",
  "preview",
  "plaintext",
  "content",
  "quote",
  "summary",
  "message",
  "messagebody",
])

/** Long enough for a filename, a subject-length header or a long address list,
 *  short enough that no body or excerpt survives the check. */
export const MAX_PAYLOAD_STRING_LENGTH = 512

/** The whole payload, serialised. An envelope description does not need more. */
export const MAX_PAYLOAD_BYTES = 16 * 1024

const MAX_DEPTH = 6

export class EnvelopePayloadError extends Error {
  constructor(message: string) {
    super(`mailbox client job payload rejected: ${message}`)
    this.name = "EnvelopePayloadError"
  }
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "")
}

function walk(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new EnvelopePayloadError(`nested too deeply at ${path}`)
  }
  if (value === null || value === undefined) return
  if (typeof value === "string") {
    if (value.length > MAX_PAYLOAD_STRING_LENGTH) {
      throw new EnvelopePayloadError(
        `the string at ${path} is ${value.length} characters, the cap is ${MAX_PAYLOAD_STRING_LENGTH}`,
      )
    }
    return
  }
  if (typeof value === "number" || typeof value === "boolean") return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1)
    return
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(normaliseKey(key))) {
        throw new EnvelopePayloadError(
          `"${key}" at ${path} names message content, and only envelope fields may be queued`,
        )
      }
      walk(nested, `${path}.${key}`, depth + 1)
    }
    return
  }
  throw new EnvelopePayloadError(
    `the value at ${path} is a ${typeof value}, which is not JSON data`,
  )
}

/**
 * Throw unless `payload` is envelope-shaped. Returns the serialised form, so a
 * caller writing it to `jsonb` does not serialise twice.
 */
export function assertEnvelopeOnlyPayload(payload: unknown): string {
  walk(payload, "payload", 0)
  const serialised = JSON.stringify(payload ?? {})
  const size = Buffer.byteLength(serialised, "utf8")
  if (size > MAX_PAYLOAD_BYTES) {
    throw new EnvelopePayloadError(`the payload is ${size} bytes, the cap is ${MAX_PAYLOAD_BYTES}`)
  }
  return serialised
}
