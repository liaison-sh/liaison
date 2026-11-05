// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one host-side opener of server-managed mail (`enc_version = 2`).
//
// Every server-side read of a managed mailbox's content comes through here: the
// web projection, the agent broker, the MCP gateway, search, attachments. It
// enforces two walls on top of RLS:
//   1. The reader is the mailbox OWNER (a person), or a host job acting for the
//      owner (`system:*`). An org admin, another member or an agent acting for
//      someone else is refused, whatever their scopes.
//   2. The account is `managed`. A private (`ready`) mailbox has no data key and
//      its v1 rows are never handed to this file (`openManaged` refuses any
//      version but 2).
// and writes one audit row per call (who, which mailbox, which rows, why), never
// content. The owner's own web reads are coalesced to one row per minute per
// mailbox (owner ruling D5).

import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { writeAuditLog } from "~/modules/audit/service"
import {
  isSystemMailActor,
  MAILBOX_SEALED_FIELDS,
  type MailboxSealEntity,
} from "~/modules/mailbox-crypto/mail-writer"
import { loadMailboxServerKey } from "~/modules/mailbox-crypto/managed-keys"
import {
  isManagedEncVersion,
  managedContextOf,
  openManaged,
  openManagedAttachment,
} from "~/modules/mailbox-crypto/managed-seal"
import type { SealContextKind } from "~/modules/mailbox-crypto/seal-service"

const log = rootLogger.child({ module: "mailbox-managed-open" })

export class ManagedMailAccessError extends Error {
  readonly code = "MAILBOX_MANAGED_ACCESS_DENIED"
  constructor(message: string) {
    super(`MAILBOX_MANAGED_ACCESS_DENIED: ${message}`)
    this.name = "ManagedMailAccessError"
  }
}

/** Why content was opened. Recorded in the audit row. */
export type ManagedOpenPurpose =
  | { kind: "web_view" }
  | { kind: "tool"; tool?: string; agentId?: string | null; routineId?: string | null }
  | { kind: "mcp"; tool?: string }
  | { kind: "search" }
  | { kind: "attachment" }
  | { kind: "reseal" }

export interface ManagedOpenActor {
  /** A person's id, or a `system:*` host actor. */
  userId: string
}

/** A row as stored: snake_case columns, bytea as Buffer (or base64 text). */
export type StoredMailRow = Record<string, unknown> & { id: string }

/** The plaintext of one row, keyed by the manifest's plaintext field name. */
export type OpenedMailFields = Record<string, string | null>

function toBytes(value: unknown): Uint8Array | null {
  if (value == null) return null
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") {
    // postgres.js returns bytea as Buffer; a JSON round trip (sandbox bridge)
    // carries base64, and a `\x` hex literal is what a raw text cast gives.
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex")
    return Buffer.from(value, "base64")
  }
  if (typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data)
  }
  return null
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** Read a column from a row that may be snake_case (SQL) or camelCase (bridge). */
function column(row: Record<string, unknown>, camel: string): unknown {
  const snake = snakeCase(camel)
  return snake in row ? row[snake] : row[camel]
}

interface AccountKeyInfo {
  ownerType: string
  ownerId: string | null
  encryptionState: string | null
  /** `to_private` | `to_managed` while the mailbox moves between modes. */
  encryptionConversion: string | null
}

async function readAccount(
  tx: { execute(q: unknown): Promise<unknown> },
  orgId: string,
  accountId: string,
): Promise<AccountKeyInfo | null> {
  const mail = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
  const row = extractRows<{
    owner_type: string
    owner_id: string | null
    encryption_state: string | null
    encryption_conversion: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT owner_type, owner_id::text AS owner_id, encryption_state, encryption_conversion
        FROM ${mail}.accounts WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
  )[0]
  return row
    ? {
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        encryptionState: row.encryption_state,
        encryptionConversion: row.encryption_conversion,
      }
    : null
}

/** A host job of the MAIL app itself (`system:mail:<job>`), never another app's. */
function isMailHostJob(actor: string): boolean {
  return actor.startsWith("system:mail:")
}

