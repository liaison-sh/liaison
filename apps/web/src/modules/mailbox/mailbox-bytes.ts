// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Base64 for the mailbox surface. The REST layer carries every `bytea` column
// as base64 (the sandbox bridge does the same, spec correction C3), so this is
// the only place the browser turns wire text into bytes.
//
// `@liaison/mailbox-crypto` deliberately exports no base64 helper: it is a
// transport concern, and putting it in the crypto package would invite a call
// site to base64 a key.

export type Bytes = Uint8Array<ArrayBuffer>

export function bytesToBase64(bytes: Bytes): string {
  let binary = ""
  // Chunked so a large attachment range cannot blow the argument limit.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Bytes {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const decoder = new TextDecoder()

export function decodeUtf8(bytes: Bytes): string {
  return decoder.decode(bytes)
}

export function encodeUtf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes
}
