// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attachment sealing, HOST SIDE (spec section 5.8).
//
// Message bodies are sealed in the sandbox's own call (`mailbox_seal`), but
// attachment bytes cannot be: the QuickJS heap is 32 MB and a base64 round trip
// through the bridge is itself the problem. So the host seals them, on the way
// into the object store, and the sandbox never sees a key. This file is the
// whole of that path.
//
// It imports the NAMED seal modules of `@liaison/mailbox-crypto`, never the
// package root and never `stream-open.ts`. `stream-seal.ts` is seal safe for
// exactly this reason: the server has to be able to encrypt an attachment, and
// must still have no way to decrypt one. T-SEC-1 walks the graph to prove it.
//
// What stays cleartext, deliberately: filename and MIME type. They are envelope
// level, the attachment list renders them with no key, and section 3.5 says so.

import { generateContentKey, sealContentKey } from "@liaison/mailbox-crypto/src/seal"
import { encryptAttachmentStream, STREAM_CHUNK_SIZE } from "@liaison/mailbox-crypto/src/stream-seal"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { quoteIdent } from "~/lib/sql-utils"
import { resolveActiveIdentity } from "~/modules/mailbox-crypto/identity-resolver"
import {
  assertMailboxWritable,
  type MailAccountCrypto,
  type MailboxSqlExecutor,
  mailboxRequiresSealing,
  resolveMailAccountCrypto,
  resolveSealRecipient,
} from "~/modules/mailbox-crypto/mail-writer"
import { loadOrCreateMailboxServerKeyPrivileged } from "~/modules/mailbox-crypto/managed-keys"
import { sealManagedAttachment } from "~/modules/mailbox-crypto/managed-seal"
import { MAILBOX_ENC_VERSION } from "~/modules/mailbox-crypto/seal-service"

/** The `kernel.files` columns a sealed attachment writes, in camelCase. */
export interface AttachmentSealColumns {
  encVersion: number
  contentKeyWrapped: Buffer
  /** Null for a managed (`enc_version = 2`) attachment. */
  contentKeyEpk: Buffer | null
  encKeyId: number
  chunkSize: number
  chunkCount: number
  plaintextLength: number
  /** Null for a managed (`enc_version = 2`) attachment. */
  noncePrefix: Buffer | null
}

export interface SealedAttachment {
  /** The bytes that go to object storage: the concatenated STREAM chunks. */
  body: Buffer
  columns: AttachmentSealColumns
}

/**
 * Seal one attachment's bytes to `userId`'s active identity.
 *
 * One content key per FILE, sealed once with ECDH-ES, then the whole file
 * encrypted under the STREAM construction so a truncated object fails closed
 * rather than decrypting to a short file. The server holds the content key for
 * the length of this call and no longer.
 */
export async function sealAttachmentBytes(input: {
  userId: string
  orgId: string
  /** The `kernel.files` id, minted by the caller. It is bound into the AAD. */
  fileId: string
  bytes: Uint8Array
  /** Test seam. Production uses the section 3.5 chunk size. */
  chunkSize?: number
}): Promise<SealedAttachment> {
  const identity = await resolveActiveIdentity(input.userId, input.orgId)
  const contentKey = generateContentKey()
  try {
    const { wrapped, epkSpki } = await sealContentKey({
      recipientEcdhSpki: identity.ecdhPublicKey as Uint8Array<ArrayBuffer>,
      userId: input.userId,
      keyId: identity.keyId,
      contentKey,
    })
    const stream = await encryptAttachmentStream({
      contentKey,
      fileId: input.fileId,
      keyId: identity.keyId,
      plaintextLength: input.bytes.byteLength,
      source: input.bytes as Uint8Array<ArrayBuffer>,
      chunkSize: input.chunkSize ?? STREAM_CHUNK_SIZE,
      version: MAILBOX_ENC_VERSION,
    })
    const parts: Buffer[] = []
    for await (const chunk of stream.chunks) parts.push(Buffer.from(chunk))
    return {
      body: Buffer.concat(parts),
      columns: {
        encVersion: stream.header.version,
        contentKeyWrapped: Buffer.from(wrapped),
        contentKeyEpk: Buffer.from(epkSpki),
        encKeyId: stream.header.keyId,
        chunkSize: stream.header.chunkSize,
        chunkCount: stream.header.chunkCount,
        plaintextLength: stream.header.plaintextLength,
        noncePrefix: Buffer.from(stream.header.noncePrefix),
      },
    }
  } finally {
    contentKey.fill(0)
  }
}

/**
 * Which mail parent an attachment can hang from, and where that parent records
 * its account. `outbound_staging` parents directly on the account row, which is
 * why its join column is `id` rather than `account_id`.
 */
