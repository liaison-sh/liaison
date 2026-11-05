// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ciphertext blob format of spec section 3.4:
//
//     version:u8 || key_id:u8 || iv:12 || ciphertext || tag:16
//
// The two-byte header is exposed separately because it is fed into the AAD of
// every AES-GCM operation (see `aad.ts`), which is what makes a flipped version
// byte or a swapped key id fail decryption instead of being honoured.
//
// WebCrypto's AES-GCM returns the ciphertext with the tag already appended, so
// this module never splits them: `body` is `ciphertext || tag` as one run.

import { type Bytes, copyBytes } from "./bytes"

/** The only ciphertext version this design defines. */
export const MAILBOX_ENC_VERSION = 1

/** `version || key_id`. */
export const BLOB_HEADER_BYTES = 2

/** AES-GCM IV length. Twelve fresh CSPRNG bytes per operation, never a counter. */
export const BLOB_IV_BYTES = 12

/** AES-GCM tag length, appended to the ciphertext by WebCrypto. */
export const BLOB_TAG_BYTES = 16

/** The shortest blob that can exist: header, iv and a tag over empty plaintext. */
export const BLOB_MIN_BYTES = BLOB_HEADER_BYTES + BLOB_IV_BYTES + BLOB_TAG_BYTES

export type MailboxBlobErrorCode =
  | "INVALID_VERSION"
  | "INVALID_KEY_ID"
  | "INVALID_IV_LENGTH"
  | "BODY_TOO_SHORT"
  | "BLOB_TOO_SHORT"

export class MailboxBlobError extends Error {
  readonly code: MailboxBlobErrorCode
  constructor(code: MailboxBlobErrorCode, message: string) {
    super(message)
    this.name = "MailboxBlobError"
    this.code = code
  }
}

export interface DecodedBlob {
  version: number
  keyId: number
  iv: Bytes
  /** `ciphertext || tag`, exactly as AES-GCM produced it. */
  body: Bytes
  /** The two-byte `version || key_id` prefix, for the AAD. */
  header: Bytes
}

function assertByte(value: number, code: MailboxBlobErrorCode, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new MailboxBlobError(code, `${label} must be a single byte, got ${value}`)
  }
}

/** The two AAD-bound header bytes for a given version and key id. */
export function blobHeader(version: number, keyId: number): Bytes {
  assertByte(version, "INVALID_VERSION", "version")
  assertByte(keyId, "INVALID_KEY_ID", "key id")
  return new Uint8Array([version, keyId])
}

export function encodeBlob(input: {
  version: number
  keyId: number
  iv: Bytes
  ciphertextWithTag: Bytes
}): Bytes {
  const header = blobHeader(input.version, input.keyId)
  if (input.iv.length !== BLOB_IV_BYTES) {
    throw new MailboxBlobError(
      "INVALID_IV_LENGTH",
      `iv must be ${BLOB_IV_BYTES} bytes, got ${input.iv.length}`,
    )
  }
  if (input.ciphertextWithTag.length < BLOB_TAG_BYTES) {
    throw new MailboxBlobError(
      "BODY_TOO_SHORT",
      `body must carry at least the ${BLOB_TAG_BYTES} byte tag, got ${input.ciphertextWithTag.length}`,
    )
  }
  const out = new Uint8Array(BLOB_HEADER_BYTES + BLOB_IV_BYTES + input.ciphertextWithTag.length)
  out.set(header, 0)
  out.set(input.iv, BLOB_HEADER_BYTES)
  out.set(input.ciphertextWithTag, BLOB_HEADER_BYTES + BLOB_IV_BYTES)
  return out
}

export function decodeBlob(bytes: Bytes): DecodedBlob {
  if (bytes.length < BLOB_MIN_BYTES) {
    throw new MailboxBlobError(
      "BLOB_TOO_SHORT",
      `blob must be at least ${BLOB_MIN_BYTES} bytes, got ${bytes.length}`,
    )
  }
  return {
    version: bytes[0],
    keyId: bytes[1],
    iv: copyBytes(bytes.subarray(BLOB_HEADER_BYTES, BLOB_HEADER_BYTES + BLOB_IV_BYTES)),
    body: copyBytes(bytes.subarray(BLOB_HEADER_BYTES + BLOB_IV_BYTES)),
    header: copyBytes(bytes.subarray(0, BLOB_HEADER_BYTES)),
  }
}
