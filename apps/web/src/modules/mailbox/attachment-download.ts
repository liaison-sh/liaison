// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Opening an attachment from the mail surface (spec section 3.5, journey (f)).
//
// A sealed attachment is stored as ciphertext the server cannot open, and the
// inline route serves exactly the stored bytes. So the plain download path,
// which blobs those bytes straight to disk under the original filename, hands
// the user an unopenable file that LOOKS like their invoice. This is the path
// that asks the crypto worker first.
//
// A locked mailbox REFUSES. Saving the stored bytes as a fallback would be the
// same silent corruption wearing an error handler.

import type { ApiClient } from "~/lib/api-client"
import { fetchFileBytes } from "~/modules/files/file-service"
import {
  type AttachmentMetadataView,
  AttachmentOpenError,
  createAttachmentOpener,
} from "~/modules/mailbox/attachment-opener"
import type { MailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { base64ToBytes } from "~/modules/mailbox/mailbox-bytes"
import { mailboxCryptoClient } from "~/modules/mailbox/mailbox-store"

export type SaveBytes = (
  bytes: Uint8Array,
  filename: string,
  mimeType?: string,
) => Promise<void> | void

export interface DownloadMailAttachmentInput {
  api: Pick<ApiClient, "get" | "rawGet">
  /** Null when no mailbox session is running in this tab. */
  client: Pick<MailboxCryptoClient, "isUnlocked" | "openAttachment"> | null
  file: { id: string; filename: string }
  save: SaveBytes
}

export async function downloadMailAttachment(input: DownloadMailAttachmentInput): Promise<void> {
  const metadata = await input.api.get<AttachmentMetadataView>(`/files/${input.file.id}/metadata`)

  if (!metadata?.encryption) {
    // Stored in the clear, so the bytes on the wire are the bytes to save,
    // from the object store directly when the server says it may.
    const response = await fetchFileBytes(input.api, input.file.id)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await input.save(bytes, input.file.filename, metadata?.mimeType)
    return
  }

  const client = input.client
  if (!client || !client.isUnlocked()) {
    throw new AttachmentOpenError(
      "mailbox_locked",
      input.file.id,
      "this mailbox is locked, so this attachment cannot be opened yet",
    )
  }

  const opener = createAttachmentOpener({
    client,
    fetchMetadata: async () => metadata,
    fetchCiphertext: async (fileId) => {
      const response = await input.api.rawGet(`/files/${fileId}/inline?download=1`)
      return await response.arrayBuffer()
    },
  })
  const [opened] = await opener([input.file.id])
  if (!opened) {
    throw new AttachmentOpenError(
      "bytes_unreadable",
      input.file.id,
      "this attachment did not decrypt, so nothing was saved",
    )
  }
  await input.save(base64ToBytes(opened.bytesBase64), input.file.filename, metadata.mimeType)
}

/** The browser save, kept out of the logic above so the logic is testable. */
export function saveBytesAsFile(bytes: Uint8Array, filename: string, mimeType?: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: mimeType || "application/octet-stream",
  })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.rel = "noopener"
    anchor.click()
  } finally {
    // Delay revocation so the click's navigation has started.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

/**
 * What the mail surface calls. The plaintext exists as a blob for as long as
 * the save takes and is never written anywhere else.
 */
export function openMailAttachment(
  api: Pick<ApiClient, "get" | "rawGet">,
  file: { id: string; filename: string },
): Promise<void> {
  return downloadMailAttachment({
    api,
    client: mailboxCryptoClient(),
    file,
    save: saveBytesAsFile,
  })
}
