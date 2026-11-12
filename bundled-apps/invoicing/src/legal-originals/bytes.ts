// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UTF-8 encoding and base64 for the sandbox, which has neither TextEncoder, Buffer nor btoa.
// Used for the Factur-X XML (tens of kilobytes at most).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export function utf8Bytes(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      )
  }
  return out
}

export function base64(bytes: ArrayLike<number>): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "="
    out += i + 2 < bytes.length ? B64[n & 63] : "="
  }
  return out
}
