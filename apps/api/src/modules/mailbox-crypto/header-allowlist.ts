// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which mail headers may stay in cleartext (spec section 5.2, normative).
//
// Ingest builds a full lowercased header map and used to persist all of it,
// which includes `subject`, `thread-topic`, `list-*` and every `x-*` header a
// sender chose to attach. That is content. For a mailbox under the encryption
// regime only the headers below survive in `raw_headers`; everything else is
// sealed into `raw_headers_ciphertext` under `mail.message:headers:<messageId>`.
//
// Every entry is justified by an existing consumer: threading and dedup
// (`message-id`, `in-reply-to`, `references`), envelope display and contact
// linking (`from`, `to`, `cc`, `bcc`, `date`, `return-path`, `delivered-to`),
// MIME handling (`content-*`), and list/auto-reply suppression (`list-*`,
// `auto-submitted`, `precedence`). Anything not listed is encrypted by default.
// Extending this list is a spec change, not an implementation decision.
//
// The Invariant P trigger carries the SAME list as literal SQL, because a
// manifest trigger body is a JSON string that can import nothing.
// `header-allowlist.test.ts` parses the trigger body and asserts the two agree;
// it is the only thing preventing a drift that would either raise on every
// ingest or leave content in cleartext.

export const MAIL_HEADER_ALLOWLIST = [
  "message-id",
  "in-reply-to",
  "references",
  "date",
  "from",
  "to",
  "cc",
  "bcc",
  "return-path",
  "delivered-to",
  "content-type",
  "content-transfer-encoding",
  "list-unsubscribe",
  "list-id",
  "auto-submitted",
  "precedence",
] as const

export type MailAllowlistedHeader = (typeof MAIL_HEADER_ALLOWLIST)[number]

const ALLOWED = new Set<string>(MAIL_HEADER_ALLOWLIST)

export interface SplitMailHeaders {
  /** Stays in `raw_headers`, lowercased. */
  retained: Record<string, string>
  /** Goes into `raw_headers_ciphertext`, lowercased. */
  sealed: Record<string, string>
}

/**
 * Partition a header map into the cleartext half and the sealed half.
 *
 * Names are lowercased on the way through: the trigger compares against a
 * lowercase list, and a provider that sends `Subject` rather than `subject`
 * must not be able to smuggle a header past either side by its casing.
 */
export function splitMailHeaders(headers: Record<string, unknown>): SplitMailHeaders {
  const retained: Record<string, string> = {}
  const sealed: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    const text = typeof value === "string" ? value : JSON.stringify(value)
    if (ALLOWED.has(name)) retained[name] = text
    else sealed[name] = text
  }
  return { retained, sealed }
}
