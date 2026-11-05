// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Token(bytes = 10): string {
  const buf = randomBytes(bytes)
  let bits = 0
  let value = 0
  let out = ""
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f]
  return out
}