function assertMayOpen(
  account: AccountKeyInfo | null,
  accountId: string,
  actor: ManagedOpenActor,
  purpose: ManagedOpenPurpose,
) {
  if (account?.ownerType !== "user" || !account.ownerId) {
    throw new ManagedMailAccessError(`mail account ${accountId} is not a personal mailbox`)
  }
  // Only a server-managed mailbox is opened here, or one being made
  // transparent (its rows already converted are v2 while it is still `ready`),
  // and the owner's own re-seal while a mailbox moves to private.
  const transparent =
    account.encryptionState === "managed" ||
    (account.encryptionState === "ready" && account.encryptionConversion === "to_managed")
  if (!transparent && purpose.kind !== "reseal") {
    throw new ManagedMailAccessError(
      `mail account ${accountId} is "${account.encryptionState}", not server-managed`,
    )
  }
  if (actor.userId === account.ownerId) return
  // A host job may open content only to RE-SEAL it, and only the mail app's
  // own: another app's event handler runs as `system:<app>` on the privileged
  // pool and must never read anyone's mail through this path.
  if (isMailHostJob(actor.userId) && purpose.kind === "reseal") return
  throw new ManagedMailAccessError(
    `mail account ${accountId} belongs to another user; only its owner and the owner's agent read it`,
  )
}

// Owner web reads: one audit row per mailbox per minute (owner ruling D5).
const webAuditCoalesce = new Map<string, number>()
const WEB_AUDIT_WINDOW_MS = 60_000

function shouldWriteAudit(accountId: string, actor: string, purpose: ManagedOpenPurpose): boolean {
  if (purpose.kind !== "web_view") return true
  const key = `${accountId}:${actor}`
  const now = Date.now()
  const last = webAuditCoalesce.get(key) ?? 0
  if (now - last < WEB_AUDIT_WINDOW_MS) return false
  webAuditCoalesce.set(key, now)
  if (webAuditCoalesce.size > 10_000) webAuditCoalesce.clear()
  return true
}

async function audit(
  tx: Parameters<typeof writeAuditLog>[0],
  orgId: string,
  accountId: string,
  actor: ManagedOpenActor,
  purpose: ManagedOpenPurpose,
  entity: string,
  ids: string[],
): Promise<void> {
  if (!shouldWriteAudit(accountId, actor.userId, purpose)) return
  const agentId = purpose.kind === "tool" ? (purpose.agentId ?? null) : null
  await writeAuditLog(tx, {
    orgId,
    actorId: actor.userId,
    actorType: isSystemMailActor(actor.userId)
      ? "system"
      : purpose.kind === "tool"
        ? "agent"
        : purpose.kind === "mcp"
          ? "mcp"
          : "user",
    agentId,
    app: "mail",
    entityType: "accounts",
    entityId: accountId,
    action: "mail.content.decrypt",
    // Ids and the reason only. Never a subject, a body or a filename.
    metadata: {
      purpose: purpose.kind,
      ...(purpose.kind === "tool" || purpose.kind === "mcp" ? { tool: purpose.tool } : {}),
      ...(purpose.kind === "tool" && purpose.routineId ? { routineId: purpose.routineId } : {}),
      entity,
      ids: ids.slice(0, 200),
      count: ids.length,
      // Every opened id is accountable, past the 200 listed: the hash of all.
      idsSha256: createHash("sha256")
        .update([...ids].sort().join(","))
        .digest("hex"),
    },
  })
}

/**
 * Open the v2 rows of ONE managed mailbox. Rows that are not v2 are skipped
 * (absent from the result): this never touches a private row.
 *
 * Conversations carry their source message's ciphertext (see
 * `pointConversationAtMessage`), so they open under the MESSAGE's bindings via
 * `snippet_source_message_id`, exactly as the browser does for v1.
 */
