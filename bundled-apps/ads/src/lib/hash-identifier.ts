// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Customer identifiers for ad-platform audience uploads (Meta CUSTOMER_LIST):
// normalized, then SHA-256 hashed with WebCrypto (`crypto.subtle`, native on
// Workers, host-backed in the QuickJS sandbox) through @liaison/app-sdk/bytes,
// so the hash runs natively instead of as interpreted JS and the code is the
// same on every executor. Imports nothing from node:*.

import { digestHex } from "@liaison/app-sdk/bytes"

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
export function hashIdentifier(kind: "email" | "phone", raw: string): Promise<string> {
  const normalized = kind === "email" ? normalizeEmail(raw) : normalizePhone(raw)
  return digestHex("SHA-256", normalized)
}
