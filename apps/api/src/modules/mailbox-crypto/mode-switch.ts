// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Moving one personal mailbox between the two encryption modes, as a
// RESUMABLE conversion.
//
// While a conversion runs, `encryption_state` keeps the mode the mailbox is
// LEAVING and `encryption_conversion` names the direction (`to_private`,
// `to_managed`). So every writer keeps sealing in the format of the current
// mode, every reader keeps opening what it opens today, and an interrupted run
// leaves a mailbox that works and simply picks up where it stopped. The state
// flips only at the END, under the account's row lock (FOR UPDATE), after a
// recount under that lock finds nothing left in the old format: writers take
// the same row FOR SHARE for their whole transaction (`resolveMailAccountCrypto`),
// so no row in the old format can be committed between the recount and the flip.
//
// MAKE PRIVATE (transparent -> zero-access). The server does it alone: it holds
// the mailbox's data key, so it opens each server-managed (v2) row, message,
// draft, conversation and attachment, and seals it to the owner's identity with
// the existing seal-only path (v1). The final step converts any row that arrived
// meanwhile, flips the state to `ready` and destroys the data keys in the same
// transaction: from then on the server can read none of it, exactly as for a
// mailbox that was always private, and no key can be minted for it again
// (`ensureMailboxServerKey` refuses a mailbox that is not transparent).
//
// MAKE TRANSPARENT (zero-access -> transparent). The server cannot open a v1
// row, by design (T-SEC-1). The owner's unlocked browser lists what is still v1
// (messages with their sealed extra headers, drafts, conversations,
// attachments), opens each and hands the server the plaintext of its OWN
// mailbox; the server seals it under the mailbox's data key (v2). Starting the
// move takes a fresh step-up (the caller's `confirmStepUp`), so a session alone
// cannot begin it. Each row comes back with the per-field subkeys (D5) the
// browser opened it with, and is written only when every sealed field's claimed
// plaintext re-seals to the stored blob under its subkey (`sealedFieldMatches`):
// a caller who cannot open the mailbox cannot substitute content. Attachments
// are proven the same way, chunk by chunk against the stored object
// (`sealedStreamMatches`). Completing the move tells the owner in their feed.
// A row the browser opened from a stale copy is refused (its content key
// changed since), never overwritten. The browser opens v1 rows throughout, since the mailbox
// stays `ready` until the end. The final step flips to `managed` once nothing
// v1 is left. Never offered where the deployment keeps mailboxes private.
//
// Attachment derivatives (thumbnails, descriptions) are never kept for either
// sealed format, so there is nothing of theirs to convert.

import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { sealedFieldMatches, sealedStreamMatches } from "@liaison/mailbox-crypto/src/field-verify"
import { STREAM_TAG_BYTES } from "@liaison/mailbox-crypto/src/stream-seal"
import type { ShippedLocale } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { quoteIdent } from "~/lib/sql-utils"
import { sealAttachmentBytes } from "~/modules/mailbox-crypto/attachment-seal"
import { mailboxEncryptionSettings } from "~/modules/mailbox-crypto/encryption-mode"
import {
  type MailboxCallerTx,
  resolveActiveIdentity,
} from "~/modules/mailbox-crypto/identity-resolver"
import {
  type MailAccountCrypto,
  type MailboxSealEntity,
  pointConversationAtMessage,
  sealMailFields,
} from "~/modules/mailbox-crypto/mail-writer"
import {
  destroyMailboxServerKeys,
  ensureMailboxServerKey,
  loadMailboxServerKeyPrivileged,
} from "~/modules/mailbox-crypto/managed-keys"
import { openManagedFile, openManagedMailRows } from "~/modules/mailbox-crypto/managed-open"
import { sealManagedAttachment } from "~/modules/mailbox-crypto/managed-seal"

export class MailboxModeSwitchError extends Error {
  constructor(
    readonly code:
      | "MAILBOX_NOT_FOUND"
      | "MAILBOX_NOT_OWNER"
      | "MAILBOX_WRONG_STATE"
      | "PRIVATE_NOT_ALLOWED"
      | "TRANSPARENT_NOT_OFFERED"
      | "NOT_ENROLLED"
      | "CONVERSION_UNFINISHED",
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "MailboxModeSwitchError"
  }
}

type Exec = MailboxCallerTx

export type MailboxConversion = "to_private" | "to_managed"

const mail = () => drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
const kernel = () => drizzleSql.raw(quoteIdent(schemaRef("kernel")))
const MAIL_SCHEMA = () => schemaRef("app_mail")
const BATCH = 100
const FILE_BATCH = 10
/** How many passes the final step makes over rows that arrived meanwhile. */
const FINAL_PASSES = 20

const FIELD_COLUMNS: Record<MailboxSealEntity, Record<string, string>> = {
  messages: {
    subject: "subject",
    textBody: "text_body",
    htmlBody: "html_body",
    snippet: "snippet",
  },
  conversations: { subject: "subject", snippet: "snippet" },
  drafts: { subject: "subject", body: "text_body", htmlBody: "html_body" },
}

