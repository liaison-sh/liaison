// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A deleted message takes its attachments with it.
 *
 * A message is soft deleted (the row stays, rendered "[message deleted]"), but
 * the files parented to it (`app = 'kernel'`, `entity_type = 'message'`) are
 * the sender's content just as much as the text is: leaving them meant the
 * thread still listed them and the download, inline and relay routes still
 * served them. Deleting a message therefore deletes its file ROWS in the same
 * transaction as the soft delete, and queues one `kernel.file.delete` event per
 * row. The objects go only once that transaction has committed: the
 * `files-delete-object` durable consumer (delete-object-job.ts) turns each
 * committed event into an object-deletion job. A delete that rolls back leaves
 * message, rows and objects exactly as they were.
 *
 * Copies made through `metadata.attachment_file_ids` are their own rows with
 * their own storage key (attachFileToParent copies the bytes), so deleting the
 * message's copy never touches the original.
 */
import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

// `files.entity_id` is text; the guarded cast keeps the join on the messages
// primary key (same form as the files SELECT policy, rls-builder.ts).
const UUID_SHAPE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
const UUID_RE = new RegExp(UUID_SHAPE)
const messageIdOf = (filesAlias: string) =>
  sql.raw(
    `(CASE WHEN ${filesAlias}.entity_id ~ '${UUID_SHAPE}' THEN ${filesAlias}.entity_id::uuid END)`,
  )

export interface PurgedAttachment {
  id: string
  messageId: string
  storageKey: string
  thumbnailKey: string | null
}

type Tx = Pick<RlsClient, "execute" | "queueEvent">
type RowSelector = { kind: "messages"; messageIds: string[] } | { kind: "deleted" }

/**
 * Delete the file rows the selector names inside `tx` and queue a
 * `kernel.file.delete` event per row, the same event `deleteFile` emits.
 * `deleted` selects every attachment whose message is already soft deleted;
 * `messages` the attachments of the given messages, which must be soft deleted
 * already (`deleteMessage` deletes them on the transaction that soft deletes
 * the message). The DELETE is `kernel.delete_deleted_message_attachments`
 * (migration 0178), a SECURITY DEFINER function pinned to the transaction's
 * org: the caller may not hold DELETE on every attachment of a message, and a
 * request transaction cannot elevate. It runs on `tx`, so the rows go only if
 * the message delete commits.
 */
async function deleteAttachmentRows(
  tx: Tx,
  orgId: string,
  selector: RowSelector,
  actorId: string | null,
): Promise<PurgedAttachment[]> {
  const ids =
    selector.kind === "messages"
      ? sql`${`{${selector.messageIds.filter((id) => UUID_RE.test(id)).join(",")}}`}::uuid[]`
      : sql`NULL::uuid[]`
  const rows = extractRows<{
    id: string
    entity_id: string
    storage_key: string
    thumbnail_key: string | null
  }>(
    await tx.execute(sql`
      SELECT id, entity_id, storage_key, thumbnail_key
        FROM ${K}.delete_deleted_message_attachments(${orgId}::uuid, ${ids})
    `),
  )
  for (const r of rows) {
    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: r.id,
      orgId,
      actorId,
      data: {
        id: r.id,
        app: "kernel",
        entityType: "message",
        entityId: r.entity_id,
        storageKey: r.storage_key,
        thumbnailKey: r.thumbnail_key,
      },
    })
  }
  return rows.map((r) => ({
    id: r.id,
    messageId: r.entity_id,
    storageKey: r.storage_key,
    thumbnailKey: r.thumbnail_key,
  }))
}

/**
 * Delete the attachments of the given messages inside the caller's
 * transaction (`deleteMessage` passes the one that soft deletes them).
 */
export async function deleteMessageAttachments(
  tx: Tx,
  params: { orgId: string; actorId: string | null; messageIds: string[] },
): Promise<PurgedAttachment[]> {
  if (params.messageIds.length === 0) return []
  return deleteAttachmentRows(
    tx,
    params.orgId,
    { kind: "messages", messageIds: params.messageIds },
    params.actorId,
  )
}

export interface PurgeDeletedReport {
  orgId: string
  files: number
  messages: number
}

export interface PurgeDeps {
  privileged?: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

/**
 * Idempotent cleanup for attachments of messages deleted before deletion took
 * them along. `dryRun` counts without changing anything. Objects follow the
 * committed events, as for any file deletion.
 */
export async function purgeDeletedMessageAttachments(
  params: { orgId: string; dryRun: boolean },
  deps: PurgeDeps = {},
): Promise<PurgeDeletedReport> {
  const { orgId, dryRun } = params
  const privileged =
    deps.privileged ??
    (<T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) =>
      withPrivilegedDb(orgId, reason, fn))
  if (dryRun) {
    const [row] = extractRows<{ files: number; messages: number }>(
      await privileged("files:purge-deleted-message-attachments:count", (tx) =>
        tx.execute(sql`
          SELECT count(*)::int AS files, count(DISTINCT f.entity_id)::int AS messages
            FROM ${K}.files f
           WHERE f.org_id = ${orgId} AND f.app = 'kernel' AND f.entity_type = 'message'
             AND EXISTS (SELECT 1 FROM ${K}.messages m
                          WHERE m.id = ${messageIdOf("f")} AND m.org_id = f.org_id
                            AND m.deleted_at IS NOT NULL)
        `),
      ),
    )
    return { orgId, files: row?.files ?? 0, messages: row?.messages ?? 0 }
  }
  const removed = await privileged("files:purge-deleted-message-attachments", (tx) =>
    deleteAttachmentRows(tx, orgId, { kind: "deleted" }, null),
  )
  return {
    orgId,
    files: removed.length,
    messages: new Set(removed.map((r) => r.messageId)).size,
  }
}
