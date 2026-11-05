// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 7.4: server-side derivatives of an encrypted attachment must not exist.
//
// A thumbnail is a plaintext rendering of the file. An LLM-written description
// of an attachment IS content (spec section 7 step 7c). Both are produced by
// jobs that run on the server, which by design cannot read a sealed attachment
// at all, so the jobs SKIP such files, explicitly and with a logged reason: a
// thrown error would be retried forever and would say nothing useful.
//
// Skipping is only half of it. Everything the two jobs produced BEFORE the
// mailbox was sealed is still sitting in `kernel.files` and in the bucket, and a
// thumbnail of a contract survives the purge of the contract. So this file also
// carries the purge, which Phase 12 calls once the user's cutover is verified.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { deleteObject as defaultDeleteObject } from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"

const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

/** Anything that can run raw SQL under a privileged or system connection. */
interface SqlExecutor {
  execute(query: unknown): Promise<unknown>
}

export interface EncryptedAttachmentCheckDeps {
  privileged?: <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>
}

/**
 * Is this file's stored object ciphertext?
 *
 * Keyed on `enc_version`, the column the sealing path writes, rather than on the
 * mailbox's state: a file sealed under an earlier enrollment stays sealed even
 * if the mailbox is later blocked, and the bytes in the bucket are the only
 * thing that matters to a job that is about to read them.
 */
export async function isEncryptedAttachment(
  orgId: string,
  fileId: string,
  deps: EncryptedAttachmentCheckDeps = {},
): Promise<boolean> {
  const run =
    deps.privileged ??
    (async <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) =>
      withSystemDb(reason, (tx) => fn(tx as unknown as SqlExecutor)))
  const rows = await run("files:encrypted-check", async (tx) =>
    extractRows<{ enc_version: number | string | null }>(
      await tx.execute(
        drizzleSql`SELECT enc_version FROM ${K}.files
                    WHERE id = ${fileId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
      ),
    ),
  )
  return Number(rows[0]?.enc_version ?? 0) > 0
}

/** One line, at info level, naming the job and the file. Never an exception. */
export function logDerivativeSkip(job: string, fileId: string, orgId: string): void {
  log.info(
    { job, fileId, orgId, reason: "encrypted_mail_attachment" },
    "skipping derivative for an encrypted mail attachment: the server cannot read it",
  )
}

/**
 * How many of this user's personal-mail attachment OBJECTS are still stored as
 * they arrived, in the clear.
 *
 * There is no backfill phase that seals historical attachment bytes: the
 * backfill covers messages, conversations and drafts only, and sealing an
 * existing object means reading it out of the bucket, re-encrypting it through
 * `sealAttachmentBytes` and replacing it, which is its own piece of work.
 *
 * Until that exists, this count is what stops the purge from declaring a
 * cutover it has not achieved. `purgeMailAttachmentDerivatives` clears
 * thumbnails and analysis columns for every file in scope, sealed or not, so
 * after a purge the message bodies are gone while every attachment received
 * before enrolment is still readable by the operator. That is a partial
 * protection, and the ledger has to say so rather than stamp
 * `plaintext_purged_at` as though the mailbox were closed.
 *
 * Same scope as the derivative purge, deliberately: the two must not disagree
 * about which files belong to this mailbox.
 */
export async function countUnsealedMailAttachments(
  userId: string,
  deps: Pick<PurgeDerivativesDeps, "systemDb"> = {},
): Promise<number> {
  const systemDb =
    deps.systemDb ??
    (async <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) =>
      withSystemDb(reason, (tx) => fn(tx as unknown as SqlExecutor)))
  const rows = await systemDb("mailbox:count-unsealed-attachments", async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n
          FROM ${K}.files f
          JOIN ${MAIL}.accounts a
            ON a.owner_type = 'user' AND a.owner_id = ${userId}::uuid AND a.org_id = f.org_id
         WHERE f.app = 'mail'
           AND coalesce(f.enc_version, 0) = 0
           AND (
             (f.entity_type IN ('message', 'messages') AND EXISTS (
                SELECT 1 FROM ${MAIL}.messages m
                 WHERE m.account_id = a.id AND m.id::text = f.entity_id))
             OR (f.entity_type IN ('conversation', 'conversations') AND EXISTS (
                SELECT 1 FROM ${MAIL}.conversations c
                 WHERE c.account_id = a.id AND c.id::text = f.entity_id))
             OR (f.entity_type IN ('draft', 'drafts') AND EXISTS (
                SELECT 1 FROM ${MAIL}.drafts d
                 WHERE d.account_id = a.id AND d.id::text = f.entity_id))
             OR (f.entity_type = 'outbound_staging' AND a.id::text = f.entity_id)
           )`),
    ),
  )
  return rows[0]?.n ?? 0
}