export async function openManagedMailRows(input: {
  orgId: string
  accountId: string
  entity: MailboxSealEntity
  rows: StoredMailRow[]
  actor: ManagedOpenActor
  purpose: ManagedOpenPurpose
}): Promise<Map<string, OpenedMailFields>> {
  const out = new Map<string, OpenedMailFields>()
  const rows = input.rows.filter((r) => isManagedEncVersion(column(r, "encVersion")))
  if (rows.length === 0) return out
  await withPrivilegedDb(input.orgId, "mailbox-managed:open", async (tx) => {
    const account = await readAccount(tx, input.orgId, input.accountId)
    assertMayOpen(account, input.accountId, input.actor, input.purpose)
    const ownerId = account?.ownerId as string
    const keys = new Map<number, Buffer>()
    try {
      for (const row of rows) {
        const version = Number(column(row, "encKeyId") ?? 0)
        let dek = keys.get(version)
        if (!dek) {
          dek = (await loadMailboxServerKey(tx, input.orgId, input.accountId, version)).key
          keys.set(version, dek)
        }
        out.set(row.id, openRow(input.entity, row, input.accountId, dek, ownerId))
      }
      await audit(
        tx,
        input.orgId,
        input.accountId,
        input.actor,
        input.purpose,
        input.entity,
        rows.map((r) => r.id),
      )
    } finally {
      for (const key of keys.values()) key.fill(0)
    }
  })
  return out
}

function openRow(
  entity: MailboxSealEntity,
  row: StoredMailRow,
  accountId: string,
  dek: Buffer,
  ownerId: string,
): OpenedMailFields {
  const wrapped = toBytes(column(row, "contentKeyWrapped"))
  if (!wrapped) throw new Error(`managed ${entity} row ${row.id} has no content key`)
  const defs = MAILBOX_SEALED_FIELDS[entity]
  // A conversation's ciphertext is its source message's: open it under that
  // message's message.* bindings.
  const sourceMessageId =
    entity === "conversations" ? (column(row, "snippetSourceMessageId") as string | null) : null
  const fields: Array<{
    field: string
    kind: SealContextKind
    entityId: string
    ciphertext: Uint8Array | null
  }> = []
  for (const [field, def] of Object.entries(defs)) {
    const ciphertext = toBytes(column(row, def.column))
    if (sourceMessageId) {
      const kind: SealContextKind = field === "subject" ? "messageSubject" : "messageSnippet"
      fields.push({ field, kind, entityId: sourceMessageId, ciphertext })
    } else {
      fields.push({ field, kind: def.aad, entityId: `${row.id}${def.aadSuffix ?? ""}`, ciphertext })
    }
  }
  const opened = openManaged({
    accountId,
    dek,
    contentKeyWrapped: wrapped,
    fields: fields.map((f) => ({
      context: managedContextOf({ kind: f.kind, entityId: f.entityId }, ownerId),
      ciphertext: f.ciphertext,
    })),
  })
  const result: OpenedMailFields = {}
  fields.forEach((f, i) => {
    result[f.field] = opened[i] ?? null
  })
  return result
}

/**
 * Open the v2 rows of several mailboxes at once, grouping by account. Rows whose
 * account the actor may not open are left out and logged, never thrown, so one
 * foreign row cannot blank a whole list.
 */
export async function openManagedMailRowsByAccount(input: {
  orgId: string
  entity: MailboxSealEntity
  rows: Array<StoredMailRow & { account_id?: unknown; accountId?: unknown }>
  actor: ManagedOpenActor
  purpose: ManagedOpenPurpose
}): Promise<Map<string, OpenedMailFields>> {
  const byAccount = new Map<string, StoredMailRow[]>()
  for (const row of input.rows) {
    if (!isManagedEncVersion(column(row, "encVersion"))) continue
    const accountId = String(column(row, "accountId") ?? "")
    if (!accountId) continue
    const list = byAccount.get(accountId) ?? []
    list.push(row)
    byAccount.set(accountId, list)
  }
  const out = new Map<string, OpenedMailFields>()
  for (const [accountId, rows] of byAccount) {
    try {
      const opened = await openManagedMailRows({
        orgId: input.orgId,
        accountId,
        entity: input.entity,
        rows,
        actor: input.actor,
        purpose: input.purpose,
      })
      for (const [id, fields] of opened) out.set(id, fields)
    } catch (err) {
      log.error(
        { err, orgId: input.orgId, accountId, entity: input.entity, count: rows.length },
        "Managed mail rows could not be opened",
      )
    }
  }
  return out
}

