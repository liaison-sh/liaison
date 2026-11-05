// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`; T-SEC-1 asserts that no
// server entrypoint reaches this file. There is deliberately no server-side
// path that can turn a wrapped content key back into a usable key.
//
// The inverse of `seal.ts`: ECDH against the server-supplied ephemeral public
// key, D1 to the same KEK, AES-KW unwrap.

import type { Bytes } from "./bytes"
import { deriveSealKek } from "./kdf"
import {
  defaultDeriveSharedSecret,
  type EcdhHooks,
  importEcdhPublicKeySpki,
  importSealKek,
} from "./seal"

export class MailboxUnsealError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "MailboxUnsealError"
    this.cause = cause
  }
}

export interface UnsealContentKeyInput {
  /** The identity private key for `keyId`, non-extractable, from the keyring. */
  privateKey: CryptoKey
  /** The recipient identity public key, SPKI, bound into D1. */
  recipientEcdhSpki: Bytes
  userId: string
  keyId: number
  wrapped: Bytes
  /** Server-supplied. Validated at import before any derivation runs. */
  epkSpki: Bytes
}

/**
 * Returns the content key as a NON-EXTRACTABLE HKDF `CryptoKey`, which is the
 * only thing the field open path needs (D5 takes it as input keying material).
 * It never becomes bytes again.
 */
export async function unsealContentKey(
  input: UnsealContentKeyInput,
  hooks: EcdhHooks = {},
): Promise<CryptoKey> {
  const derive = hooks.deriveSharedSecret ?? defaultDeriveSharedSecret
  // Validating import FIRST, before the long-lived private key touches the
  // server-supplied point (spec section 3.1, T-CRYPTO-8).
  const epk = await importEcdhPublicKeySpki(input.epkSpki)
  const sharedSecret = await derive(input.privateKey, epk)
  const kekBits = await deriveSealKek({
    sharedSecret,
    userId: input.userId,
    keyId: input.keyId,
    recipientSpki: input.recipientEcdhSpki,
    epkSpki: input.epkSpki,
  })
  if (sharedSecret instanceof Uint8Array) sharedSecret.fill(0)
  const kek = await importSealKek(kekBits, "unwrapKey")
  kekBits.fill(0)
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      input.wrapped,
      kek,
      "AES-KW",
      { name: "HKDF" },
      false,
      ["deriveBits"],
    )
  } catch (error) {
    throw new MailboxUnsealError(
      "wrapped content key did not unwrap under this keyring, key id or recipient key",
      error,
    )
  }
}
