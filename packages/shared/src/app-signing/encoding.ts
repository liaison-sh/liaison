// SPDX-License-Identifier: FSL-1.1-ALv2
// Byte helpers for app signing that run unchanged in Bun and in browsers
// (no Buffer, no node:crypto).

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Null when `text` is not strict base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.trim()
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null
  try {
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** A copy backed by a plain ArrayBuffer, the type WebCrypto takes. */
export function ab(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ab(bytes)))
  let hex = ""
  for (const b of digest) hex += b.toString(16).padStart(2, "0")
  return hex
}

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
}
