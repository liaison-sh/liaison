// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`. The Account Key is 32 random
// bytes generated in the browser at enrollment and NEVER transmitted. Its only
// job is to wrap the identity keyring, so adding or removing an unlock method
// is a single row change and never re-encrypts the mailbox (spec section 3.1).

import { type Bytes, zeroBytes } from "./bytes"

export const ACCOUNT_KEY_BYTES = 32

/** 32 fresh CSPRNG bytes. Never leaves the browser. */
export function generateAccountKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(ACCOUNT_KEY_BYTES))
}

function assertLength(accountKey: Bytes): void {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError(`account key must be ${ACCOUNT_KEY_BYTES} bytes, got ${accountKey.length}`)
  }
}

/**
 * A non-extractable AES-GCM handle for wrapping and unwrapping the identity
 * keyring's private halves.
 *
 * AES-GCM rather than AES-KW here, deliberately: WebCrypto's AES-KW requires an
 * input length that is a multiple of 8 bytes and a PKCS#8 P-256 private key is
 * 138 bytes, so `wrapKey("pkcs8", ..., "AES-KW")` fails outright. AES-GCM under
 * a bound AAD gives the same confidentiality plus an explicit context binding.
 * The Account Key wraps themselves (which cover exactly 32 bytes) stay AES-KW,
 * as spec section 3.2 requires.
 */
export async function importAccountKeyForKeyringWrap(
  accountKey: Bytes,
  usages: readonly ("wrapKey" | "unwrapKey")[],
): Promise<CryptoKey> {
  assertLength(accountKey)
  return crypto.subtle.importKey("raw", accountKey, { name: "AES-GCM", length: 256 }, false, [
    ...usages,
  ])
}

/** A non-extractable HKDF handle, for D7 (index key) and D8 (ledger MAC key). */
export async function importAccountKeyForDerivation(accountKey: Bytes): Promise<CryptoKey> {
  assertLength(accountKey)
  return crypto.subtle.importKey("raw", accountKey, "HKDF", false, ["deriveBits"])
}

export { zeroBytes }
