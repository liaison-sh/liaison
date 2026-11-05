// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`. This module mints identity
// private keys and unwraps them; nothing on the server may reach it. The
// attestation encoding and its verifier live in `keyring-attestation.ts`, which
// IS seal-safe, so the server can check an attestation without ever touching a
// module that produces private keys.
//
// Per key id the keyring holds a P-256 ECDH keypair (seal and unseal) and an
// Ed25519 signing keypair (acknowledgements, keyring attestation). The Ed25519
// pair exists because P-256 keys imported for `deriveBits` cannot sign
// (spec section 3.1, amendment A7).
//
// Rotation appends a key id and marks the previous one retired. Retired private
// keys stay in the keyring under the same Account Key, so rotation is never a
// re-encryption event, and so rotation is NOT remediation: it buys no forward
// secrecy (spec section 3.1, amendment A15).

import { buildAad, keyringWrapAad } from "./aad"
import { importAccountKeyForKeyringWrap } from "./account-key"
import { BLOB_IV_BYTES, blobHeader, MAILBOX_ENC_VERSION } from "./blob"
import type { Bytes } from "./bytes"

export type IdentityKeyStatus = "active" | "retired"

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const
const ED25519 = { name: "Ed25519" } as const

/** One key id's public halves plus its wrapped private halves. */
export interface KeyringEntry {
  keyId: number
  status: IdentityKeyStatus
  /** P-256 ECDH public key, SPKI. Stored server-side, readable by the org. */
  ecdhSpki: Bytes
  /** Ed25519 signing public key, SPKI. Stored server-side. */
  signSpki: Bytes
  wrappedEcdhPrivate: Bytes
  wrappedSignPrivate: Bytes
  /** One IV per wrapped half, both fresh. */
  ecdhWrapIv: Bytes
  signWrapIv: Bytes
}

export interface IdentityPrivateKeys {
  ecdhPrivate: CryptoKey
  signPrivate: CryptoKey
}

export class KeyringError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "KeyringError"
    this.cause = cause
  }
}

function wrapParams(userId: string, keyId: number, part: "ecdh" | "sign", iv: Bytes) {
  return {
    name: "AES-GCM",
    iv: iv,
    additionalData: buildAad(
      blobHeader(MAILBOX_ENC_VERSION, keyId),
      keyringWrapAad(userId, keyId, part),
    ),
    tagLength: 128,
  }
}

/**
 * Generate one key id: a P-256 ECDH pair and an Ed25519 pair, with both private
 * halves wrapped under the Account Key. The private halves are returned as
 * non-extractable handles for the caller's unlocked session.
 */
export async function generateIdentityKey(input: {
  accountKey: Bytes
  userId: string
  keyId: number
  status?: IdentityKeyStatus
}): Promise<{ entry: KeyringEntry; privateKeys: IdentityPrivateKeys }> {
  const wrapKey = await importAccountKeyForKeyringWrap(input.accountKey, ["wrapKey", "unwrapKey"])
  // Generated extractable purely so `wrapKey` can export the private half once.
  // What is persisted is the wrapped blob; what the session keeps is the
  // re-imported non-extractable handle below.
  const ecdh = (await crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"])) as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair

  const ecdhWrapIv = crypto.getRandomValues(new Uint8Array(BLOB_IV_BYTES))
  const signWrapIv = crypto.getRandomValues(new Uint8Array(BLOB_IV_BYTES))
  const entry: KeyringEntry = {
    keyId: input.keyId,
    status: input.status ?? "active",
    ecdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
    signSpki: new Uint8Array(await crypto.subtle.exportKey("spki", sign.publicKey)),
    wrappedEcdhPrivate: new Uint8Array(
      await crypto.subtle.wrapKey(
        "pkcs8",
        ecdh.privateKey,
        wrapKey,
        wrapParams(input.userId, input.keyId, "ecdh", ecdhWrapIv),
      ),
    ),
    wrappedSignPrivate: new Uint8Array(
      await crypto.subtle.wrapKey(
        "pkcs8",
        sign.privateKey,
        wrapKey,
        wrapParams(input.userId, input.keyId, "sign", signWrapIv),
      ),
    ),
    ecdhWrapIv,
    signWrapIv,
  }
  return {
    entry,
    privateKeys: await unwrapIdentityKey({
      accountKey: input.accountKey,
      userId: input.userId,
      entry,
    }),
  }
}

/**
 * Unwrap one key id's private halves. `extractable: false` at both call sites:
 * passing `true` there, the default in most examples, turns an XSS into
 * permanent total compromise rather than a bounded one (spec section 3.3).
 */
export async function unwrapIdentityKey(input: {
  accountKey: Bytes
  userId: string
  entry: KeyringEntry
}): Promise<IdentityPrivateKeys> {
  const unwrapKey = await importAccountKeyForKeyringWrap(input.accountKey, ["unwrapKey"])
  const { entry } = input
  try {
    const ecdhPrivate = await crypto.subtle.unwrapKey(
      "pkcs8",
      entry.wrappedEcdhPrivate,
      unwrapKey,
      wrapParams(input.userId, entry.keyId, "ecdh", entry.ecdhWrapIv),
      ECDH_PARAMS,
      false,
      ["deriveBits"],
    )
    const signPrivate = await crypto.subtle.unwrapKey(
      "pkcs8",
      entry.wrappedSignPrivate,
      unwrapKey,
      wrapParams(input.userId, entry.keyId, "sign", entry.signWrapIv),
      ED25519,
      false,
      ["sign"],
    )
    return { ecdhPrivate, signPrivate }
  } catch (error) {
    throw new KeyringError(
      `keyring entry ${entry.keyId} did not unwrap under this account key and user id`,
      error,
    )
  }
}

/**
 * Rotation: mark `retiredKeyId` retired, leave every other entry alone. The
 * mailbox is not rewritten and the retired private key stays in the keyring, so
 * historical mail keeps opening (T-CRYPTO-4).
 */
export function retireKeyId(
  entries: readonly KeyringEntry[],
  retiredKeyId: number,
): KeyringEntry[] {
  if (!entries.some((entry) => entry.keyId === retiredKeyId)) {
    throw new KeyringError(`cannot retire key id ${retiredKeyId}, it is not in the keyring`)
  }
  const next = entries.map((entry) =>
    entry.keyId === retiredKeyId ? { ...entry, status: "retired" as const } : entry,
  )
  const active = next.filter((entry) => entry.status === "active")
  if (active.length !== 1) {
    throw new KeyringError(
      `a keyring must have exactly one active key id, this one would have ${active.length}`,
    )
  }
  return next
}

/** The single active key id, or a thrown error. More than one is the shape an
 * operator key-injection attack takes (spec section 5.2, section 9.2). */
export function activeKeyringEntry(entries: readonly KeyringEntry[]): KeyringEntry {
  const active = entries.filter((entry) => entry.status === "active")
  if (active.length !== 1) {
    throw new KeyringError(`expected exactly one active key id, found ${active.length}`)
  }
  return active[0]
}
