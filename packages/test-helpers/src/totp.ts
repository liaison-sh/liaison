// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac } from "node:crypto"

export function generateTotpCode(secret: string, timeStep = 30): string {
  const time = Math.floor(Date.now() / 1000 / timeStep)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(time))

  const decoded = base32Decode(secret)
  const hmac = createHmac("sha1", decoded).update(buffer).digest()

  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return String(code % 1_000_000).padStart(6, "0")
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const cleaned = input.replace(/[= ]/g, "").toUpperCase()
  let bits = ""
  for (const char of cleaned) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

export function extractSecretFromUri(otpauthUri: string): string {
  const url = new URL(otpauthUri)
  return url.searchParams.get("secret") ?? ""
}