/** Open a managed attachment body for its mailbox owner. */
export async function openManagedAttachmentForOwner(input: {
  orgId: string
  accountId: string
  fileId: string
  keyVersion: number
  contentKeyWrapped: Uint8Array
  body: Uint8Array
  actor: ManagedOpenActor
  purpose: ManagedOpenPurpose
}): Promise<Buffer> {
  return withPrivilegedDb(input.orgId, "mailbox-managed:open-attachment", async (tx) => {
    const account = await readAccount(tx, input.orgId, input.accountId)
    assertMayOpen(account, input.accountId, input.actor, input.purpose)
    const dek = await loadMailboxServerKey(tx, input.orgId, input.accountId, input.keyVersion)
    try {
      const bytes = openManagedAttachment({
        accountId: input.accountId,
        dek: dek.key,
        fileId: input.fileId,
        contentKeyWrapped: input.contentKeyWrapped,
        body: input.body,
      })
      await audit(tx, input.orgId, input.accountId, input.actor, input.purpose, "files", [
        input.fileId,
      ])
      return bytes
    } finally {
      dek.key.fill(0)
    }
  })
}

/**
 * Read a managed (`enc_version = 2`) mail attachment as plaintext for its
 * owner. The file row and its parent are read through the CALLER's
 * transaction, so a file the caller cannot see stays unseen; the opener then
 * applies the owner wall and writes the audit row.
 */
export async function openManagedFile(
  tx: { execute(q: unknown): Promise<unknown> },
  input: {
    orgId: string
    userId: string
    fileId: string
    purpose: ManagedOpenPurpose
    maxBytes?: number
  },
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  const KS = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
  const row = extractRows<{
    storage_key: string
    filename: string
    mime_type: string
    entity_type: string | null
    entity_id: string | null
    enc_version: number | null
    enc_key_id: number | null
    content_key_wrapped: unknown
  }>(
    await tx.execute(drizzleSql`
      SELECT storage_key, filename, mime_type, entity_type, entity_id::text AS entity_id,
             enc_version, enc_key_id, content_key_wrapped
        FROM ${KS}.files WHERE id = ${input.fileId}::uuid AND org_id = ${input.orgId}::uuid LIMIT 1`),
  )[0]
  if (!row || !isManagedEncVersion(row.enc_version)) {
    throw new ManagedMailAccessError(`file ${input.fileId} is not a managed mail attachment`)
  }
  const { resolveAttachmentMailAccount } = await import("~/modules/mailbox-crypto/attachment-seal")
  const account =
    row.entity_type && row.entity_id
      ? await resolveAttachmentMailAccount(
          tx,
          schemaRef("app_mail"),
          input.orgId,
          row.entity_type,
          row.entity_id,
        )
      : null
  if (!account) {
    throw new ManagedMailAccessError(`file ${input.fileId} has no mailbox the caller can see`)
  }
  const wrapped = toBytes(row.content_key_wrapped)
  if (!wrapped) throw new Error(`managed file ${input.fileId} has no content key`)
  // The owner wall BEFORE any byte is fetched from storage.
  await withPrivilegedDb(input.orgId, "mailbox-managed:file-owner", async (ptx) =>
    assertMayOpen(
      await readAccount(ptx, input.orgId, account.id),
      account.id,
      { userId: input.userId },
      input.purpose,
    ),
  )
  const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
  const stored = await getObjectBytes(row.storage_key, {
    maxBytes: (input.maxBytes ?? 35 * 1024 * 1024) + 64,
  })
  const bytes = await openManagedAttachmentForOwner({
    orgId: input.orgId,
    accountId: account.id,
    fileId: input.fileId,
    keyVersion: Number(row.enc_key_id ?? 0),
    contentKeyWrapped: wrapped,
    body: stored.bytes,
    actor: { userId: input.userId },
    purpose: input.purpose,
  })
  return { bytes, filename: row.filename, mimeType: row.mime_type }
}
