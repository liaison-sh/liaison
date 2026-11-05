// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL ONLY. This module may run on the server. It opens nothing.
//
// The check behind handing a private mailbox's content to the server (making
// a mailbox transparent): the owner's browser sends a field's plaintext with
// the D5 subkey it opened that field with, and the server proves the pair is
// the one the stored blob was sealed from, so a caller who cannot open the
// mailbox cannot substitute content of its own.
//
// It never decrypts. It re-runs the SEAL of the claimed plaintext under the
// claimed subkey with the blob's own IV and AAD, and compares the result with
// the stored `ciphertext || tag` in constant time. The output of that seal is
// compared and dropped, never returned or stored, so the (key, IV) pair it
// reuses produces nothing anyone sees. The stored blob is fixed by the server,
// not chosen by the caller, so a matching tag under a different key is a
// 2^-128 event: a match proves both the subkey and the plaintext.

import { buildAad, type MailboxAadContext } from "./aad"
import { decodeBlob } from "./blob"
import type { Bytes } from "./bytes"
import {
  type AttachmentStreamHeader,
  STREAM_TAG_BYTES,
  streamChunkAad,
  streamChunkCount,
  streamNonce,
} from "./stream-seal"

/** The D5 subkey length: AES-256. */
export const FIELD_SUBKEY_BYTES = 32

export interface SealedFieldClaim {
  /** The D5 subkey of this field (`deriveFieldSubkey`), as the opener derived it. */
  fieldKey: Bytes
  /** The binding the blob was sealed under, from a `mailboxAad` builder. */
  context: MailboxAadContext
  /** The stored blob. */
  blob: Bytes
  /** The plaintext the opener says the blob holds. */
  plaintext: Bytes
}

function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

/**
 * True only when `plaintext` sealed under `fieldKey`, with the blob's IV and
 * header, reproduces the stored blob byte for byte. Any malformed input is
 * false, never a throw.
 */
export async function sealedFieldMatches(claim: SealedFieldClaim): Promise<boolean> {
  if (claim.fieldKey.length !== FIELD_SUBKEY_BYTES) return false
  let decoded: ReturnType<typeof decodeBlob>
  try {
    decoded = decodeBlob(claim.blob)
  } catch {
    return false
  }
  const key = await crypto.subtle.importKey(
    "raw",
    claim.fieldKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  )
  const resealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: decoded.iv,
        additionalData: buildAad(decoded.header, claim.context),
        tagLength: 128,
      },
      key,
      claim.plaintext,
    ),
  )
  const matches = constantTimeEqual(resealed, decoded.body)
  resealed.fill(0)
  return matches
}

export interface SealedStreamClaim {
  /** The attachment's D5 subkey (`deriveFieldSubkey` over `mailboxAad.attachment(fileId)`). */
  streamKey: Bytes
  /** The file id the stream was sealed under (bound into every chunk's AAD). */
  fileId: string
  /** The stored envelope: nonce prefix, chunk size and count, plaintext length. */
  header: AttachmentStreamHeader
  /** The stored object: every chunk's `ciphertext || tag`, concatenated. */
  stored: Bytes
  /** The bytes the opener says the object holds. */
  plaintext: Bytes
}

/**
 * The same proof for a sealed attachment (STREAM, `stream-seal.ts`): true only
 * when `plaintext`, sealed chunk by chunk under `streamKey` with the stored
 * nonce prefix, chunk index, final flag and AAD, reproduces the stored object
 * byte for byte. Each chunk's output is compared and zeroed, never returned.
 * Any malformed input is false, never a throw.
 */
export async function sealedStreamMatches(claim: SealedStreamClaim): Promise<boolean> {
  const { header, stored, plaintext } = claim
  if (claim.streamKey.length !== FIELD_SUBKEY_BYTES) return false
  let chunkCount: number
  try {
    chunkCount = streamChunkCount(header.plaintextLength, header.chunkSize)
  } catch {
    return false
  }
  if (chunkCount !== header.chunkCount) return false
  if (plaintext.length !== header.plaintextLength) return false
  if (stored.length !== header.plaintextLength + chunkCount * STREAM_TAG_BYTES) return false
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      "raw",
      claim.streamKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    )
  } catch {
    return false
  }
  let plainOffset = 0
  let storedOffset = 0
  for (let index = 0; index < chunkCount; index++) {
    const piece = plaintext.subarray(
      plainOffset,
      Math.min(plainOffset + header.chunkSize, plaintext.length),
    )
    let iv: Bytes
    try {
      iv = streamNonce(header.noncePrefix, index, index === chunkCount - 1)
    } catch {
      return false
    }
    const resealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: streamChunkAad(header, claim.fileId, index),
          tagLength: 128,
        },
        key,
        piece,
      ),
    )
    const expected = stored.subarray(storedOffset, storedOffset + resealed.length)
    const matches = constantTimeEqual(resealed, expected)
    resealed.fill(0)
    if (!matches) return false
    plainOffset += piece.length
    storedOffset += expected.length
  }
  return storedOffset === stored.length
}
