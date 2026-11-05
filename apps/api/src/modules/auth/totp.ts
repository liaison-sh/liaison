// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import { generateTOTP, verifyTOTPWithGracePeriod } from "@oslojs/otp"

const TOTP_DIGITS = 6
export const TOTP_PERIOD = 30
export const TOTP_GRACE_PERIOD = 30 // ±1 time step

export function generateTotpSecret(): string {
  const bytes = randomBytes(20)
  return encodeBase32(bytes)
}

export function generateTotpUri(secret: string, email: string, issuer: string): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?${params}`
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const secretBytes = decodeBase32(secret)
  return verifyTOTPWithGracePeriod(secretBytes, TOTP_PERIOD, TOTP_DIGITS, code, TOTP_GRACE_PERIOD)
}

export function generateCurrentCode(secret: string): string {
  const secretBytes = decodeBase32(secret)
  return generateTOTP(secretBytes, TOTP_PERIOD, TOTP_DIGITS)
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    codes.push(randomBytes(10).toString("hex"))
  }
  return codes
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const b of bytes) bits += b.toString(2).padStart(8, "0")
  let result = ""
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0")
    result += alphabet[parseInt(chunk, 2)]
  }
  while (result.length % 8 !== 0) result += "="
  return result
}

function decodeBase32(encoded: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const stripped = encoded.replace(/=+$/, "")
  const bits: number[] = []
  for (const c of stripped) {
    const val = alphabet.indexOf(c.toUpperCase())
    for (let i = 4; i >= 0; i--) bits.push((val >> i) & 1)
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j]
    bytes[i] = byte
  }
  return bytes
}
