// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The derivations of spec section 3.6, D1 through D9. Every one is
// HKDF-SHA256 with L = 32 and an exact `info` byte string. No two share an
// `info`. There is deliberately no generic "derive a KEK" export: a caller that
// wanted one would have to invent an `info`, which is the mistake the table
// exists to prevent.
//
// `info` is assembled through explicit `concatBytes(utf8(label), ZERO_BYTE, ...)`
// calls so the separators are visible in the source rather than hidden in a
// template string.

import { type Bytes, concatBytes, u8, utf8, ZERO_BYTE } from "./bytes"

/** Every derivation in this design produces exactly 32 bytes. */
export const KDF_LENGTH_BYTES = 32

const EMPTY_SALT = new Uint8Array(0)

/**
 * Input keying material. Raw bytes on the sealing side (which minted them) and
 * a non-extractable HKDF `CryptoKey` on the opening side, where the content key
 * came out of an AES-KW unwrap and must never become bytes again.
 */
export type KeyMaterial = Bytes | CryptoKey

async function importHkdf(ikm: Bytes): Promise<CryptoKey> {
  // HKDF keys cannot be extractable: WebCrypto rejects `extractable: true`.
  return crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
}

async function hkdf(ikm: KeyMaterial, salt: Bytes, info: Bytes): Promise<Bytes> {
  const key = ikm instanceof Uint8Array ? await importHkdf(ikm) : ikm
  if (key.algorithm.name !== "HKDF") {
    throw new TypeError(`key material must be an HKDF key, got ${key.algorithm.name}`)
  }
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt,
      info: info,
    },
    key,
    KDF_LENGTH_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * The `info` builders, exported so T-CRYPTO-13 can assert the exact byte
 * strings and their pairwise distinctness without re-deriving keys.
 */
export const mailboxKdfInfo = {
  /** D1, ECDH-ES seal KEK. */
  sealKek(input: { userId: string; keyId: number; recipientSpki: Bytes; epkSpki: Bytes }): Bytes {
    return concatBytes(
      utf8("liaison.mailbox.seal.v1"),
      ZERO_BYTE,
      utf8("A256KW"),
      ZERO_BYTE,
      utf8(input.userId),
      ZERO_BYTE,
      u8(input.keyId),
      ZERO_BYTE,
      input.recipientSpki,
      ZERO_BYTE,
      input.epkSpki,
    )
  },
  /** D2, passkey PRF wrap KEK. */
  passkeyWrapKek(input: { userId: string; credentialId: Bytes }): Bytes {
    return concatBytes(
      utf8("liaison.mailbox.wrap.passkey.v1"),
      ZERO_BYTE,
      utf8(input.userId),
      ZERO_BYTE,
      input.credentialId,
    )
  },
  /** D3, recovery-phrase wrap KEK. */
  recoveryWrapKek(input: { userId: string }): Bytes {
    return concatBytes(utf8("liaison.mailbox.wrap.recovery.v1"), ZERO_BYTE, utf8(input.userId))
  },
  /** D4, recovery-phrase verifier key. Same ikm and salt as D3, other label. */
  recoveryVerifierKey(input: { userId: string }): Bytes {
    return concatBytes(utf8("liaison.mailbox.recovery.verifier.v1"), ZERO_BYTE, utf8(input.userId))
  },
  /** D5, per-field content subkey. */
  fieldSubkey(input: { fieldName: string; entityId: string }): Bytes {
    return concatBytes(
      utf8("liaison.mailbox.field.v1"),
      ZERO_BYTE,
      utf8(input.fieldName),
      ZERO_BYTE,
      utf8(input.entityId),
    )
  },
  /** D6, LEGACY passphrase wrap KEK, over an Argon2id output. Unlock only. */
  passphraseWrapKek(input: { userId: string }): Bytes {
    return concatBytes(utf8("liaison.mailbox.wrap.passphrase.v1"), ZERO_BYTE, utf8(input.userId))
  },
  /**
   * D9, passphrase wrap KEK, over a PBKDF2-HMAC-SHA256 output. A new label
   * because the input keying material comes from a different KDF: a D6 KEK and
   * a D9 KEK over the same passphrase and salt must never coincide.
   */
  passphrasePbkdf2WrapKek(input: { userId: string }): Bytes {
    return concatBytes(utf8("liaison.mailbox.wrap.passphrase.v2"), ZERO_BYTE, utf8(input.userId))
  },
  /** D7, client search-index key. */
  indexKey(input: { userId: string; shardId: string }): Bytes {
    return concatBytes(
      utf8("liaison.mailbox.index.v1"),
      ZERO_BYTE,
      utf8(input.userId),
      ZERO_BYTE,
      utf8(input.shardId),
    )
  },
  /** D8, client ledger MAC key. */
  ledgerMacKey(input: { userId: string }): Bytes {
    return concatBytes(utf8("liaison.mailbox.ledger.v1"), ZERO_BYTE, utf8(input.userId))
  },
} as const

