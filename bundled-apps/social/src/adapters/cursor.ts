// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Opaque cursor pack/parse. Platform pagination tokens (IG `after`, YouTube
// `pageToken`) are stored verbatim in sync_state.cursor; for compound cursors
// (e.g. YouTube publishedAfter) we base64-encode a small JSON object so the
// watermark round-trips through a single string column.
//
// This module is bundled INTO the QuickJS sandbox, which has NO `Buffer`,
// `btoa`/`atob`, or typed-array globals (they are hardened away). The base64
// codec below is therefore a self-contained pure-JS implementation over UTF-8
// bytes — no host globals. (Unit-tested in cursor.test.ts.)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const B64_INV: Record<string, number> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < B64.length; i++) m[B64.charAt(i)] = i
  return m
})()

/** Encode a string's UTF-8 bytes to base64 (no Buffer / btoa). */
function base64Encode(input: string): string {
  // UTF-8 encode → byte array.
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      // Surrogate pair → single code point.
      const hi = code
      const lo = input.charCodeAt(++i)
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
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    out += B64.charAt(b0 >> 2)
    out += B64.charAt(((b0 & 0x03) << 4) | (b1 >> 4))
    out += has1 ? B64.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : "="
    out += has2 ? B64.charAt(b2 & 0x3f) : "="
  }
  return out
}

/** Decode base64 to a UTF-8 string (no Buffer / atob). */
function base64Decode(input: string): string {
  const clean = input.replace(/=+$/, "")
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B64_INV[clean.charAt(i)]
    if (v === undefined) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  // UTF-8 decode.
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i++] ?? 0
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] ?? 0
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f))
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] ?? 0
      const b2 = bytes[i++] ?? 0
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f))
    } else {
      const b1 = bytes[i++] ?? 0
      const b2 = bytes[i++] ?? 0
      const b3 = bytes[i++] ?? 0
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    }
  }
  return out
}

export function packCursor(value: Record<string, unknown> | string | null): string | null {
  if (value == null) return null
  if (typeof value === "string") return value
  return base64Encode(JSON.stringify(value))
}

/** Return the raw cursor string (opaque platform token). */
export function parseCursor(cursor: string | null): string | null {
  return cursor ?? null
}

/** Decode a packed JSON cursor; returns {} for a null/opaque cursor. */
export function parseJsonCursor(cursor: string | null): Record<string, unknown> {
  if (!cursor) return {}
  try {
    return JSON.parse(base64Decode(cursor)) as Record<string, unknown>
  } catch {
    return {}
  }
}