interface AccountRow {
  id: string
  owner_type: string
  owner_id: string | null
  encryption_state: string
  encryption_conversion: MailboxConversion | null
}

/**
 * The mailbox, checked to be `userId`'s own personal mailbox. With `lock`, its
 * row is locked FOR UPDATE until the caller's transaction ends: every writer
 * holds it FOR SHARE while it writes, so nothing is written to the mailbox
 * meanwhile.
 */
async function ownedAccount(
  tx: Exec,
  orgId: string,
  userId: string,
  accountId: string,
  lock = false,
): Promise<AccountRow> {
  const row = extractRows<AccountRow>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, owner_type, owner_id::text AS owner_id, encryption_state,
             encryption_conversion
        FROM ${mail()}.accounts WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid
        ${lock ? drizzleSql`FOR UPDATE` : drizzleSql``}`),
  )[0]
  if (!row) throw new MailboxModeSwitchError("MAILBOX_NOT_FOUND", `mailbox ${accountId} not found`)
  if (row.owner_type !== "user" || row.owner_id !== userId) {
    throw new MailboxModeSwitchError(
      "MAILBOX_NOT_OWNER",
      "only the owner of a personal mailbox can change how it is encrypted",
    )
  }
  return row
}

async function setUpdate(tx: Exec, entity: string, id: string, columns: Record<string, unknown>) {
  const assignments = Object.entries(columns).map(
    ([name, value]) =>
      drizzleSql`${drizzleSql.raw(quoteIdent(name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)))} = ${value}`,
  )
  await tx.execute(drizzleSql`
    UPDATE ${mail()}.${drizzleSql.raw(quoteIdent(entity))}
       SET ${drizzleSql.join(assignments, drizzleSql.raw(", "))}
     WHERE id = ${id}::uuid`)
}

/** The attachments of one mailbox: of its messages, its drafts, its outbound staging. */
function accountFilesWhere(orgId: string, accountId: string) {
  return drizzleSql`f.org_id = ${orgId}::uuid AND (
    (f.entity_type IN ('message', 'messages') AND f.entity_id::text IN
       (SELECT id::text FROM ${mail()}.messages WHERE account_id = ${accountId}::uuid))
    OR (f.entity_type IN ('draft', 'drafts') AND f.entity_id::text IN
       (SELECT id::text FROM ${mail()}.drafts WHERE account_id = ${accountId}::uuid))
    OR (f.entity_type = 'outbound_staging' AND f.entity_id::text = ${accountId})
  )`
}

/** How many artifacts of the mailbox are still sealed in `encVersion`. */
export interface ConversionCounts {
  messages: number
  drafts: number
  conversations: number
  files: number
}

export function conversionTotal(counts: ConversionCounts): number {
  return counts.messages + counts.drafts + counts.conversations + counts.files
}

async function sealedCounts(
  tx: Exec,
  orgId: string,
  accountId: string,
  encVersion: 1 | 2,
): Promise<ConversionCounts> {
  const row = extractRows<ConversionCounts>(
    await tx.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM ${mail()}.messages
          WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid
            AND enc_version = ${encVersion}) AS messages,
        (SELECT count(*)::int FROM ${mail()}.drafts
          WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid
            AND enc_version = ${encVersion}) AS drafts,
        (SELECT count(*)::int FROM ${mail()}.conversations
          WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid
            AND enc_version = ${encVersion}) AS conversations,
        (SELECT count(*)::int FROM ${kernel()}.files f
          WHERE ${accountFilesWhere(orgId, accountId)} AND f.enc_version = ${encVersion}) AS files`),
  )[0]
  return {
    messages: Number(row?.messages ?? 0),
    drafts: Number(row?.drafts ?? 0),
    conversations: Number(row?.conversations ?? 0),
    files: Number(row?.files ?? 0),
  }
}

/**
 * Write a re-sealed attachment: the row first, then the object, both before
 * the transaction commits. A failed upload rolls the row back, so the row and
 * the object never name two different formats except if the commit itself
 * fails after the upload.
 */
