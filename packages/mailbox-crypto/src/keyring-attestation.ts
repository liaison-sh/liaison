// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL SAFE. The canonical keyring statement and its Ed25519 verifier. The
// server may reach this file: verifying an attestation needs only public keys,
// and signing needs a private key the server does not have.
//
// Key generation and private-key unwrapping live in `keyring.ts`, which is
// client only.
//
// What this closes: an operator who inserts an extra `active` identity row can
// then seal new mail to a key they hold. The client verifies the server's
// identity list against this signature, so an unattested identity fails
// verification instead of being trusted (spec section 9.2). The verification is
// cryptographic, not a `key_id` string comparison.

import { type Bytes, concatBytes, u8, u32be, utf8, ZERO_BYTE } from "./bytes"

export const KEYRING_ATTESTATION_LABEL = "liaison.mailbox.keyring.v1"

const ED25519 = { name: "Ed25519" } as const

/** The attested view of one key id. Public halves only. */
export interface AttestedIdentity {
  keyId: number
  status: "active" | "retired"
  ecdhSpki: Bytes
  signSpki: Bytes
}

/**
 * The canonical byte encoding, defined here once so a signer and a verifier
 * cannot drift. Identities are sorted by key id and every variable-length run
 * is length-prefixed, so no two distinct keyrings can encode to the same bytes.
 */
export function encodeKeyringStatement(input: {
  userId: string
  identities: readonly AttestedIdentity[]
}): Bytes {
  const sorted = [...input.identities].sort((a, b) => a.keyId - b.keyId)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].keyId === sorted[i - 1].keyId) {
      throw new RangeError(`duplicate key id ${sorted[i].keyId} in keyring statement`)
    }
  }
  const parts: Bytes[] = [
    utf8(KEYRING_ATTESTATION_LABEL),
    ZERO_BYTE,
    utf8(input.userId),
    ZERO_BYTE,
    u32be(sorted.length),
  ]
  for (const identity of sorted) {
    parts.push(
      ZERO_BYTE,
      u8(identity.keyId),
      ZERO_BYTE,
      utf8(identity.status),
      ZERO_BYTE,
      u32be(identity.ecdhSpki.length),
      identity.ecdhSpki,
      u32be(identity.signSpki.length),
      identity.signSpki,
    )
  }
  return concatBytes(...parts)
}

export async function signKeyringAttestation(input: {
  signPrivateKey: CryptoKey
  userId: string
  identities: readonly AttestedIdentity[]
}): Promise<Bytes> {
  const statement = encodeKeyringStatement(input)
  return new Uint8Array(await crypto.subtle.sign(ED25519, input.signPrivateKey, statement))
}

export async function importSignPublicKey(spki: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spki, ED25519, false, ["verify"])
}

export async function verifyKeyringAttestation(input: {
  signPublicKey: CryptoKey | Bytes
  userId: string
  identities: readonly AttestedIdentity[]
  attestation: Bytes
}): Promise<boolean> {
  const key =
    input.signPublicKey instanceof Uint8Array
      ? await importSignPublicKey(input.signPublicKey)
      : input.signPublicKey
  let statement: Bytes
  try {
    statement = encodeKeyringStatement(input)
  } catch {
    return false
  }
  return crypto.subtle.verify(ED25519, key, input.attestation, statement)
}
