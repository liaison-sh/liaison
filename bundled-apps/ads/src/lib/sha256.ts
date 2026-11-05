// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure-JS SHA-256 implementation — no node:crypto, no crypto.subtle, and NO
// typed arrays. The QuickJS sandbox the bundle runs in HARDENS its globals by
// deleting every typed-array constructor (ArrayBuffer, Uint8Array, Uint32Array,
// DataView, …) — see apps/api/src/modules/apps/sandbox/sandbox-worker.ts
// BLOCKED_GLOBALS. A module-top-level `new Uint32Array([...])` therefore throws
// `ReferenceError: 'Uint32Array' is not defined` at bundle EVALUATION, killing
// EVERY ads tool (the eval failure is module-wide, not per-call). So this
// implementation uses plain `number[]` arrays + bitwise ops only, and a manual
// UTF-8 encoder (no TextEncoder, which is also unavailable). Output: lowercase
// 64-char hex. All arithmetic is masked with `>>> 0` to stay in unsigned 32-bit.
//
// Runtime purity guarantee: this module imports NOTHING from node:* or crypto,
// and references NO typed-array / TextEncoder / DataView global — so it evaluates
// cleanly inside the hardened sandbox.

// SHA-256 constants (first 32 bits of fractional parts of cube roots of first 64 primes)
const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

// Initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
const INIT: number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/**
 * UTF-8 encode a string to a plain byte array (no TextEncoder — blocked in the
 * sandbox). Handles the full BMP + surrogate pairs (astral code points).
 */
function utf8Bytes(str: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    // Combine a high+low surrogate pair into a single code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return bytes
}

/**
 * Compute SHA-256 of a byte array (plain number[]). Returns lowercase 64-char hex.
 */
export function sha256Bytes(data: number[]): string {
  const len = data.length
  const bitLen = len * 8

  // Pad to 512-bit (64-byte) blocks: 1 byte 0x80, then zeros, then 8-byte
  // big-endian bit length. Total padded length ≡ 56 (mod 64) before the length.
  const paddedLen = ((len + 72) >> 6) << 6 // next multiple of 64 ≥ len+9
  const padded: number[] = new Array(paddedLen)
  for (let i = 0; i < paddedLen; i++) padded[i] = 0
  for (let i = 0; i < len; i++) padded[i] = data[i]! & 0xff
  padded[len] = 0x80
  // 64-bit big-endian bit length at the end (JS numbers safely cover < 2^53).
  const hi = Math.floor(bitLen / 0x100000000) >>> 0
  const lo = bitLen >>> 0
  padded[paddedLen - 8] = (hi >>> 24) & 0xff
  padded[paddedLen - 7] = (hi >>> 16) & 0xff
  padded[paddedLen - 6] = (hi >>> 8) & 0xff
  padded[paddedLen - 5] = hi & 0xff
  padded[paddedLen - 4] = (lo >>> 24) & 0xff
  padded[paddedLen - 3] = (lo >>> 16) & 0xff
  padded[paddedLen - 2] = (lo >>> 8) & 0xff
  padded[paddedLen - 1] = lo & 0xff

  const H: number[] = INIT.slice()
  const W: number[] = new Array(64)

  for (let blockStart = 0; blockStart < paddedLen; blockStart += 64) {
    for (let i = 0; i < 16; i++) {
      const j = blockStart + i * 4
      W[i] =
        ((padded[j]! << 24) | (padded[j + 1]! << 16) | (padded[j + 2]! << 8) | padded[j + 3]!) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(W[i - 15]!, 7) ^ rotr32(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3)
      const s1 = rotr32(W[i - 2]!, 17) ^ rotr32(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10)
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0
    }

    let a = H[0]!
    let b = H[1]!
    let c = H[2]!
    let d = H[3]!
    let e = H[4]!
    let f = H[5]!
    let g = H[6]!
    let h = H[7]!

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    H[0] = (H[0]! + a) >>> 0
    H[1] = (H[1]! + b) >>> 0
    H[2] = (H[2]! + c) >>> 0
    H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0
    H[5] = (H[5]! + f) >>> 0
    H[6] = (H[6]! + g) >>> 0
    H[7] = (H[7]! + h) >>> 0
  }

  let hex = ""
  for (let i = 0; i < 8; i++) {
    hex += (H[i]! >>> 0).toString(16).padStart(8, "0")
  }
  return hex
}

/**
 * Compute SHA-256 of a UTF-8 string. Returns lowercase 64-char hex.
 */
export function sha256(input: string): string {
  return sha256Bytes(utf8Bytes(input))
}

// ─── PII normalization helpers ────────────────────────────────────────────────

/**
 * Normalize an email address for Meta's CUSTOMER_LIST hashing:
 * trim whitespace + lowercase.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Normalize a phone number for Meta's CUSTOMER_LIST hashing.
 * Meta's documented phone normalization is DIGITS-ONLY (country code, no '+',
 * no leading zeros, no separators) — a leading '+' makes the hash mismatch.
 * So we strip every non-digit and return the bare digit string.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "")
}

/**
 * Normalize and SHA-256 hash a customer identifier for Meta CUSTOMER_LIST.
 * Returns lowercase 64-char hex. Never returns raw PII.
 */
export function hashIdentifier(kind: "email" | "phone", raw: string): string {
  const normalized = kind === "email" ? normalizeEmail(raw) : normalizePhone(raw)
  return sha256(normalized)
}