async function writeResealedFile(
  tx: Exec,
  file: { id: string; storage_key: string },
  columns: {
    encVersion: number
    contentKeyWrapped: Buffer
    contentKeyEpk: Buffer | null
    encKeyId: number
    chunkSize: number
    chunkCount: number
    plaintextLength: number
    noncePrefix: Buffer | null
  },
  body: Buffer,
  contentType: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    UPDATE ${kernel()}.files
       SET enc_version = ${columns.encVersion}, content_key_wrapped = ${columns.contentKeyWrapped},
           content_key_epk = ${columns.contentKeyEpk}, enc_key_id = ${columns.encKeyId},
           chunk_size = ${columns.chunkSize}, chunk_count = ${columns.chunkCount},
           plaintext_length = ${columns.plaintextLength}, nonce_prefix = ${columns.noncePrefix}
     WHERE id = ${file.id}::uuid`)
  const { putObject } = await import("~/infra/storage/object-storage")
  await putObject({ key: file.storage_key, body, contentType })
}

// ── Make private ─────────────────────────────────────────────────────────────

export interface MakePrivateResult extends ConversionCounts {
  /** True once the mailbox is private and its server keys are destroyed. */
  done: boolean
}

/** Re-seal up to `limit` v2 rows of one entity to the owner (v1). Returns how many. */
async function convertRowsToPrivate(
  tx: Exec,
  entity: MailboxSealEntity,
  orgId: string,
  userId: string,
  accountId: string,
  limit: number,
): Promise<number> {
  const rows = extractRows<Record<string, unknown> & { id: string }>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${mail()}.${drizzleSql.raw(quoteIdent(entity))}
       WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid AND enc_version = 2
       ORDER BY id LIMIT ${limit}`),
  )
  const privateAccount: Pick<MailAccountCrypto, "id" | "encryptionState"> = {
    id: accountId,
    encryptionState: "ready",
  }
  for (const row of rows) {
    const source =
      entity === "conversations" ? (row.snippet_source_message_id as string | null) : null
    if (source) {
      const sourceVersion = extractRows<{ v: number }>(
        await tx.execute(drizzleSql`
          SELECT enc_version AS v FROM ${mail()}.messages WHERE id = ${source}::uuid`),
      )[0]?.v
      // The conversation copies its message's ciphertext: follow it once the
      // message is private. A message gone or not converted yet: re-seal the
      // conversation's own copy instead.
      if (Number(sourceVersion) === 1) {
        await pointConversationAtMessage(tx, MAIL_SCHEMA(), orgId, row.id, source)
        continue
      }
    }
    await resealRowToPrivate(tx, entity, row, orgId, userId, accountId, privateAccount)
  }
  return rows.length
}

async function convertFilesToPrivate(
  tx: Exec,
  orgId: string,
  userId: string,
  accountId: string,
  limit: number,
): Promise<number> {
  const files = extractRows<{ id: string; storage_key: string }>(
    await tx.execute(drizzleSql`
      SELECT f.id::text AS id, f.storage_key FROM ${kernel()}.files f
       WHERE ${accountFilesWhere(orgId, accountId)} AND f.enc_version = 2
       ORDER BY f.id LIMIT ${limit}`),
  )
  for (const file of files) {
    const opened = await openManagedFile(tx, {
      orgId,
      userId,
      fileId: file.id,
      purpose: { kind: "reseal" },
    })
    const sealed = await sealAttachmentBytes({
      userId,
      orgId,
      fileId: file.id,
      bytes: opened.bytes,
      on: tx,
    })
    await writeResealedFile(tx, file, sealed.columns, sealed.body, opened.mimeType)
  }
  return files.length
}

const PRIVATE_STEPS: Array<{ key: keyof ConversionCounts; entity?: MailboxSealEntity }> = [
  { key: "messages", entity: "messages" },
  { key: "drafts", entity: "drafts" },
  { key: "conversations", entity: "conversations" },
  { key: "files" },
]

async function convertBatchToPrivate(
  tx: Exec,
  step: (typeof PRIVATE_STEPS)[number],
  orgId: string,
  userId: string,
  accountId: string,
): Promise<number> {
  return step.entity
    ? convertRowsToPrivate(tx, step.entity, orgId, userId, accountId, BATCH)
    : convertFilesToPrivate(tx, orgId, userId, accountId, FILE_BATCH)
}

/**
 * Make a transparent mailbox private, or finish doing so after an interrupted
 * run. Idempotent: a mailbox already private returns `done` with nothing done.
 */
