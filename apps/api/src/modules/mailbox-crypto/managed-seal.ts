// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Server-managed mailbox encryption, `enc_version = 2`: seal AND open.
//
// This is a separate format from the zero-access envelope (`enc_version = 1`,
// `@liaison/mailbox-crypto`). It uses only `lib/crypto.ts` (AES-256-GCM via
// `node:crypto`) and the context strings of the seal-safe `aad.ts`; it imports
// no client-only module, so T-SEC-1 still holds verbatim: the server has no code
// that can open a PRIVATE (v1) mailbox, and this file refuses any row that is
// not version 2.
//
// Per row: a random 32-byte content key, wrapped under the mailbox data key
// (`managed-keys.ts`) with AAD `mail:v2:ck:<accountId>`, and each field
// AES-256-GCM under the content key with AAD `mail:v2:<context>`, where
// `<context>` is the same section 3.4 string the v1 format binds
// (`mail.message:subject:<messageId>`, ...). So a field still cannot be moved
// between columns, rows or mailboxes and open. `content_key_epk` stays NULL and
// `enc_key_id` records the data key version.

import { randomBytes } from "node:crypto"
import { type MailboxAadContext, mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { decryptBytes, encryptBytes } from "~/lib/crypto"
import type { SealContextRef } from "~/modules/mailbox-crypto/seal-service"

/** The ciphertext version a managed mailbox writes. */
export const MAILBOX_MANAGED_ENC_VERSION = 2

/** True for a row (or file) sealed in the managed format. */
export function isManagedEncVersion(value: unknown): boolean {
  return Number(value ?? 0) === MAILBOX_MANAGED_ENC_VERSION
}

export function managedContentKeyAad(accountId: string): string {
  return `mail:v2:ck:${accountId}`
}

export function managedFieldAad(context: MailboxAadContext): string {
  return `mail:v2:${context.context}`
}

/** Resolve a seal context reference to its section 3.4 binding. */
export function managedContextOf(ref: SealContextRef, ownerUserId: string): MailboxAadContext {
  if (ref.kind === "index") {
    return mailboxAad.index(ownerUserId, ref.shardId ?? "")
  }
  const builder = mailboxAad[ref.kind] as (entityId: string) => MailboxAadContext
  return builder(ref.entityId)
}

export interface ManagedSealInput {
  accountId: string
  /** The mailbox data key (`loadMailboxServerKey`). Not zeroed here. */
  dek: Uint8Array
  items: Array<{ context: MailboxAadContext; plaintext: string | Uint8Array }>
}

export interface ManagedSealedBatch {
  contentKeyWrapped: Buffer
  items: Buffer[]
}

/** Seal a batch of fields of ONE row under one fresh content key. */
export function sealManaged(input: ManagedSealInput): ManagedSealedBatch {
  const ck = randomBytes(32)
  try {
    const contentKeyWrapped = encryptBytes(ck, input.dek, managedContentKeyAad(input.accountId))
    const items = input.items.map((item) =>
      encryptBytes(
        typeof item.plaintext === "string"
          ? Buffer.from(item.plaintext, "utf8")
          : Buffer.from(item.plaintext),
        ck,
        managedFieldAad(item.context),
      ),
    )
    return { contentKeyWrapped, items }
  } finally {
    ck.fill(0)
  }
}

export interface ManagedOpenInput {
  accountId: string
  dek: Uint8Array
  contentKeyWrapped: Uint8Array
  fields: Array<{ context: MailboxAadContext; ciphertext: Uint8Array | null | undefined }>
}

/**
 * Open the fields of one v2 row. A null ciphertext opens to null. Throws on any
 * authentication failure: a field that does not open is a fault, never shown as
 * empty.
 */
export function openManagedBytes(input: ManagedOpenInput): Array<Buffer | null> {
  const ck = decryptBytes(input.contentKeyWrapped, input.dek, managedContentKeyAad(input.accountId))
  try {
    return input.fields.map((field) =>
      field.ciphertext ? decryptBytes(field.ciphertext, ck, managedFieldAad(field.context)) : null,
    )
  } finally {
    ck.fill(0)
  }
}

/** `openManagedBytes`, decoded as UTF-8 text. */
export function openManaged(input: ManagedOpenInput): Array<string | null> {
  return openManagedBytes(input).map((b) => (b ? b.toString("utf8") : null))
}

// ── Attachments ──────────────────────────────────────────────────────────────

/** The `kernel.files` columns a managed attachment writes, in camelCase. */
export interface ManagedAttachmentColumns {
  encVersion: number
  contentKeyWrapped: Buffer
  encKeyId: number
  chunkSize: number
  chunkCount: number
  plaintextLength: number
}

/**
 * Seal an attachment in the managed format: one AES-256-GCM object under a
 * per-file content key, AAD `mail:v2:mail.attachment:<fileId>`. Stored as
 * `iv || tag || ciphertext`, recorded as one chunk of the whole length.
 */
export function sealManagedAttachment(input: {
  accountId: string
  dek: Uint8Array
  keyVersion: number
  fileId: string
  bytes: Uint8Array
}): { body: Buffer; columns: ManagedAttachmentColumns } {
  const sealed = sealManaged({
    accountId: input.accountId,
    dek: input.dek,
    items: [{ context: mailboxAad.attachment(input.fileId), plaintext: input.bytes }],
  })
  const body = sealed.items[0] as Buffer
  return {
    body,
    columns: {
      encVersion: MAILBOX_MANAGED_ENC_VERSION,
      contentKeyWrapped: sealed.contentKeyWrapped,
      encKeyId: input.keyVersion,
      chunkSize: input.bytes.byteLength,
      chunkCount: 1,
      plaintextLength: input.bytes.byteLength,
    },
  }
}

/** Open a managed attachment body sealed by {@link sealManagedAttachment}. */
export function openManagedAttachment(input: {
  accountId: string
  dek: Uint8Array
  fileId: string
  contentKeyWrapped: Uint8Array
  body: Uint8Array
}): Buffer {
  const [bytes] = openManagedBytes({
    accountId: input.accountId,
    dek: input.dek,
    contentKeyWrapped: input.contentKeyWrapped,
    fields: [{ context: mailboxAad.attachment(input.fileId), ciphertext: input.body }],
  })
  if (!bytes) throw new Error("managed attachment body is empty")
  return bytes
}
