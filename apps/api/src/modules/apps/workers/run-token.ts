// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Workers run token that any process of the cell can check without the run.
//
//   token = base64url( random32 || HMAC-SHA256(key, runId | random32) )
//
// The key is derived with HKDF from JWT_SECRET under its own label, so every
// process of the cell holds it and it is used for nothing else. The MAC binds
// the token to its run id: a process that does not own the run (it is in
// another process's registry, run-registry.ts) refuses a garbage token, or a
// token presented for another run id, before it forwards anything to the owner
// (bridge-forward.ts). The owner still checks the token against the run it
// registered (only its sha256 is kept there): the MAC proves a process of
// this cell minted the token, not that the run is live.

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"
import { env } from "~/lib/env"

const HKDF_SALT = "liaison-app-run-token"
const HKDF_INFO = "liaison-app-run-token-v1"
const RANDOM_BYTES = 32
const MAC_BYTES = 32
/** base64url of 64 bytes, unpadded. */
const TOKEN_RE = /^[A-Za-z0-9_-]{86}$/

let cachedKey: { secret: string; key: Buffer } | null = null

/** HKDF-SHA256(JWT_SECRET, salt, "liaison-app-run-token-v1"), 32 bytes. */
export function runTokenKey(secret: string = env.JWT_SECRET): Buffer {
  if (cachedKey?.secret === secret) return cachedKey.key
  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32))
  cachedKey = { secret, key }
  return key
}

function mac(key: Buffer, runId: string, random: Buffer): Buffer {
  return createHmac("sha256", key).update(runId).update("|").update(random).digest()
}

/** A fresh token for `runId`. */
export function mintRunToken(runId: string, key: Buffer = runTokenKey()): string {
  const random = randomBytes(RANDOM_BYTES)
  return Buffer.concat([random, mac(key, runId, random)]).toString("base64url")
}

/**
 * True when `token` was minted by a process of this cell for `runId`. Says
 * nothing of whether the run is live: only its owner's registry knows.
 */
export function runTokenMintedFor(
  runId: string,
  token: string | undefined,
  key: Buffer = runTokenKey(),
): boolean {
  // One spelling only: base64url decoding is lenient, so the shape is checked first.
  if (!token || !TOKEN_RE.test(token)) return false
  const raw = Buffer.from(token, "base64url")
  // Canonical spelling only: the last character's unused bits must be zero.
  if (raw.length !== RANDOM_BYTES + MAC_BYTES || raw.toString("base64url") !== token) return false
  const expected = mac(key, runId, raw.subarray(0, RANDOM_BYTES))
  return timingSafeEqual(raw.subarray(RANDOM_BYTES), expected)
}