export async function makeMailboxPrivate(input: {
  orgId: string
  userId: string
  accountId: string
}): Promise<MakePrivateResult> {
  const { orgId, userId, accountId } = input
  const result: MakePrivateResult = {
    messages: 0,
    drafts: 0,
    conversations: 0,
    files: 0,
    done: false,
  }
  const start = await withPrivilegedDb(orgId, "mailbox-mode:make-private:check", async (tx) => {
    const account = await ownedAccount(tx, orgId, userId, accountId)
    if (account.encryption_state === "ready" && account.encryption_conversion === null) {
      return "already_private" as const
    }
    const settings = await mailboxEncryptionSettings(tx, orgId, userId)
    if (!settings.allowPrivate && account.encryption_conversion !== "to_private") {
      throw new MailboxModeSwitchError(
        "PRIVATE_NOT_ALLOWED",
        "your organization does not allow private mailboxes",
      )
    }
    if (account.encryption_state !== "managed" || account.encryption_conversion === "to_managed") {
      throw new MailboxModeSwitchError(
        "MAILBOX_WRONG_STATE",
        `mailbox is "${account.encryption_state}"${account.encryption_conversion ? ` (${account.encryption_conversion})` : ""}, not transparent`,
      )
    }
    return "convert" as const
  })
  if (start === "already_private") return { ...result, done: true }
  // The owner needs a keyring to seal to: the mailbox password is set first.
  try {
    await resolveActiveIdentity(userId, orgId)
  } catch {
    throw new MailboxModeSwitchError(
      "NOT_ENROLLED",
      "set up your mailbox password first: a private mailbox is sealed to a key only you hold",
    )
  }
  await withPrivilegedDb(orgId, "mailbox-mode:make-private:begin", async (tx) => {
    await ownedAccount(tx, orgId, userId, accountId, true)
    await tx.execute(drizzleSql`
      UPDATE ${mail()}.accounts SET encryption_conversion = 'to_private'
       WHERE id = ${accountId}::uuid AND encryption_state = 'managed'
         AND encryption_conversion IS NULL`)
    // Choosing privacy is recorded as this person's pick when they had none.
    await tx.execute(drizzleSql`
      UPDATE ${kernel()}.users
         SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb), '{mail}',
           COALESCE(settings -> 'mail', '{}'::jsonb) || '{"encryptionPreference":"private"}'::jsonb,
           true)
       WHERE id = ${userId}::uuid
         AND NULLIF(settings -> 'mail' ->> 'encryptionPreference', '') IS NULL`)
  })

  // The bulk, a batch per transaction, each under the row lock so a writer
  // never re-seals a row this batch is converting.
  for (const step of PRIVATE_STEPS) {
    for (;;) {
      const n = await withPrivilegedDb(
        orgId,
        `mailbox-mode:make-private:${step.key}`,
        async (tx) => {
          await ownedAccount(tx, orgId, userId, accountId, true)
          return convertBatchToPrivate(tx, step, orgId, userId, accountId)
        },
      )
      result[step.key] += n
      if (n === 0) break
    }
  }

  // The end, in ONE transaction under the row lock: whatever arrived since,
  // a recount that must find nothing, the flip and the destruction of the keys.
  await withPrivilegedDb(orgId, "mailbox-mode:make-private:finish", async (tx) => {
    const account = await ownedAccount(tx, orgId, userId, accountId, true)
    if (account.encryption_state !== "managed" || account.encryption_conversion !== "to_private") {
      return
    }
    for (let pass = 0; pass < FINAL_PASSES; pass++) {
      let moved = 0
      for (const step of PRIVATE_STEPS) {
        const n = await convertBatchToPrivate(tx, step, orgId, userId, accountId)
        result[step.key] += n
        moved += n
      }
      if (moved === 0) break
    }
    const left = await sealedCounts(tx, orgId, accountId, 2)
    if (conversionTotal(left) > 0) {
      throw new MailboxModeSwitchError(
        "CONVERSION_UNFINISHED",
        `${conversionTotal(left)} items are still transparent; try again`,
      )
    }
    await tx.execute(drizzleSql`
      UPDATE ${mail()}.accounts SET encryption_state = 'ready', encryption_conversion = NULL
       WHERE id = ${accountId}::uuid`)
    await destroyMailboxServerKeys(tx, orgId, accountId)
  })
  result.done = true
  return result
}

async function resealRowToPrivate(
  tx: Exec,
  entity: MailboxSealEntity,
  row: Record<string, unknown> & { id: string },
  orgId: string,
  userId: string,
  accountId: string,
  account: Pick<MailAccountCrypto, "id" | "encryptionState">,
): Promise<void> {
  const opened = await openManagedMailRows({
    orgId,
    accountId,
    entity,
    rows: [row],
    actor: { userId },
    purpose: { kind: "reseal" },
    on: tx,
  })
  const fields = opened.get(row.id) ?? {}
  const values: Record<string, string | null> = {}
  for (const field of Object.keys(FIELD_COLUMNS[entity])) values[field] = fields[field] ?? null
  let headers: Record<string, unknown> | null = null
  if (entity === "messages" && fields.rawHeaders) {
    try {
      headers = JSON.parse(fields.rawHeaders) as Record<string, unknown>
    } catch {
      headers = null
    }
  }
  const sealed = await sealMailFields({
    userId,
    orgId,
    entity,
    entityId: row.id,
    values,
    headers,
    account,
    on: tx,
  })
  await setUpdate(tx, entity, row.id, {
    ...clearedSealedColumns(entity),
    ...sealed.columns,
    ...(entity === "conversations" ? { snippetSourceMessageId: null } : {}),
  })
}

function clearedSealedColumns(entity: MailboxSealEntity): Record<string, null> {
  const cols: Record<string, null> = { contentKeyEpk: null }
  if (entity === "messages") {
    for (const c of [
      "subjectCiphertext",
      "textBodyCiphertext",
      "htmlBodyCiphertext",
      "snippetCiphertext",
      "rawHeadersCiphertext",
    ])
      cols[c] = null
  } else if (entity === "drafts") {
    for (const c of ["subjectCiphertext", "bodyCiphertext", "htmlBodyCiphertext"]) cols[c] = null
  } else {
    for (const c of ["subjectCiphertext", "snippetCiphertext"]) cols[c] = null
  }
  return cols
}

// ── Make transparent ─────────────────────────────────────────────────────────

/**
 * Start (or resume) making a private mailbox transparent. Starting it calls
 * `confirmStepUp` (which throws unless the caller re-proved who they are);
 * resuming a move already under way, or a mailbox already transparent, does not.
 */
