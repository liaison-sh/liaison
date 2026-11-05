// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL ONLY. This module may run on the server.
//
// ECDH-ES seal of a per-message content key to a user's identity public key
// (spec section 3.1): generate an ephemeral P-256 keypair, ECDH against the
// recipient's public key, HKDF (D1) the shared secret to a 256 bit KEK bound to
// the recipient, AES-KW the content key under it.
//
// Sealing needs only the public key, which is what lets the server encrypt mail
// for a user who has not logged in for a month.
//
// The unseal half lives in `unseal.ts` and is client only.

import type { Bytes } from "./bytes"
import { deriveSealKek } from "./kdf"

/** AES-256-GCM content key length. */
export const CONTENT_KEY_BYTES = 32

const P256 = { name: "ECDH", namedCurve: "P-256" } as const

export interface SealedContentKey {
  /** The AES-KW wrapped content key, 40 bytes for a 32 byte key. */
  wrapped: Bytes
  /** The ephemeral public key, SPKI, stored alongside the wrapped key. */
  epkSpki: Bytes
}

/**
 * Seam for T-CRYPTO-8, which must prove that a rejected point never reaches a
 * derivation, not merely that an error was thrown somewhere.
 */
export interface EcdhHooks {
  deriveSharedSecret?: (privateKey: CryptoKey, publicKey: CryptoKey) => Promise<Bytes>
}

/** 32 fresh CSPRNG bytes. */
export function generateContentKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(CONTENT_KEY_BYTES))
}

/**
 * The ONLY way this package turns SPKI bytes into an ECDH public key.
 *
 * `crypto.subtle.importKey("spki", ...)` performs on-curve and range
 * validation. Raw scalar-multiplication paths and unvalidated third-party
 * imports are forbidden (spec section 3.1): on unseal the client runs ECDH with
 * a long-lived private key against a server-supplied point, for every message
 * in the mailbox, so an invalid-curve point is a key-recovery attack.
 */
export async function importEcdhPublicKeySpki(spki: Bytes): Promise<CryptoKey> {
  // Not extractable: nothing in this package needs to export a point it was
  // handed, and T-CRYPTO-9 records every key creation.
  return crypto.subtle.importKey("spki", spki, P256, false, [])
}

export async function defaultDeriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Bytes> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
  return new Uint8Array(bits)
}

/** Import a D1 output as a non-extractable AES-KW key. */
export async function importSealKek(
  bits: Bytes,
  usage: "wrapKey" | "unwrapKey",
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bits, "AES-KW", false, [usage])
}

export interface SealContentKeyInput {
  /** The recipient's active identity ECDH public key, SPKI bytes. */
  recipientEcdhSpki: Bytes
  userId: string
  /** The identity key id, one byte, bound into D1 and into the blob header. */
  keyId: number
  contentKey: Bytes | CryptoKey
}

export async function sealContentKey(
  input: SealContentKeyInput,
  hooks: EcdhHooks = {},
): Promise<SealedContentKey> {
  const derive = hooks.deriveSharedSecret ?? defaultDeriveSharedSecret
  // Validating import FIRST. Nothing below this line may run on an unvalidated
  // point.
  const recipient = await importEcdhPublicKeySpki(input.recipientEcdhSpki)
  const ephemeral = (await crypto.subtle.generateKey(P256, false, ["deriveBits"])) as CryptoKeyPair
  const epkSpki = new Uint8Array(await crypto.subtle.exportKey("spki", ephemeral.publicKey))
  const sharedSecret = await derive(ephemeral.privateKey, recipient)
  const kekBits = await deriveSealKek({
    sharedSecret,
    userId: input.userId,
    keyId: input.keyId,
    recipientSpki: input.recipientEcdhSpki,
    epkSpki,
  })
  if (sharedSecret instanceof Uint8Array) sharedSecret.fill(0)
  const kek = await importSealKek(kekBits, "wrapKey")
  kekBits.fill(0)
  // WebCrypto exposes AES-KW only through wrapKey, which refuses a
  // non-extractable input. The content key is bytes this process just minted,
  // so importing it extractable for the length of one call reveals nothing that
  // the caller does not already hold. It is the single exception to the
  // extractable: false rule and T-CRYPTO-9 pins it to exactly one call.
  const handle =
    input.contentKey instanceof Uint8Array
      ? await crypto.subtle.importKey(
          "raw",
          input.contentKey,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt"],
        )
      : input.contentKey
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", handle, kek, "AES-KW"))
  return { wrapped, epkSpki }
}
