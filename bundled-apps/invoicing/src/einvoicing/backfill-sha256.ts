// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SHA-256 (FIPS 180-4) for hashing a legal original inside the sandbox. The sandbox has neither
// node:crypto, Buffer nor typed arrays (Uint8Array / Uint32Array are undefined there), so this is
// plain-number JavaScript, and it hashes the file bridge's `bytesBase64` payload while decoding
// it, a 64-byte block at a time: a multi-megabyte file is never materialised as a byte array.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

/** Incremental SHA-256 over bytes (numbers 0..255). */
class Sha256 {
  private h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  private block: number[] = new Array(64).fill(0)
  private w: number[] = new Array(64).fill(0)
  private fill = 0
  length = 0

  push(byte: number): void {
    this.block[this.fill++] = byte & 0xff
    this.length += 1
    if (this.fill === 64) {
      this.compress()
      this.fill = 0
    }
  }

  private compress(): void {
    const w = this.w
    const m = this.block
    for (let i = 0; i < 16; i++) {
      const j = i * 4
      w[i] = ((m[j]! << 24) | (m[j + 1]! << 16) | (m[j + 2]! << 8) | m[j + 3]!) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!
      const y = w[i - 2]!
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    const h = this.h
    let a = h[0]!
    let b = h[1]!
    let c = h[2]!
    let d = h[3]!
    let e = h[4]!
    let f = h[5]!
    let g = h[6]!
    let hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  hex(): string {
    const len = this.length
    // 0x80, zero pad to 56 mod 64, then the 64-bit big-endian bit length.
    this.push(0x80)
    while (this.fill !== 56) this.push(0)
    const hi = Math.floor(len / 0x20000000)
    const lo = (len * 8) >>> 0
    for (const v of [hi >>> 24, hi >>> 16, hi >>> 8, hi, lo >>> 24, lo >>> 16, lo >>> 8, lo]) this.push(v)
    return this.h.map((x) => x.toString(16).padStart(8, "0")).join("")
  }
}

/** Lowercase hex SHA-256 of a byte sequence. */
export function sha256Hex(bytes: ArrayLike<number>): string {
  const s = new Sha256()
  for (let i = 0; i < bytes.length; i++) s.push(bytes[i]!)
  return s.hex()
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const B64_INDEX: Record<string, number> = (() => {
  const t: Record<string, number> = {}
  for (let i = 0; i < B64.length; i++) t[B64.charAt(i)] = i
  t["-"] = 62
  t._ = 63
  return t
})()

/** Decode standard (or url-safe) base64, ignoring whitespace and padding, feeding each byte to
 *  `onByte`; throws on any other character. */
function decodeBase64(b64: string, onByte: (byte: number) => void): void {
  let buf = 0
  let bits = 0
  for (let i = 0; i < b64.length; i++) {
    const ch = b64.charAt(i)
    if (ch === "=" || ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue
    const v = B64_INDEX[ch]
    if (v === undefined) throw new Error("invalid base64 character")
    buf = ((buf << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      onByte((buf >> bits) & 0xff)
    }
  }
}

/** SHA-256 and byte length of the bytes a base64 string encodes, decoded as it is hashed. */
export function sha256OfBase64(b64: string): { sha256: string; byteLength: number } {
  const s = new Sha256()
  decodeBase64(b64, (byte) => s.push(byte))
  const byteLength = s.length
  return { sha256: s.hex(), byteLength }
}

/** Decode base64 to a plain array of bytes (small payloads; tests and diagnostics). */
export function base64ToBytes(b64: string): number[] {
  const out: number[] = []
  decodeBase64(b64, (byte) => out.push(byte))
  return out
}