export async function beginMakeMailboxTransparent(input: {
  orgId: string
  userId: string
  accountId: string
  /** Runs inside the begin transaction, before anything changes. */
  confirmStepUp: (tx: PrivilegedDb) => Promise<void>
}): Promise<void> {
  const { orgId, userId, accountId } = input
  await withPrivilegedDb(orgId, "mailbox-mode:make-transparent:begin", async (tx) => {
    const account = await ownedAccount(tx, orgId, userId, accountId, true)
    const settings = await mailboxEncryptionSettings(tx, orgId, userId)
    if (!settings.canMakeTransparent) {
      throw new MailboxModeSwitchError(
        "TRANSPARENT_NOT_OFFERED",
        "this deployment keeps mailboxes private by default",
      )
    }
    if (account.encryption_state === "managed" && account.encryption_conversion === null) return
    if (
      account.encryption_state !== "ready" ||
      (account.encryption_conversion !== null && account.encryption_conversion !== "to_managed")
    ) {
      throw new MailboxModeSwitchError(
        "MAILBOX_WRONG_STATE",
        `mailbox is "${account.encryption_state}", not private`,
      )
    }
    if (account.encryption_conversion === null) await input.confirmStepUp(tx)
    await tx.execute(drizzleSql`
      UPDATE ${mail()}.accounts SET encryption_conversion = 'to_managed'
       WHERE id = ${accountId}::uuid AND encryption_state = 'ready'`)
    await ensureMailboxServerKey(tx, orgId, accountId)
  })
}

async function requireConvertingToManaged(
  tx: Exec,
  orgId: string,
  userId: string,
  accountId: string,
  lock: boolean,
): Promise<AccountRow> {
  const account = await ownedAccount(tx, orgId, userId, accountId, lock)
  if (account.encryption_state !== "ready" || account.encryption_conversion !== "to_managed") {
    throw new MailboxModeSwitchError(
      "MAILBOX_WRONG_STATE",
      "start making the mailbox transparent first",
    )
  }
  return account
}

export type TransparentPendingEntity = "messages" | "drafts" | "conversations" | "files"

function base64(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) return value.toString("base64")
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Buffer.from(value.slice(2), "hex").toString("base64")
  }
  return null
}

/**
 * The next rows of the mailbox still sealed private (v1), in id order after
 * `after`, with exactly what the owner's browser needs to open them. Files
 * carry their id only: the browser reads them through the files routes, as it
 * does to download one.
 */
