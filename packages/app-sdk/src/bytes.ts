// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/app-sdk/bytes: text, bytes and hex for WebCrypto, the same on every
// executor.
//
// WebCrypto (`crypto.subtle`) is the crypto primitive of sandboxed apps. A
// Workers isolate has typed arrays; the QuickJS sandbox does not (they
// allocate outside its heap limit), so there its `crypto.subtle` takes and
// answers arrays of byte values (0-255) instead of BufferSource/ArrayBuffer.
// These helpers hide the difference: hand `utf8Bytes(text)` to
// `crypto.subtle.*` and read an answer with `bytesToHex`.
//
// Runs inside the sandbox: no imports, no `node:*`.

/** Bytes as the running executor's `crypto.subtle` takes them. */
export type Bytes = Uint8Array | number[]

/** What `crypto.subtle` answers: an ArrayBuffer, or an array of bytes in QuickJS. */
export type CryptoBytes = ArrayBuffer | ArrayLike<number>

/** The digests `digestHex` computes (WebCrypto names). */
export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"

/** The `crypto.subtle` subset every executor has, typed for both byte shapes. */
interface PortableSubtle {
  digest(algorithm: DigestAlgorithm, data: Bytes): Promise<CryptoBytes>
  importKey(
    format: "raw",
    keyData: Bytes,
    algorithm: { name: "HMAC"; hash: DigestAlgorithm },
    extractable: boolean,
    usages: Array<"sign" | "verify">,
  ): Promise<CryptoKey>
  sign(algorithm: "HMAC", key: CryptoKey, data: Bytes): Promise<CryptoBytes>
  verify(algorithm: "HMAC", key: CryptoKey, signature: Bytes, data: Bytes): Promise<boolean>
}

const hasTypedArrays = (): boolean => typeof Uint8Array === "function"

/** The executor's `crypto.subtle` (native on Workers, the host-backed one in QuickJS). */
export function subtle(): PortableSubtle {
  const c = (globalThis as { crypto?: { subtle?: PortableSubtle } }).crypto
  if (!c?.subtle) throw new Error("crypto.subtle is not available")
  return c.subtle
}

/** UTF-8 bytes of `text`: a Uint8Array where typed arrays exist, else an array. */
export function utf8Bytes(text: string): Bytes {
  if (hasTypedArrays() && typeof TextEncoder === "function") return new TextEncoder().encode(text)
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
      } else {
        c = 0xfffd
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      )
    }
  }
  return out
}

/** Lower-case hex of a `crypto.subtle` answer (ArrayBuffer or byte array). */
export function bytesToHex(bytes: CryptoBytes): string {
  const view: ArrayLike<number> =
    typeof ArrayBuffer === "function" && bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : (bytes as ArrayLike<number>)
  let out = ""
  for (let i = 0; i < view.length; i++) out += ((view[i] ?? 0) & 0xff).toString(16).padStart(2, "0")
  return out
}

/** Hex digest of `text`'s UTF-8 bytes. */
export async function digestHex(algorithm: DigestAlgorithm, text: string): Promise<string> {
  return bytesToHex(await subtle().digest(algorithm, utf8Bytes(text)))
}

/** Hex HMAC of `text` under `key` (both UTF-8). */
export async function hmacHex(hash: DigestAlgorithm, key: string, text: string): Promise<string> {
  const k = await subtle().importKey("raw", utf8Bytes(key), { name: "HMAC", hash }, false, ["sign"])
  return bytesToHex(await subtle().sign("HMAC", k, utf8Bytes(text)))
}