export interface PurgeDerivativesDeps {
  deleteObject?: typeof defaultDeleteObject
  systemDb?: <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>
}

export interface PurgeDerivativesResult {
  /** Rows whose derivative columns were cleared. */
  filesCleared: number
  /** Thumbnail objects actually deleted from the bucket. */
  thumbnailsDeleted: number
  purgedAt: Date
}

/**
 * Delete every server-side derivative of this user's personal-mail attachments
 * and record that it happened.
 *
 * Scope note: this covers EVERY file parented to the user's personal mailbox,
 * not only the ones already sealed. A thumbnail generated before enrollment is a
 * rendering of the same message the purge is about to blank, so leaving it
 * behind would defeat the purge for exactly the historical mail the migration
 * exists to protect.
 *
 * Idempotent: a second run finds nothing to clear and moves the timestamp
 * forward, which is what Phase 12 needs from it.
 */
export async function purgeMailAttachmentDerivatives(
  userId: string,
  deps: PurgeDerivativesDeps = {},
): Promise<PurgeDerivativesResult> {
  const deleteObject = deps.deleteObject ?? defaultDeleteObject
  const systemDb =
    deps.systemDb ??
    (async <T>(reason: string, fn: (tx: SqlExecutor) => Promise<T>) =>
      withSystemDb(reason, (tx) => fn(tx as unknown as SqlExecutor)))

  const rows = await systemDb("mailbox:purge-derivatives-scan", async (tx) =>
    extractRows<{ id: string; org_id: string; thumbnail_key: string | null }>(
      await tx.execute(drizzleSql`
        SELECT f.id::text AS id, f.org_id::text AS org_id, f.thumbnail_key
          FROM ${K}.files f
          JOIN ${MAIL}.accounts a
            ON a.owner_type = 'user' AND a.owner_id = ${userId}::uuid AND a.org_id = f.org_id
         WHERE f.app = 'mail'
           AND (
             (f.entity_type IN ('message', 'messages') AND EXISTS (
                SELECT 1 FROM ${MAIL}.messages m
                 WHERE m.account_id = a.id AND m.id::text = f.entity_id))
             OR (f.entity_type IN ('conversation', 'conversations') AND EXISTS (
                SELECT 1 FROM ${MAIL}.conversations c
                 WHERE c.account_id = a.id AND c.id::text = f.entity_id))
             OR (f.entity_type IN ('draft', 'drafts') AND EXISTS (
                SELECT 1 FROM ${MAIL}.drafts d
                 WHERE d.account_id = a.id AND d.id::text = f.entity_id))
             OR (f.entity_type = 'outbound_staging' AND a.id::text = f.entity_id)
           )
           AND (
             f.thumbnail_key IS NOT NULL OR f.analysis_status IS NOT NULL
             OR f.analysis_summary IS NOT NULL OR f.analysis_model IS NOT NULL
             OR f.analysis_at IS NOT NULL OR f.analysis_error IS NOT NULL
             OR f.analysis_context_hash IS NOT NULL
           )`),
    ),
  )

  let thumbnailsDeleted = 0
  for (const row of rows) {
    if (!row.thumbnail_key) continue
    try {
      await deleteObject(row.thumbnail_key)
      thumbnailsDeleted++
    } catch (err) {
      // A missing object is already the desired end state; anything else is
      // logged and the row is still cleared, because leaving the column pointing
      // at a thumbnail we failed to delete helps nobody.
      log.warn({ err, fileId: row.id }, "thumbnail delete failed during derivative purge")
    }
  }

  const purgedAt = new Date()
  if (rows.length > 0) {
    // One bound parameter per id rather than an array literal: the driver binds
    // a JS array as a single text value, which Postgres then refuses to read as
    // `uuid[]`.
    const ids = drizzleSql.join(
      rows.map((r) => drizzleSql`${r.id}::uuid`),
      drizzleSql.raw(", "),
    )
    await systemDb("mailbox:purge-derivatives-clear", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${K}.files
           SET thumbnail_key = NULL, analysis_status = NULL, analysis_summary = NULL,
               analysis_model = NULL, analysis_at = NULL, analysis_error = NULL,
               analysis_context_hash = NULL
         WHERE id IN (${ids})`),
    )
  }
  await systemDb("mailbox:purge-derivatives-mark", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${K}.mailbox_migration_state (user_id, org_id, derivatives_purged_at)
      SELECT u.id, u.org_id, ${purgedAt.toISOString()}::timestamptz
        FROM ${K}.users u WHERE u.id = ${userId}::uuid
      ON CONFLICT (user_id) DO UPDATE SET derivatives_purged_at = EXCLUDED.derivatives_purged_at`),
  )

  log.info(
    { userId, filesCleared: rows.length, thumbnailsDeleted },
    "purged mail attachment derivatives",
  )
  return { filesCleared: rows.length, thumbnailsDeleted, purgedAt }
}