export async function listTransparentPending(input: {
  orgId: string
  userId: string
  accountId: string
  entity: TransparentPendingEntity
  after?: string | null
  limit?: number
}): Promise<{ items: Array<Record<string, unknown>>; next: string | null }> {
  const { orgId, userId, accountId, entity } = input
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const after = input.after ?? "00000000-0000-0000-0000-000000000000"
  return withPrivilegedDb(orgId, "mailbox-mode:make-transparent:pending", async (tx) => {
    await requireConvertingToManaged(tx, orgId, userId, accountId, false)
    if (entity === "files") {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT f.id::text AS id FROM ${kernel()}.files f
           WHERE ${accountFilesWhere(orgId, accountId)} AND f.enc_version = 1
             AND f.id > ${after}::uuid
           ORDER BY f.id LIMIT ${limit}`),
      )
      return {
        items: rows.map((r) => ({ id: r.id })),
        next: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
      }
    }
    const rows = extractRows<Record<string, unknown> & { id: string }>(
      await tx.execute(drizzleSql`
        SELECT * FROM ${mail()}.${drizzleSql.raw(quoteIdent(entity))}
         WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid AND enc_version = 1
           AND id > ${after}::uuid
         ORDER BY id LIMIT ${limit}`),
    )
    const items = rows.map((r) => {
      const common = {
        id: r.id,
        encVersion: Number(r.enc_version),
        encKeyId: Number(r.enc_key_id),
        contentKeyWrapped: base64(r.content_key_wrapped),
        contentKeyEpk: base64(r.content_key_epk),
        subjectCiphertext: base64(r.subject_ciphertext),
      }
      if (entity === "messages") {
        return {
          ...common,
          textBodyCiphertext: base64(r.text_body_ciphertext),
          htmlBodyCiphertext: base64(r.html_body_ciphertext),
          snippetCiphertext: base64(r.snippet_ciphertext),
          rawHeadersCiphertext: base64(r.raw_headers_ciphertext),
        }
      }
      if (entity === "drafts") {
        return {
          ...common,
          bodyCiphertext: base64(r.body_ciphertext),
          htmlBodyCiphertext: base64(r.html_body_ciphertext),
        }
      }
      return {
        ...common,
        sourceMessageId: (r.snippet_source_message_id as string | null) ?? null,
        snippetCiphertext: base64(r.snippet_ciphertext),
      }
    })
    return { items, next: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null }
  })
}

export interface TransparentBatchItem {
  id: string
  /** The row's content key as the browser read it (base64): a stale copy is refused. */
  contentKeyWrapped: string
  subject?: string | null
  textBody?: string | null
  htmlBody?: string | null
  snippet?: string | null
  /** Messages: the sealed extra headers, opened, as JSON text. */
  rawHeaders?: string | null
  /**
   * Per sealed field (by the names above), the base64 D5 subkey the browser
   * opened it with: the proof that the plaintext is what the row holds.
   */
  fieldKeys?: Record<string, string>
}

type TransparentField = "subject" | "textBody" | "htmlBody" | "snippet" | "rawHeaders"

/** Which stored column and AAD binding each field of a batch item is checked against. */
function transparentFieldBindings(
  entity: "messages" | "drafts" | "conversations",
  row: Record<string, unknown> & { id: string },
): Array<[TransparentField, string, ReturnType<typeof mailboxAad.messageSubject>]> {
  const id = row.id
  if (entity === "messages") {
    return [
      ["subject", "subject_ciphertext", mailboxAad.messageSubject(id)],
      ["textBody", "text_body_ciphertext", mailboxAad.messageTextBody(id)],
      ["htmlBody", "html_body_ciphertext", mailboxAad.messageHtmlBody(id)],
      ["snippet", "snippet_ciphertext", mailboxAad.messageSnippet(id)],
      ["rawHeaders", "raw_headers_ciphertext", mailboxAad.messageHeaders(id)],
    ]
  }
  if (entity === "drafts") {
    return [
      ["subject", "subject_ciphertext", mailboxAad.draftSubject(id)],
      ["textBody", "body_ciphertext", mailboxAad.draftBody(id)],
      ["htmlBody", "html_body_ciphertext", mailboxAad.draftBody(`${id}:html`)],
    ]
  }
  // A pointer row holds a copy of one message's ciphertext, bound to that message.
  const source = (row.snippet_source_message_id as string | null) ?? null
  return [
    [
      "subject",
      "subject_ciphertext",
      source ? mailboxAad.messageSubject(source) : mailboxAad.conversationSubject(id),
    ],
    [
      "snippet",
      "snippet_ciphertext",
      source ? mailboxAad.messageSnippet(source) : mailboxAad.conversationSnippet(id),
    ],
  ]
}

function storedBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  const encoded = base64(value)
  return encoded === null ? null : new Uint8Array(Buffer.from(encoded, "base64"))
}

/**
 * The item's plaintext, field by field, when every sealed field of the stored
 * row is proven: its claimed plaintext re-seals to the stored blob under the
 * claimed subkey. A field the row does not hold must come back empty. Null
 * when anything is missing or does not match.
 */
async function provenPlaintext(
  entity: "messages" | "drafts" | "conversations",
  row: Record<string, unknown> & { id: string },
  item: TransparentBatchItem,
): Promise<Partial<Record<TransparentField, string | null>> | null> {
  const out: Partial<Record<TransparentField, string | null>> = {}
  for (const [field, column, context] of transparentFieldBindings(entity, row)) {
    const blob = storedBytes(row[column])
    const claimed = item[field]
    if (!blob) {
      if (claimed) return null
      out[field] = null
      continue
    }
    const key = item.fieldKeys?.[field]
    if (typeof claimed !== "string" || typeof key !== "string") return null
    const matches = await sealedFieldMatches({
      fieldKey: new Uint8Array(Buffer.from(key, "base64")),
      context,
      blob,
      plaintext: new TextEncoder().encode(claimed),
    })
    if (!matches) return null
    out[field] = claimed
  }
  return out
}

export interface TransparentBatchInput {
  messages?: TransparentBatchItem[]
  drafts?: TransparentBatchItem[]
  conversations?: TransparentBatchItem[]
}

function sameContentKey(stored: unknown, sent: string): boolean {
  const current = base64(stored)
  return current !== null && current === sent
}

/**
 * Re-seal rows the owner's browser opened, under the mailbox's data key. Only
 * rows of THIS mailbox, still at v1 and still holding the content key the
 * browser opened, are written; anything else is skipped and reported.
 */
export async function applyTransparentBatch(input: {
  orgId: string
  userId: string
  accountId: string
  batch: TransparentBatchInput
}): Promise<{ resealed: number; skipped: string[] }> {
  const { orgId, userId, accountId } = input
  return withPrivilegedDb(orgId, "mailbox-mode:make-transparent:batch", async (tx) => {
    await requireConvertingToManaged(tx, orgId, userId, accountId, true)
    const managedAccount = { id: accountId, encryptionState: "managed" }
    const skipped: string[] = []
    let resealed = 0
    for (const entity of ["messages", "drafts", "conversations"] as const) {
      const items = input.batch[entity] ?? []
      if (items.length === 0) continue
      const current = new Map(
        extractRows<Record<string, unknown> & { id: string }>(
          await tx.execute(drizzleSql`
            SELECT * FROM ${mail()}.${drizzleSql.raw(quoteIdent(entity))}
             WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid AND enc_version = 1
               AND id IN (${drizzleSql.join(
                 items.map((m) => drizzleSql`${m.id}::uuid`),
                 drizzleSql`, `,
               )})`),
        ).map((r) => [r.id, r]),
      )
      for (const item of items) {
        const stored = current.get(item.id)
        if (!stored || !sameContentKey(stored.content_key_wrapped, item.contentKeyWrapped)) {
          skipped.push(item.id)
          continue
        }
        // Only what the row really holds is written: the plaintext must be
        // proven against the stored ciphertext, never taken on the caller's word.
        const proven = await provenPlaintext(entity, stored, item)
        if (!proven) {
          skipped.push(item.id)
          continue
        }
        const values: Record<string, string | null> =
          entity === "messages"
            ? {
                subject: proven.subject ?? null,
                textBody: proven.textBody ?? null,
                htmlBody: proven.htmlBody ?? null,
                snippet: proven.snippet ?? null,
              }
            : entity === "drafts"
              ? {
                  subject: proven.subject ?? null,
                  body: proven.textBody ?? null,
                  htmlBody: proven.htmlBody ?? null,
                }
              : { subject: proven.subject ?? null, snippet: proven.snippet ?? null }
        let headers: Record<string, unknown> | null = null
        if (entity === "messages" && proven.rawHeaders) {
          try {
            headers = JSON.parse(proven.rawHeaders) as Record<string, unknown>
          } catch {
            skipped.push(item.id)
            continue
          }
        }
        const sealed = await sealMailFields({
          userId,
          orgId,
          entity,
          entityId: item.id,
          values,
          // The sealed extra headers go back under the new key. Nothing is
          // merged into the cleartext allowlisted headers, which stay as they are.
          headers: entity === "messages" ? (headers ?? null) : null,
          account: managedAccount,
          on: tx,
        })
        const columns: Record<string, unknown> = {
          ...clearedSealedColumns(entity),
          ...sealed.columns,
        }
        if (entity === "conversations") columns.snippetSourceMessageId = null
        await setUpdate(tx, entity, item.id, columns)
        if (entity === "messages") {
          // A conversation showing this message follows it to the new format.
          const conversations = extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
              SELECT id::text AS id FROM ${mail()}.conversations
               WHERE snippet_source_message_id = ${item.id}::uuid AND org_id = ${orgId}::uuid`),
          )
          for (const c of conversations) {
            await pointConversationAtMessage(tx, MAIL_SCHEMA(), orgId, c.id, item.id)
          }
        }
        resealed += 1
      }
    }
    return { resealed, skipped }
  })
}

