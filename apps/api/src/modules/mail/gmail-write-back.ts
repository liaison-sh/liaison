// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host side of the Gmail write-back: after a user's change to a conversation
 * has COMMITTED, hand the mail app's `gmail-write-back` job the values the user
 * set. The job (apps/mail/handlers.ts, `gmailWriteBack`) pushes them to Gmail
 * for Gmail-backed mailboxes and does nothing for any other provider.
 *
 * Enqueueing never fails the user's request: the change is already stored in
 * Liaison. A job that cannot be enqueued is logged, and the mailbox keeps the
 * change locally exactly as before write-back existed.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"

const log = rootLogger.child({ module: "mail-gmail-write-back" })

/** The conversation values that have a Gmail counterpart. Assignment does not. */
export interface GmailWriteBackFields {
  status?: string
  isRead?: boolean
  isStarred?: boolean
}

export function gmailWriteBackFields(changes: {
  status?: string
  isRead?: boolean
  isStarred?: boolean
}): GmailWriteBackFields | null {
  const fields: GmailWriteBackFields = {}
  if (changes.status !== undefined) fields.status = changes.status
  if (changes.isRead !== undefined) fields.isRead = changes.isRead
  if (changes.isStarred !== undefined) fields.isStarred = changes.isStarred
  return Object.keys(fields).length > 0 ? fields : null
}

type EnqueueFn = (
  appName: string,
  jobName: string,
  payload: unknown,
  opts?: { jobId?: string; delay?: number },
) => Promise<unknown>

export async function enqueueGmailWriteBack(
  params: {
    orgId: string
    accountId: string
    conversationIds: string[]
    changes: { status?: string; isRead?: boolean; isStarred?: boolean }
  },
  enqueue?: EnqueueFn,
): Promise<boolean> {
  const fields = gmailWriteBackFields(params.changes)
  if (!fields || params.conversationIds.length === 0) return false
  try {
    const run = enqueue ?? (await import("~/infra/jobs/jobs")).enqueueAppJob
    await run("mail", "gmail-write-back", {
      orgId: params.orgId,
      accountId: params.accountId,
      conversationIds: params.conversationIds,
      fields,
    })
    return true
  } catch (err) {
    log.error(
      {
        err,
        orgId: params.orgId,
        accountId: params.accountId,
        conversationIds: params.conversationIds,
      },
      "Gmail write-back could not be enqueued; the change stays in Liaison only",
    )
    return false
  }
}
const LABEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function labelIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && LABEL_ID_RE.test(v))) {
    throw new Error(`mail_applyLabelDelta: ${field} must be an array of Gmail label ids`)
  }
  return value as string[]
}

/**
 * Apply a Gmail write-back's label operations to the stored labels of one
 * conversation and its messages, as a DELTA computed by the database in one
 * transaction: a label change the sync stored while the job was calling Gmail
 * is kept, never overwritten with labels read before the call. `remove` and
 * `add` are disjoint (the plan never adds and removes the same label).
 * Returns the conversation's labels after the change, or null when the
 * conversation is not in this mailbox.
 */
export async function applyConversationLabelDelta(
  deps: { tx: Pick<RlsClient, "execute" | "transaction">; schemaName: string; orgId: string },
  input: { accountId: unknown; conversationId: unknown; add: unknown; remove: unknown },
): Promise<string[] | null> {
  if (typeof input.accountId !== "string" || !UUID_RE.test(input.accountId)) {
    throw new Error("mail_applyLabelDelta: accountId is required")
  }
  if (typeof input.conversationId !== "string" || !UUID_RE.test(input.conversationId)) {
    throw new Error("mail_applyLabelDelta: conversationId is required")
  }
  const add = JSON.stringify(labelIds(input.add, "add"))
  const remove = JSON.stringify(labelIds(input.remove, "remove"))
  const schema = drizzleSql.raw(quoteIdent(deps.schemaName))
  const next = (column: SQL) => drizzleSql`(
    SELECT coalesce(jsonb_agg(s.l ORDER BY s.o), '[]'::jsonb) FROM (
      SELECT t.l, min(t.o) AS o
        FROM jsonb_array_elements_text(coalesce(${column}, '[]'::jsonb) || ${add}::jsonb)
             WITH ORDINALITY AS t(l, o)
       WHERE NOT (t.l IN (SELECT jsonb_array_elements_text(${remove}::jsonb)))
       GROUP BY t.l) s)`
  return deps.tx.transaction(async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${schema}.messages m SET labels = ${next(drizzleSql`m.labels`)}, updated_at = now()
       WHERE m.org_id = ${deps.orgId}::uuid AND m.account_id = ${input.accountId}::uuid
         AND m.conversation_id = ${input.conversationId}::uuid`)
    const [row] = extractRows<{ labels: string[] }>(
      await tx.execute(drizzleSql`
        UPDATE ${schema}.conversations c SET labels = ${next(drizzleSql`c.labels`)}, updated_at = now()
         WHERE c.id = ${input.conversationId}::uuid AND c.org_id = ${deps.orgId}::uuid
           AND c.account_id = ${input.accountId}::uuid
        RETURNING c.labels`),
    )
    return row ? row.labels : null
  })
}
