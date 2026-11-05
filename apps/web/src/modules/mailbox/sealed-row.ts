// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One sealed conversation row (the `/mail/conversations` list projection, or
// the conversation of `/mail/conversations/:id`) opened through the mailbox's
// crypto worker. The Mail inbox, a contact's related mail and the mail hover
// preview all read the same projection, so they all open it HERE: one decrypt
// path, never a second one per surface.

import type { OpenedConversation } from "~/modules/mailbox/crypto-protocol"
import { openSealedConversation } from "~/modules/mailbox/mailbox-store"

/** The sealed half of a conversation row, as the API projects it (base64). */
export interface SealedRowFields {
  id: string
  sealed?: boolean
  encVersion?: number | null
  encKeyId?: number | null
  contentKeyWrapped?: string | null
  contentKeyEpk?: string | null
  subjectCiphertext?: string | null
  snippetCiphertext?: string | null
  snippetSourceMessageId?: string | null
}

/** The server holds this row's subject and snippet as ciphertext only. */
export function isSealedRow(row: SealedRowFields): boolean {
  return row.sealed ?? Number(row.encVersion ?? 0) > 0
}

/** The row carries the envelope a worker needs to open it. */
export function canOpenSealedRow(row: SealedRowFields): boolean {
  return !!row.contentKeyWrapped && !!row.contentKeyEpk && row.encKeyId != null
}

/**
 * Open the row's subject and snippet. Null means the mailbox is locked (or
 * the row cannot be opened on this device), never an error.
 */
export async function openSealedRow(row: SealedRowFields): Promise<OpenedConversation | null> {
  if (!canOpenSealedRow(row)) return null
  return openSealedConversation({
    id: row.id,
    sourceMessageId: row.snippetSourceMessageId ?? null,
    encVersion: Number(row.encVersion ?? 1),
    encKeyId: Number(row.encKeyId),
    contentKeyWrapped: row.contentKeyWrapped as string,
    contentKeyEpk: row.contentKeyEpk as string,
    subjectCiphertext: row.subjectCiphertext ?? null,
    snippetCiphertext: row.snippetCiphertext ?? null,
  })
}
