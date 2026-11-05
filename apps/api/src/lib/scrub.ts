// SPDX-License-Identifier: FSL-1.1-ALv2
// Canonical copy -- mirrored verbatim by the monitoring watchdog and the sibling hub
// service of the reference deployment. Keep every copy in sync (identical test vectors in
// each repo's scrub.test.ts -- drift breaks tests, not just docs).
//
// Value-level string scrubber. Path-based Pino redaction only masks values at named object
// paths; it does NOT scrub free-text substrings inside a message or stack trace (e.g.
// "insert failed for email=alice@x.com"). This is the only guarantee that no PII/secret
// leaves the box in an alert email or an in-memory error sample.
//
// Order matters: connection-string credentials are redacted BEFORE the generic bearer/JWT
// pass so the "user:pass" segment doesn't get partially eaten by a token-shaped regex first
// (the password portion of a connection string can look token-ish). Order applied here:
// 1) connection-string credentials  2) bearer/JWT tokens  3) sk_/pk_-style API keys
// 4) long hex strings  5) email addresses.

const CONNECTION_STRING_CREDENTIALS = /:\/\/[^\s/:@]+:[^\s/:@]+@/g
const BEARER_TOKEN = /\bBearer\s+\S+/gi
const JWT_SHAPE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g
const API_KEY_SHAPE = /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

export function scrubText(input: string): string {
  let result = input
  result = result.replace(CONNECTION_STRING_CREDENTIALS, "://[redacted]@")
  result = result.replace(BEARER_TOKEN, "[token]")
  result = result.replace(JWT_SHAPE, "[token]")
  result = result.replace(API_KEY_SHAPE, "[key]")
  result = result.replace(LONG_HEX, "[hex]")
  result = result.replace(EMAIL, "[email]")
  return result
}

/**
 * Truncates a log line at `max` bytes/chars (default 64 KB) so a pathological line never
 * blows out an alert email or the state file.
 */
export function truncateLine(input: string, max = 65536): string {
  if (input.length <= max) return input
  return input.slice(0, max)
}
