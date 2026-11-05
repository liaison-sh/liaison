// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL ONLY. This module may run on the server.
//
// It holds `sealField` and nothing else. `openField` lives in `field-open.ts`,
// which is client only, because a decrypt primitive must never share a file
// with a primitive the server needs: the server's seal service would otherwise
// drag body decryption into the `apps/api` import graph while T-SEC-1 still
// reported green (Appendix C A5). Apply the same rule to any module pair added
// later.
//
// Anything both halves need lives in `kdf.ts`, `aad.ts`, `blob.ts` or
// `bytes.ts`, which are seal-safe.

import { buildAad, type MailboxAadContext } from "./aad"
import { BLOB_IV_BYTES, blobHeader, encodeBlob, MAILBOX_ENC_VERSION } from "./blob"
import type { Bytes } from "./bytes"
import { deriveFieldSubkey, type KeyMaterial } from "./kdf"

export interface SealFieldInput {
  /** The per-message (or per-attachment) content key. */
  contentKey: KeyMaterial
  /** The object's binding, from a `mailboxAad` builder. Never a raw string. */
  context: MailboxAadContext
  /** The identity key id the content key was sealed to. One byte. */
  keyId: number
  plaintext: Bytes
  /** Present so a future version 2 has a seam. Defaults to the only version. */
  version?: number
}

/**
 * Derive the per-field subkey (D5), draw a fresh 12 byte IV, AES-256-GCM under
 * the section 3.4 AAD, and emit a blob.
 *
 * The IV is drawn from `crypto.getRandomValues` on every call. A counter is
 * forbidden: several plaintexts live under one message's content key, distinct
 * AADs do not rescue a repeated (key, IV) pair because AAD never enters
 * keystream generation, and the snippet is by construction a prefix of the
 * body, so one nonce collision between them discloses body plaintext directly.
 */
export async function sealField(input: SealFieldInput): Promise<Bytes> {
  const version = input.version ?? MAILBOX_ENC_VERSION
  const header = blobHeader(version, input.keyId)
  const subkey = await deriveFieldSubkey({
    contentKey: input.contentKey,
    fieldName: input.context.fieldName,
    entityId: input.context.entityId,
  })
  const key = await crypto.subtle.importKey(
    "raw",
    subkey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  )
  subkey.fill(0)
  const iv = crypto.getRandomValues(new Uint8Array(BLOB_IV_BYTES))
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        additionalData: buildAad(header, input.context),
        tagLength: 128,
      },
      key,
      input.plaintext,
    ),
  )
  return encodeBlob({ version, keyId: input.keyId, iv, ciphertextWithTag })
}
