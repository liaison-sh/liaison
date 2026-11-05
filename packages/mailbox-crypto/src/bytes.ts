// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Byte helpers shared by every module in this package. Kept in one place so the
// `0x00` separators of spec section 3.6 and the big-endian integer encodings of
// section 3.5 are written once and read the same way everywhere.

/**
 * A byte run backed by a plain `ArrayBuffer`. WebCrypto refuses a
 * `SharedArrayBuffer`-backed view, so every byte run in this package carries
 * that guarantee in its type rather than through a cast at each call site.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** The single separator byte that every `info` and AAD construction uses. */
export const ZERO_BYTE = new Uint8Array([0])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 encode a label or an identifier. */
export function utf8(value: string): Bytes {
  return encoder.encode(value)
}

/** UTF-8 decode plaintext that came back out of a blob. */
export function fromUtf8(bytes: Bytes): string {
  return decoder.decode(bytes)
}

/** Concatenate byte runs left to right. */
export function concatBytes(...parts: Bytes[]): Bytes {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A single byte, for `u8(key_id)` in D1 and for the blob header. */
export function u8(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`u8 out of range: ${value}`)
  }
  return new Uint8Array([value])
}

/** Big-endian 32 bit, used by the STREAM chunk counter. */
export function u32be(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32 out of range: ${value}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

/** Big-endian 64 bit, used by the STREAM length binding and the ack statement. */
export function u64be(value: number | bigint): Bytes {
  const asBig = typeof value === "bigint" ? value : BigInt(value)
  if (asBig < 0n || asBig > 0xffffffffffffffffn) {
    throw new RangeError(`u64 out of range: ${value}`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, asBig, false)
  return out
}

/** Lowercase hex, for test vectors and for comparing byte strings in logs. */
export function toHex(bytes: Bytes): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** Constant-time-ish equality. Length is not secret here, the contents are. */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Overwrite a byte run in place. The only defence available in JavaScript for
 * raw key material that had to exist as bytes (spec section 3.3 step 3).
 */
export function zeroBytes(bytes: Bytes): void {
  bytes.fill(0)
}

/** A copy of `bytes` as a standalone ArrayBuffer-backed view. */
export function copyBytes(bytes: Bytes): Bytes {
  return Uint8Array.from(bytes)
}
