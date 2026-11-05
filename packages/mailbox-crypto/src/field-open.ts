// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`; T-SEC-1 asserts that no
// server entrypoint reaches this file.
//
// This is the primitive that turns a sealed mail body back into plaintext. It
// is deliberately alone in its own module so that importing `field-seal.ts`
// (which the server must do) cannot reach it.

import { buildAad, type MailboxAadContext } from "./aad"
import { decodeBlob } from "./blob"
import type { Bytes } from "./bytes"
import { deriveFieldSubkey, type KeyMaterial } from "./kdf"

export class MailboxOpenError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "MailboxOpenError"
    this.cause = cause
  }
}

export interface OpenFieldInput {
  contentKey: KeyMaterial
  context: MailboxAadContext
  blob: Bytes
}

/**
 * Decode the blob, rebuild the AAD from the DECODED header (so a flipped
 * version or key id byte changes the AAD and the tag check fails), derive the
 * same D5 subkey, and decrypt.
 */
export async function openField(input: OpenFieldInput): Promise<Bytes> {
  const decoded = decodeBlob(input.blob)
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
    ["decrypt"],
  )
  subkey.fill(0)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decoded.iv,
        additionalData: buildAad(decoded.header, input.context),
        tagLength: 128,
      },
      key,
      decoded.body,
    )
    return new Uint8Array(plaintext)
  } catch (error) {
    throw new MailboxOpenError(
      `sealed field did not authenticate under ${input.context.context}`,
      error,
    )
  }
}
