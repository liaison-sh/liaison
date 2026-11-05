// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.9, the browser's half of outbound re-attachment. Spec
// sections 3.5, 5.4 and 5.8.
//
// WHY THIS EXISTS. Once attachments are sealed on the way into the object store
// (Task 7.2) the server holds ciphertext it cannot open, by design. A forward or
// a re-attach from an enrolled mailbox therefore has exactly two honest
// outcomes: the owner's browser hands over the real bytes, or nothing is sent.
// This module is the first of those. The send path's refusal is the second, and
// it is what happens whenever anything here throws.
//
// EVERY FAILURE IS A REFUSAL, and every one of them throws rather than
// returning what it managed to get:
//
//   * a locked mailbox,
//   * an object that does not authenticate (tampered bytes, wrong key),
//   * an object whose tail is missing (the whole-stream open catches it; the
//     range open structurally cannot, which is why the session opens whole),
//   * a request over the byte ceiling.
//
// A short, empty or partly-decrypted attachment mailed to a customer is worse
// than a send that did not happen: it looks like success on every screen.
//
// NOTHING HERE IS STORED. The plaintext is handed to the caller, travels in the
// body of one decide or one plaintext-response POST, and is dropped.

import type { MailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import type {
  OpenedAttachment,
  OpenOptions,
  SealedAttachmentPayload,
} from "~/modules/mailbox/crypto-protocol"
import { type Bytes, bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"

/** What `GET /api/files/:id/metadata` returns for the sealed half of a row. */
export interface AttachmentEncryptionView {
  encVersion: number
  keyId: number
  chunkSize: number
  chunkCount: number
  plaintextLength: number
  noncePrefixBase64: string
  contentKeyWrappedBase64: string
  contentKeyEpkBase64: string
}

/** The metadata envelope, as the route shapes it. Null encryption means the
 *  object is stored exactly as it arrived. */
export interface AttachmentMetadataView {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  encryption: AttachmentEncryptionView | null
}

/**
 * The same ceiling the server's approval fulfilment enforces
 * (`MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES`). Kept in step deliberately: a
 * client that decrypted more than the server will accept would do the work and
 * then be refused, which reads to the user as a mysterious failed send.
 */
export const ATTACHMENT_OPEN_MAX_BYTES = 25 * 1024 * 1024

export type AttachmentOpenFailure =
  | "mailbox_locked"
  | "metadata_unreadable"
  | "bytes_unreadable"
  | "too_large"

export class AttachmentOpenError extends Error {
  readonly code: AttachmentOpenFailure
  readonly fileId: string
  constructor(code: AttachmentOpenFailure, fileId: string, message: string) {
    super(message)
    this.name = "AttachmentOpenError"
    this.code = code
    this.fileId = fileId
  }
}

export interface AttachmentOpenerDeps {
  client: Pick<MailboxCryptoClient, "isUnlocked" | "openAttachment">
  /** `GET /api/files/:id/metadata`. */
  fetchMetadata(fileId: string): Promise<unknown>
  /** The stored object, whole. Ciphertext for a sealed row. */
  fetchCiphertext(fileId: string): Promise<Uint8Array | ArrayBuffer>
  /** Total decoded plaintext this call may produce. */
  maxBytes?: number
  /** Passed to every open (`withFieldKeys`: making a mailbox transparent only). */
  openOptions?: OpenOptions
}

function asBytes(value: Uint8Array | ArrayBuffer): Bytes {
  return (value instanceof Uint8Array ? value : new Uint8Array(value)) as Bytes
}

function readEncryption(raw: unknown, fileId: string): AttachmentEncryptionView | null {
  if (!raw || typeof raw !== "object") {
    throw new AttachmentOpenError(
      "metadata_unreadable",
      fileId,
      "this attachment's details could not be read, so nothing was opened",
    )
  }
  const encryption = (raw as { encryption?: unknown }).encryption
  if (encryption === null || encryption === undefined) return null
  if (typeof encryption !== "object") {
    throw new AttachmentOpenError(
      "metadata_unreadable",
      fileId,
      "this attachment says it is encrypted but its envelope is unreadable",
    )
  }
  const view = encryption as Record<string, unknown>
  const numbers = ["encVersion", "keyId", "chunkSize", "chunkCount", "plaintextLength"] as const
  const strings = ["noncePrefixBase64", "contentKeyWrappedBase64", "contentKeyEpkBase64"] as const
  for (const key of numbers) {
    if (typeof view[key] !== "number") {
      throw new AttachmentOpenError(
        "metadata_unreadable",
        fileId,
        `this attachment's envelope is missing ${key}, so nothing was opened`,
      )
    }
  }
  for (const key of strings) {
    if (typeof view[key] !== "string" || (view[key] as string).length === 0) {
      throw new AttachmentOpenError(
        "metadata_unreadable",
        fileId,
        `this attachment's envelope is missing ${key}, so nothing was opened`,
      )
    }
  }
  return {
    encVersion: view.encVersion as number,
    keyId: view.keyId as number,
    chunkSize: view.chunkSize as number,
    chunkCount: view.chunkCount as number,
    plaintextLength: view.plaintextLength as number,
    noncePrefixBase64: view.noncePrefixBase64 as string,
    contentKeyWrappedBase64: view.contentKeyWrappedBase64 as string,
    contentKeyEpkBase64: view.contentKeyEpkBase64 as string,
  }
}

/**
 * Build the function the approval fulfilment and the two-phase responder both
 * hand to their `openAttachments` slot.
 *
 * It resolves ALL the named files or none of them. A partial result would be
 * assembled into a message that quietly lost a file, and the caller has no way
 * to tell a deliberately empty result from a failed one.
 */
export function createAttachmentOpener(
  deps: AttachmentOpenerDeps,
): (fileIds: string[]) => Promise<OpenedAttachment[]> {
  const maxBytes = deps.maxBytes ?? ATTACHMENT_OPEN_MAX_BYTES
  return async (fileIds: string[]) => {
    if (fileIds.length === 0) return []
    if (!deps.client.isUnlocked()) {
      throw new AttachmentOpenError(
        "mailbox_locked",
        fileIds[0] ?? "",
        "this mailbox is locked, so its attachments cannot be made readable to send",
      )
    }
    const opened: OpenedAttachment[] = []
    let total = 0
    for (const fileId of fileIds) {
      const metadata = await deps.fetchMetadata(fileId).catch((error: unknown) => {
        throw new AttachmentOpenError(
          "metadata_unreadable",
          fileId,
          `this attachment could not be read (${String(error)}), so nothing was opened`,
        )
      })
      const encryption = readEncryption(metadata, fileId)
      const declared = encryption ? encryption.plaintextLength : 0
      if (declared > maxBytes || total + declared > maxBytes) {
        throw new AttachmentOpenError(
          "too_large",
          fileId,
          "these attachments are larger than one send may carry, so nothing was opened",
        )
      }
      const stored = asBytes(
        await deps.fetchCiphertext(fileId).catch((error: unknown) => {
          throw new AttachmentOpenError(
            "bytes_unreadable",
            fileId,
            `this attachment's bytes could not be read (${String(error)}), so nothing was opened`,
          )
        }),
      )
      if (!encryption) {
        // Not sealed: the server already holds these bytes in the clear, so
        // passing them straight through costs nothing and lets a send that
        // mixes a sealed and an unsealed attachment still go out whole. It is
        // the caller that decides which ids to ask for.
        if (total + stored.byteLength > maxBytes) {
          throw new AttachmentOpenError(
            "too_large",
            fileId,
            "these attachments are larger than one send may carry, so nothing was opened",
          )
        }
        total += stored.byteLength
        opened.push({ fileId, bytesBase64: bytesToBase64(stored) })
        continue
      }
      const sealed: SealedAttachmentPayload = {
        fileId,
        encVersion: encryption.encVersion,
        encKeyId: encryption.keyId,
        contentKeyWrapped: encryption.contentKeyWrappedBase64,
        contentKeyEpk: encryption.contentKeyEpkBase64,
        chunkSize: encryption.chunkSize,
        chunkCount: encryption.chunkCount,
        plaintextLength: encryption.plaintextLength,
        noncePrefix: encryption.noncePrefixBase64,
        ciphertext: bytesToBase64(stored),
      }
      // Anything the worker throws (a locked session, a chunk that did not
      // authenticate, a missing tail) becomes a refusal here.
      const result = await deps.client
        .openAttachment(sealed, deps.openOptions)
        .catch((error: unknown) => {
          throw new AttachmentOpenError(
            "bytes_unreadable",
            fileId,
            `this attachment did not decrypt (${String(error)}), so nothing was opened`,
          )
        })
      total += encryption.plaintextLength
      opened.push(result)
    }
    return opened
  }
}
