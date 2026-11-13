// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * RFC 2047 header encoding for outbound MIME messages.
 *
 * RFC 5322 headers are 7-bit ASCII. A raw UTF-8 subject ("accès") sent without
 * SMTPUTF8 is read as Latin-1 somewhere downstream and arrives as "accÃ¨s",
 * so any header value or display name containing non-ASCII goes out as
 * `=?UTF-8?B?...?=` encoded words. Plain ASCII values pass through unchanged.
 *
 * Used by the mail handlers (apps/api/src/apps/mail/handlers.ts) and the
 * shared RFC 2822 encoder.
 */

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// 39 bytes → 52 base64 chars → a 64-char encoded word, so even the first line
// ("Subject: " + word) stays under RFC 2047's 76-char line limit, and every
// word stays well under its 75-char cap.
const MAX_ENCODED_WORD_BYTES = 39

/** Strip CR/LF (header injection) and trim, exactly as the builders always did. */
export function sanitizeHeaderValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

function codePointUtf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) return [codePoint]
  if (codePoint < 0x800) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 63)]
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 63), 0x80 | (codePoint & 63)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 63),
    0x80 | ((codePoint >> 6) & 63),
    0x80 | (codePoint & 63),
  ]
}

function base64Bytes(bytes: number[]): string {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index] ?? 0
    const byte2 = bytes[index + 1] ?? 0
    const byte3 = bytes[index + 2] ?? 0
    const triplet = (byte1 << 16) | (byte2 << 8) | byte3
    output += BASE64_CHARS[(triplet >> 18) & 63]
    output += BASE64_CHARS[(triplet >> 12) & 63]
    output += index + 1 < bytes.length ? BASE64_CHARS[(triplet >> 6) & 63] : "="
    output += index + 2 < bytes.length ? BASE64_CHARS[triplet & 63] : "="
  }
  return output
}

function isAsciiHeaderText(value: string): boolean {
  return !/[\u0080-\uffff]/.test(value)
}

/**
 * Encode an already-sanitized string as RFC 2047 B encoded words, never
 * splitting a UTF-8 sequence across words, folded with CRLF + space.
 */
function toEncodedWords(value: string): string {
  const words: string[] = []
  let chunk: number[] = []
  for (const char of value) {
    const bytes = codePointUtf8Bytes(char.codePointAt(0) ?? 0)
    if (chunk.length > 0 && chunk.length + bytes.length > MAX_ENCODED_WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64Bytes(chunk)}?=`)
      chunk = []
    }
    chunk.push(...bytes)
  }
  if (chunk.length > 0) words.push(`=?UTF-8?B?${base64Bytes(chunk)}?=`)
  return words.join("\r\n ")
}

/**
 * An unstructured header value (Subject): CR/LF stripped, then RFC 2047
 * encoded only when it holds non-ASCII. ASCII values are returned as-is.
 */
export function encodeHeaderValue(value: unknown): string {
  const sanitized = sanitizeHeaderValue(value)
  if (isAsciiHeaderText(sanitized)) return sanitized
  return toEncodedWords(sanitized)
}

/**
 * A mailbox display name: RFC 2047 when non-ASCII, a quoted-string when it
 * holds RFC 5322 specials (a period is allowed bare, as obs-phrase permits), otherwise the bare name.
 */
export function encodeDisplayName(name: unknown): string {
  const sanitized = sanitizeHeaderValue(name)
  if (!isAsciiHeaderText(sanitized)) return toEncodedWords(sanitized)
  if (/[()<>[\]:;@\\,"]/.test(sanitized)) {
    return `"${sanitized.replace(/[\\"]/g, "\\$&")}"`
  }
  return sanitized
}

/** `Name <addr>` (or the bare addr-spec when there is no name). The addr-spec is never encoded. */
export function formatMailbox(name: unknown, email: unknown): string {
  const address = sanitizeHeaderValue(email)
  const display = sanitizeHeaderValue(name)
  if (!display) return address
  return `${encodeDisplayName(display)} <${address}>`
}

/**
 * A pre-formatted address string ("Élodie <e@x.test>"). ASCII strings pass
 * through unchanged; a non-ASCII display name in the `name <addr>` form is
 * re-encoded. Anything else is returned sanitized (a non-ASCII addr-spec needs
 * SMTPUTF8 and cannot be fixed by header encoding).
 */
export function encodeAddressString(value: unknown): string {
  const sanitized = sanitizeHeaderValue(value)
  if (isAsciiHeaderText(sanitized)) return sanitized
  const match = /^(.*?)\s*<([^<>\s]+)>$/.exec(sanitized)
  if (!match) return sanitized
  const name = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1")
  return formatMailbox(name, match[2])
}