const MAIL_ATTACHMENT_PARENTS: Record<string, { table: string; accountColumn: string }> = {
  message: { table: "messages", accountColumn: "account_id" },
  messages: { table: "messages", accountColumn: "account_id" },
  conversation: { table: "conversations", accountColumn: "account_id" },
  conversations: { table: "conversations", accountColumn: "account_id" },
  draft: { table: "drafts", accountColumn: "account_id" },
  drafts: { table: "drafts", accountColumn: "account_id" },
  outbound_staging: { table: "accounts", accountColumn: "id" },
}

/**
 * Resolve the mail account an attachment's parent belongs to, through the
 * CALLER'S transaction for the same reason `resolveMailAccountCrypto` does: a
 * parent the caller cannot see must not produce a seal, and a parent created in
 * the caller's own uncommitted transaction must still resolve.
 *
 * Returns null when the parent is not a mail parent this map knows. A null is a
 * "this is not a mailbox attachment", never a "seal was skipped": every mail
 * parent that exists is in the map.
 */
export async function resolveAttachmentMailAccount(
  tx: MailboxSqlExecutor,
  schemaName: string,
  orgId: string,
  entityType: string,
  entityId: string,
): Promise<MailAccountCrypto | null> {
  const parent = MAIL_ATTACHMENT_PARENTS[entityType]
  if (!parent) return null
  const schema = drizzleSql.raw(quoteIdent(schemaName))
  const table = drizzleSql.raw(quoteIdent(parent.table))
  const column = drizzleSql.raw(quoteIdent(parent.accountColumn))
  const rows = extractRows<{ account_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT ${column}::text AS account_id FROM ${schema}.${table}
       WHERE id = ${entityId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
  )
  const accountId = rows[0]?.account_id
  if (!accountId) return null
  return resolveMailAccountCrypto(tx, schemaName, orgId, accountId)
}

export interface MaybeSealAttachmentInput {
  tx: MailboxSqlExecutor
  schemaName: string
  /** The importing app. Only `mail` seals. */
  app: string
  entityType: string
  entityId: string
  orgId: string
  /** The acting user, captured by the bridge closure. Never a parameter of the
   *  sandbox call: a caller-chosen recipient would defeat the whole design. */
  userId: string
  fileId: string
  bytes: Uint8Array
  chunkSize?: number
}

/**
 * The single entry the file-import bridge calls.
 *
 * Returns the sealed body and its columns when the owning mailbox is a personal
 * one whose owner holds an active identity, and null when the attachment is not
 * mailbox content at all (a shared org mailbox, a ticket, an invoice).
 *
 * It THROWS rather than returning null when the mailbox is one that must be
 * sealed but cannot be: a `blocked` or `paused` account, or an account owned by
 * someone other than the acting user. Storing the bytes in the clear in those
 * states is precisely the failure this feature exists to prevent, so the import
 * fails instead.
 */
export async function maybeSealAttachmentForMail(
  input: MaybeSealAttachmentInput,
): Promise<SealedAttachment | null> {
  if (input.app !== "mail") return null
  // An account row the writer cannot see raises MAILBOX_ACCOUNT_NOT_FOUND out
  // of `resolveMailAccountCrypto`, deliberately uncaught: an invisible mailbox
  // is a refusal, not a licence to store the bytes unsealed.
  const account = await resolveAttachmentMailAccount(
    input.tx,
    input.schemaName,
    input.orgId,
    input.entityType,
    input.entityId,
  )
  if (!account) return null
  assertMailboxWritable(account, "files_importAttachment")
  if (!mailboxRequiresSealing(account)) return null
  // Inbound attachments arrive on the same headless sync as the message that
  // carries them, so the recipient is resolved from the account row rather than
  // required to equal the actor. A human actor who is not the owner is still
  // refused, and a shared mailbox has no recipient for anyone.
  const recipient = resolveSealRecipient(account, input.userId)
  if (account.encryptionState === "managed") {
    const dek = await loadOrCreateMailboxServerKeyPrivileged(input.orgId, account.id)
    try {
      const sealed = sealManagedAttachment({
        accountId: account.id,
        dek: dek.key,
        keyVersion: dek.keyVersion,
        fileId: input.fileId,
        bytes: input.bytes,
      })
      return {
        body: sealed.body,
        columns: { ...sealed.columns, contentKeyEpk: null, noncePrefix: null },
      }
    } finally {
      dek.key.fill(0)
    }
  }
  return sealAttachmentBytes({
    userId: recipient,
    orgId: input.orgId,
    fileId: input.fileId,
    bytes: input.bytes,
    chunkSize: input.chunkSize,
  })
}