/**
 * Re-seal one attachment the owner's browser opened, under the mailbox's data
 * key. Refused unless the file belongs to this mailbox, is still v1, still has
 * the content key the browser opened, and the bytes are proven: sealed again
 * under the claimed D5 subkey with the stored nonce prefix and chunk bindings,
 * they reproduce the stored object (`sealedStreamMatches`). A caller who cannot
 * open the mailbox cannot substitute an attachment.
 */
export async function applyTransparentFile(input: {
  orgId: string
  userId: string
  accountId: string
  fileId: string
  contentKeyWrapped: string
  /** The attachment's D5 subkey the browser opened it with (base64). */
  fieldKey: string
  bytes: Uint8Array
}): Promise<{ resealed: boolean }> {
  const { orgId, userId, accountId, fileId } = input
  return withPrivilegedDb(orgId, "mailbox-mode:make-transparent:file", async (tx) => {
    await requireConvertingToManaged(tx, orgId, userId, accountId, true)
    const file = extractRows<{
      id: string
      storage_key: string
      mime_type: string
      content_key_wrapped: unknown
      enc_version: number
      enc_key_id: number | null
      chunk_size: number | null
      chunk_count: number | null
      plaintext_length: number | null
      nonce_prefix: unknown
    }>(
      await tx.execute(drizzleSql`
        SELECT f.id::text AS id, f.storage_key, f.mime_type, f.content_key_wrapped,
               f.enc_version, f.enc_key_id, f.chunk_size, f.chunk_count, f.plaintext_length,
               f.nonce_prefix
          FROM ${kernel()}.files f
         WHERE f.id = ${fileId}::uuid AND ${accountFilesWhere(orgId, accountId)}
           AND f.enc_version = 1
         FOR UPDATE OF f`),
    )[0]
    if (!file || !sameContentKey(file.content_key_wrapped, input.contentKeyWrapped)) {
      return { resealed: false }
    }
    const noncePrefix = storedBytes(file.nonce_prefix)
    if (
      file.plaintext_length == null ||
      file.chunk_size == null ||
      file.chunk_count == null ||
      file.enc_key_id == null ||
      !noncePrefix ||
      Number(file.plaintext_length) !== input.bytes.byteLength
    ) {
      return { resealed: false }
    }
    const header = {
      version: Number(file.enc_version),
      keyId: Number(file.enc_key_id),
      noncePrefix,
      chunkSize: Number(file.chunk_size),
      chunkCount: Number(file.chunk_count),
      plaintextLength: Number(file.plaintext_length),
    }
    // Only what the object really holds is written: the bytes are proven
    // against the stored ciphertext, never taken on the caller's word.
    const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
    const stored = await getObjectBytes(file.storage_key, {
      maxBytes: header.plaintextLength + header.chunkCount * STREAM_TAG_BYTES,
    })
    const proven = await sealedStreamMatches({
      streamKey: new Uint8Array(Buffer.from(input.fieldKey, "base64")),
      fileId,
      header,
      stored: new Uint8Array(stored.bytes),
      plaintext: input.bytes as Uint8Array<ArrayBuffer>,
    })
    if (!proven) return { resealed: false }
    const dek = await loadMailboxServerKeyPrivileged(orgId, accountId, undefined, tx)
    try {
      const sealed = sealManagedAttachment({
        accountId,
        dek: dek.key,
        keyVersion: dek.keyVersion,
        fileId,
        bytes: input.bytes,
      })
      await writeResealedFile(
        tx,
        file,
        { ...sealed.columns, contentKeyEpk: null, noncePrefix: null },
        sealed.body,
        file.mime_type,
      )
    } finally {
      dek.key.fill(0)
    }
    return { resealed: true }
  })
}

