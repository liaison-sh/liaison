// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure base64 encoder for the QuickJS sandbox.
//
// The bundle runs inside QuickJS, which provides NEITHER `btoa` NOR
// `Buffer` — so `btoa(\`${key}:${secret}\`)` (used for HTTP Basic auth on the
// Boxtal v1/v3 clients) throws `btoa is not defined` at runtime, before any
// fetch. This pure encoder has no host dependency: it UTF-8-encodes the input
// and maps every 3-byte group to 4 base64 chars (with `=` padding). API keys
// are ASCII, but the UTF-8 step keeps it correct for any input.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** UTF-8 byte sequence for a string, without TextEncoder (QuickJS-safe). */
function utf8Bytes(str: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — combine with the following low surrogate.
      const hi = code
      const lo = str.charCodeAt(++i)
      code = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

/** Encode a string to standard base64 (with `=` padding). QuickJS-safe. */
export function base64Encode(input: string): string {
  const bytes = utf8Bytes(input)
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += ALPHABET[(triple >> 18) & 0x3f]
    out += ALPHABET[(triple >> 12) & 0x3f]
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : "="
    out += i + 2 < bytes.length ? ALPHABET[triple & 0x3f] : "="
  }
  return out
}