/** D1. ikm is the ECDH shared secret Z, salt is empty. */
export async function deriveSealKek(input: {
  sharedSecret: KeyMaterial
  userId: string
  keyId: number
  recipientSpki: Bytes
  epkSpki: Bytes
}): Promise<Bytes> {
  return hkdf(input.sharedSecret, EMPTY_SALT, mailboxKdfInfo.sealKek(input))
}

/** D2. ikm is the WebAuthn PRF secret. */
export async function derivePasskeyWrapKek(input: {
  prfSecret: KeyMaterial
  salt: Bytes
  userId: string
  credentialId: Bytes
}): Promise<Bytes> {
  return hkdf(input.prfSecret, input.salt, mailboxKdfInfo.passkeyWrapKek(input))
}

/** D3. ikm is the NFKD-normalised recovery phrase bytes. */
export async function deriveRecoveryWrapKek(input: {
  phraseBytes: KeyMaterial
  salt: Bytes
  userId: string
}): Promise<Bytes> {
  return hkdf(input.phraseBytes, input.salt, mailboxKdfInfo.recoveryWrapKek(input))
}

/**
 * D4. Same ikm and salt as D3 on purpose, a different label. Collapsing the two
 * into one derivation with a suffix is what would make the AES-KW KEK and the
 * HMAC verifier key the same key (spec section 3.6 closing note).
 */
export async function deriveRecoveryVerifierKey(input: {
  phraseBytes: KeyMaterial
  salt: Bytes
  userId: string
}): Promise<Bytes> {
  return hkdf(input.phraseBytes, input.salt, mailboxKdfInfo.recoveryVerifierKey(input))
}

/** D5. ikm is the per-message (or per-attachment) content key, salt is empty. */
export async function deriveFieldSubkey(input: {
  contentKey: KeyMaterial
  fieldName: string
  entityId: string
}): Promise<Bytes> {
  return hkdf(input.contentKey, EMPTY_SALT, mailboxKdfInfo.fieldSubkey(input))
}

/** D6, legacy. ikm is the Argon2id output, never the passphrase itself. */
export async function derivePassphraseWrapKek(input: {
  legacyKdfOutput: KeyMaterial
  salt: Bytes
  userId: string
}): Promise<Bytes> {
  return hkdf(input.legacyKdfOutput, input.salt, mailboxKdfInfo.passphraseWrapKek(input))
}

/** D9. ikm is the PBKDF2-HMAC-SHA256 output, never the passphrase itself. */
export async function derivePassphrasePbkdf2WrapKek(input: {
  pbkdf2Output: KeyMaterial
  salt: Bytes
  userId: string
}): Promise<Bytes> {
  return hkdf(input.pbkdf2Output, input.salt, mailboxKdfInfo.passphrasePbkdf2WrapKek(input))
}

/** D7. ikm is the Account Key, salt is empty. */
export async function deriveIndexKey(input: {
  accountKey: KeyMaterial
  userId: string
  shardId: string
}): Promise<Bytes> {
  return hkdf(input.accountKey, EMPTY_SALT, mailboxKdfInfo.indexKey(input))
}

/** D8. ikm is the Account Key, salt is empty. */
export async function deriveLedgerMacKey(input: {
  accountKey: KeyMaterial
  userId: string
}): Promise<Bytes> {
  return hkdf(input.accountKey, EMPTY_SALT, mailboxKdfInfo.ledgerMacKey(input))
}