/** What is still private-sealed (v1) in a mailbox being made transparent. */
export async function transparentProgress(input: {
  orgId: string
  userId: string
  accountId: string
}): Promise<{ remaining: number; counts: ConversionCounts; conversion: MailboxConversion | null }> {
  return withPrivilegedDb(input.orgId, "mailbox-mode:make-transparent:progress", async (tx) => {
    const account = await ownedAccount(tx, input.orgId, input.userId, input.accountId)
    const counts = await sealedCounts(tx, input.orgId, input.accountId, 1)
    return { remaining: conversionTotal(counts), counts, conversion: account.encryption_conversion }
  })
}

/**
 * Finish making a mailbox transparent: under the row lock, conversations that
 * point at a converted message follow it, and when nothing private-sealed is
 * left the mailbox becomes `managed`. Otherwise nothing changes and what is
 * left is reported, for the browser to carry on.
 */
export async function finishMakeMailboxTransparent(input: {
  orgId: string
  userId: string
  accountId: string
}): Promise<{ done: boolean; remaining: number; counts: ConversionCounts }> {
  const { orgId, userId, accountId } = input
  // The owner's language for the notice, read before the transaction: it needs
  // no row lock, and reading it inside would take a second privileged connection.
  const locale = await ownerLocale(orgId, userId)
  return withPrivilegedDb(orgId, "mailbox-mode:make-transparent:finish", async (tx) => {
    const account = await ownedAccount(tx, orgId, userId, accountId, true)
    if (account.encryption_state === "managed" && account.encryption_conversion === null) {
      return { done: true, remaining: 0, counts: await sealedCounts(tx, orgId, accountId, 1) }
    }
    await requireConvertingToManaged(tx, orgId, userId, accountId, false)
    const pointers = extractRows<{ id: string; source: string }>(
      await tx.execute(drizzleSql`
        SELECT c.id::text AS id, c.snippet_source_message_id::text AS source
          FROM ${mail()}.conversations c
          JOIN ${mail()}.messages m ON m.id = c.snippet_source_message_id
         WHERE c.account_id = ${accountId}::uuid AND c.org_id = ${orgId}::uuid
           AND c.enc_version = 1 AND m.enc_version = 2`),
    )
    for (const p of pointers) {
      await pointConversationAtMessage(tx, MAIL_SCHEMA(), orgId, p.id, p.source)
    }
    const counts = await sealedCounts(tx, orgId, accountId, 1)
    const remaining = conversionTotal(counts)
    if (remaining > 0) return { done: false, remaining, counts }
    const [flipped] = extractRows<{ email_address: string; connected_account_id: string | null }>(
      await tx.execute(drizzleSql`
        UPDATE ${mail()}.accounts SET encryption_state = 'managed', encryption_conversion = NULL
         WHERE id = ${accountId}::uuid
         RETURNING email_address, connected_account_id::text AS connected_account_id`),
    )
    // The owner hears about it in their feed, in the same transaction as the
    // flip, so the notice exists exactly when the mailbox became transparent.
    await tx.queueEvent(
      await madeTransparentNotice({
        orgId,
        userId,
        accountId,
        email: flipped?.email_address ?? "",
        connectedAccountId: flipped?.connected_account_id ?? null,
        locale,
      }),
    )
    return { done: true, remaining: 0, counts }
  })
}

/**
 * The owner's notice that a mailbox is now transparent: an `agent_notification`
 * naming the owner alone (the attention pipeline's kernel notice, which the
 * socket and the feed hold to the people it names), in the owner's language.
 */
async function ownerLocale(orgId: string, userId: string): Promise<ShippedLocale> {
  const { recipientLocale } = await import("~/modules/push/fanout-consumer")
  return recipientLocale(orgId, userId).catch(() => "en" as const)
}

async function madeTransparentNotice(input: {
  orgId: string
  userId: string
  accountId: string
  email: string
  connectedAccountId: string | null
  locale: ShippedLocale
}): Promise<AppEvent> {
  const { serverT } = await import("~/modules/i18n/server-i18n")
  const { locale } = input
  return {
    app: "kernel",
    entity: "agent_notification",
    action: "create",
    entityId: crypto.randomUUID(),
    data: {
      summary: serverT(locale, "kernel.mailboxMadeTransparentNotice", { email: input.email }),
      urgency: 50,
      targetUserIds: [input.userId],
      mailAccountId: input.accountId,
      ...(input.connectedAccountId
        ? { link: { tabType: "kernel:connected_account", entityId: input.connectedAccountId } }
        : {}),
    },
    actorId: input.userId,
    actorType: "system",
    orgId: input.orgId,
    timestamp: new Date().toISOString(),
  }
}
