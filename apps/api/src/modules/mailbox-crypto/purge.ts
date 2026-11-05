// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 12.4: spec section 7 steps 7a to 7d and step 8, per user.
//
// THIS IS THE DESTRUCTIVE ONE, AND IT REFUSES WITHOUT PROOF. It runs only
// against a valid client acknowledgement covering the FULL message id set,
// re-verified here under the stored Ed25519 public key AND re-derived over the
// exact rows it is about to destroy. Sampling would be worthless: the claim
// being checked is total coverage.
//
// The server never computes or stores a hash of plaintext, at any point in this
// path. That construction was deleted deliberately (amendment A6): a keyed hash
// of a low-entropy message is a plaintext-confirmation oracle. If a future
// change here starts wanting one, that is a design question, not an
// implementation detail.
//
// Attachment derivatives are purged too, via `purgeMailAttachmentDerivatives`.
// A thumbnail of a sealed PDF, or an LLM-written description of it, defeats the
// whole feature just as completely as the body column would.
//
// Every step is `WHERE ... IS NOT NULL` shaped and batched with the same cursor
// discipline as the backfill, so a second run is a no-op and a large mailbox
// never holds one long transaction.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { effectiveIndexName } from "~/infra/search/client"
import { rootLogger } from "~/lib/logger"
import {
  assertStoredAckCoversCurrentRows,
  MailboxAckError,
} from "~/modules/mailbox-crypto/ack-verify"
import {
  countUnsealedMailAttachments,
  purgeMailAttachmentDerivatives,
} from "~/modules/mailbox-crypto/attachment-derivatives"
import {
  type BackupClearance,
  backupConfigFromEnv,
  computeBackupClearance,
  type RepoRetentionPolicy,
} from "~/modules/mailbox-crypto/backup-clearance"
import { MAIL_HEADER_ALLOWLIST } from "~/modules/mailbox-crypto/header-allowlist"
import { documentId } from "~/modules/search/document-id"
import { deleteSearchDocumentsNow } from "~/modules/search/index-writer"

const log = rootLogger.child({ module: "mailbox-purge" })

const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

export const PURGE_BATCH_SIZE = 200

export { MailboxAckError }

type Executor = Pick<PrivilegedDb, "execute">

export interface PurgeDeps {
  privileged?: <T>(orgId: string, reason: string, fn: (tx: Executor) => Promise<T>) => Promise<T>
  /** Injected in tests. Real runs go through the shared derivative purge. */
  purgeDerivatives?: typeof purgeMailAttachmentDerivatives
  /** Injected in tests. Real runs count through the shared scope query. */
  countUnsealedAttachments?: typeof countUnsealedMailAttachments
  /** Injected in tests: `(indexName, documentIds) => void`. */
  deleteSearchDocuments?: (indexName: string, ids: string[]) => Promise<void>
  /**
   * A parsed `pgbackrest info --output=json` document. When supplied, backup
   * clearance is VERIFIED by enumeration; when absent it is only projected from
   * the retention policies, and `backupClearance.clear` is reported false with
   * no offending artifact named, because absence of evidence is not clearance.
   */
  pgbackrestInfo?: unknown
  repoPolicies?: readonly RepoRetentionPolicy[]
  stanza?: string
  batchSize?: number
}

/**
 * Rows this mailbox still holds in the clear. Every field is expected to be
 * zero after a successful purge, and a non-zero one is the only trustworthy
 * signal that something was left behind.
 */
export interface RemainingPlaintext {
  messages: number
  conversations: number
  drafts: number
  /** Messages still carrying a header key outside the section 5.2 allowlist. */
  messagesWithNonAllowlistedHeaders: number
}

export interface PurgeResult {
  userId: string
  orgId: string
  messagesPurged: number
  conversationsPurged: number
  draftsPurged: number
  headersReduced: number
  derivativesCleared: number
  searchDocumentsDeleted: number
  plaintextPurgedAt: Date
  /**
   * When the destructive purge RAN, recorded unconditionally.
   *
   * `plaintextPurgedAt` above is the instant this run used, and the ledger
   * column of the same name is stamped only on a COMPLETE cutover, so on a
   * mailbox with historical unsealed attachments the ledger reads NULL after a
   * purge that has already NULLed every body. This is the column that answers
   * "was anything destroyed here", which is the question no operator may get a
   * false answer to.
   */
  plaintextPurgeRanAt: Date
  /**
   * What is still readable AFTER this run. The honest witness: a purge is
   * proved by the absence of plaintext, not by a completion flag that a
   * legitimate refusal leaves unset.
   */
  remainingPlaintext: RemainingPlaintext
  backupsClearAfter: Date
  backupClearance: BackupClearance | null
  /** True when the run found nothing left to do. */
  alreadyPurged: boolean
  /**
   * Personal-mail attachment OBJECTS still stored in the clear. There is no
   * backfill phase that seals historical attachment bytes, so this is residue
   * the purge cannot remove and must not hide.
   */
  unsealedAttachments: number
  /**
   * False while `unsealedAttachments` is non-zero. The ledger's
   * `plaintext_purged_at` and `backups_clear_after` are left unset in that case:
   * a mailbox whose historical attachments are still readable has not completed
   * its cutover, whatever the message bodies say.
   */
  cutoverComplete: boolean
}

function runPrivileged(deps: PurgeDeps) {
  return (
    deps.privileged ??
    (<T>(orgId: string, reason: string, fn: (tx: Executor) => Promise<T>) =>
      withPrivilegedDb(orgId, reason, (tx) => fn(tx as unknown as Executor), { pool: "jobs" }))
  )
}

async function personalAccountIds(tx: Executor, userId: string, orgId: string): Promise<string[]> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${MAIL}.accounts
       WHERE org_id = ${orgId}::uuid AND owner_type = 'user' AND owner_id = ${userId}::uuid`),
  ).map((r) => r.id)
}

/**
 * Step 6, restated as a refusal.
 *
 * Anything unsealed left in the mailbox aborts before step 7. The client's
 * byte-for-byte comparison would already have failed on such a row, so reaching
 * here with one means the acknowledgement and the corpus disagree, and the
 * correct response to that disagreement is to destroy nothing.
 *
 * It covers EVERY table the purge writes to, not just messages, because the
 * acknowledgement does not. The client's walk and the stored ack are derived
 * from message ids only (`collectPersonalMessageIds`), so a backfill that
 * stopped after its messages phase, whether from a restart or from
 * BACKFILL_MAX_CONSECUTIVE_FAILURES in the conversations phase, produces a
 * corpus where every message is sealed, the ack verifies, and the purge would
 * then NULL conversation subjects and draft bodies that have no ciphertext
 * behind them. A gate that proves something about one table and authorises
 * destruction in three is not a gate.
 *
 * Conversations and drafts are counted only when they actually CARRY content in
 * the guarded columns: an empty row legitimately sits at `enc_version = 0` and
 * has nothing to lose.
 *
 * Exported for the gate's own test. It is not part of the module's public API.
 */
export async function assertFullySealed(tx: Executor, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return
  const ids = drizzleSql.join(
    accountIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )
  const unsealed = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${MAIL}.messages
       WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) = 0`),
  )[0]?.n
  if ((unsealed ?? 0) > 0) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `${unsealed} message(s) are still unsealed: aborting before the purge rather than destroying plaintext with no ciphertext behind it`,
    )
  }

  const unsealedConversations = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${MAIL}.conversations
       WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) = 0
         AND (nullif(subject, '') IS NOT NULL OR nullif(snippet, '') IS NOT NULL)`),
  )[0]?.n
  if ((unsealedConversations ?? 0) > 0) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `${unsealedConversations} conversation(s) still carry unsealed plaintext: aborting before the purge rather than destroying a subject with no ciphertext behind it`,
    )
  }

  const unsealedDrafts = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${MAIL}.drafts
       WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) = 0
         AND (nullif(subject, '') IS NOT NULL OR nullif(text_body, '') IS NOT NULL
              OR nullif(html_body, '') IS NOT NULL)`),
  )[0]?.n
  if ((unsealedDrafts ?? 0) > 0) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `${unsealedDrafts} draft(s) still carry unsealed plaintext: aborting before the purge rather than destroying a body with no ciphertext behind it`,
    )
  }

  // A sealed row whose ciphertext does not cover the column the purge is about
  // to NULL. `enc_version = 1` alone does not prove coverage: the backfill seals
  // per field and writes NULL for a field it had nothing for, so a stamped row
  // can still have a naked plaintext column.
  const uncovered = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT (
        (SELECT count(*) FROM ${MAIL}.messages
          WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) > 0
            AND ((nullif(subject, '') IS NOT NULL AND subject_ciphertext IS NULL)
              OR (nullif(text_body, '') IS NOT NULL AND text_body_ciphertext IS NULL)
              OR (nullif(html_body, '') IS NOT NULL AND html_body_ciphertext IS NULL)
              OR (nullif(snippet, '') IS NOT NULL AND snippet_ciphertext IS NULL)))
      + (SELECT count(*) FROM ${MAIL}.conversations
          WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) > 0
            AND ((nullif(subject, '') IS NOT NULL AND subject_ciphertext IS NULL)
              OR (nullif(snippet, '') IS NOT NULL AND snippet_ciphertext IS NULL)))
      + (SELECT count(*) FROM ${MAIL}.drafts
          WHERE account_id IN (${ids}) AND coalesce(enc_version, 0) > 0
            AND ((nullif(subject, '') IS NOT NULL AND subject_ciphertext IS NULL)
              OR (nullif(text_body, '') IS NOT NULL AND body_ciphertext IS NULL)
              OR (nullif(html_body, '') IS NOT NULL AND html_body_ciphertext IS NULL)))
      )::int AS n`),
  )[0]?.n
  if ((uncovered ?? 0) > 0) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `${uncovered} row(s) carry plaintext in a column with no matching ciphertext: aborting before the purge rather than destroying content the backfill never sealed`,
    )
  }

  // The same rule, one column further along. Step 7b reduces `raw_headers` to
  // the section 5.2 allowlist, and that reduction is IRREVERSIBLE: no client
  // can open `raw_headers_ciphertext` today, so a dropped header is gone for
  // everyone including the owner. Losing it to a sealed copy nobody reads YET
  // is the accepted cost; losing it where the backfill sealed nothing is the
  // uncovered-column defect again, and the header reduction ran unconditionally
  // because this gate did not look at the column.
  //
  // A message whose headers are ALL allowlisted seals no header ciphertext by
  // design, and is not matched here.
  const nakedHeaders = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${MAIL}.messages
       WHERE account_id IN (${ids}) AND raw_headers_ciphertext IS NULL
         AND ${headersOutsideAllowlist("raw_headers")}`),
  )[0]?.n
  if ((nakedHeaders ?? 0) > 0) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `${nakedHeaders} message(s) carry non-allowlisted header keys with no header ciphertext behind them: aborting before the purge rather than reducing headers the backfill never sealed`,
    )
  }
}

/**
 * The backfill has to have declared itself finished, not merely to have sealed
 * enough rows to satisfy the row counts above.
 *
 * `runMailboxBackfillForUser` returns `completed: false` and only logs when an
 * account trips BACKFILL_MAX_CONSECUTIVE_FAILURES, so a corpus can look
 * consistent at this instant and still have phases that never ran. The ledger
 * is the one place that records the difference.
 */
export async function assertBackfillCompleted(tx: Executor, userId: string): Promise<void> {
  const row = extractRows<{ completed: string | null }>(
    await tx.execute(drizzleSql`
      SELECT backfill_completed_at::text AS completed FROM ${K}.mailbox_migration_state
       WHERE user_id = ${userId}::uuid`),
  )[0]
  if (!row || row.completed === null) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      "the backfill has not recorded completion for this user: aborting before the purge rather than destroying plaintext a phase may never have sealed",
    )
  }
}

const HEADER_ALLOWLIST_SQL = drizzleSql.join(
  MAIL_HEADER_ALLOWLIST.map((h) => drizzleSql`${h}`),
  drizzleSql.raw(", "),
)

/**
 * `raw_headers` as an OBJECT, for key enumeration.
 *
 * `jsonb_object_keys` raises on a scalar, a string or an array, and every query
 * below enumerates keys. Real ingest always writes an object, so this guard is
 * robustness, but the place it raised was step 7b, in the middle of the
 * destructive run.
 */
function headersAsObject(column: string) {
  const col = drizzleSql.raw(column)
  return drizzleSql`(CASE WHEN jsonb_typeof(${col}) = 'object' THEN ${col} ELSE '{}'::jsonb END)`
}

/**
 * True when this row's `raw_headers` carries anything the section 5.2 allowlist
 * does not cover.
 *
 * A value that is NOT an object is not an allowlisted header map, so it counts:
 * a guard that merely skipped it would leave the purge reporting a clean
 * mailbox with the value still readable. SQL NULL and JSON `null` carry
 * nothing and do not count.
 */
function headersOutsideAllowlist(column: string) {
  const col = drizzleSql.raw(column)
  return drizzleSql`(
    coalesce(jsonb_typeof(${col}), 'null') NOT IN ('object', 'null')
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(${headersAsObject(column)}) k
                WHERE k NOT IN (${HEADER_ALLOWLIST_SQL})))`
}

function accountListSql(accountIds: string[]) {
  return drizzleSql.join(
    accountIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )
}

/**
 * Step 7b, one batch: reduce `raw_headers` to the section 5.2 allowlist.
 *
 * Exported so the destructive statement itself is testable. It is the one place
 * in the purge that REWRITES a column rather than NULLing it, and it is
 * irreversible: no client can open `raw_headers_ciphertext` today, so a dropped
 * header is gone for everyone, the owner included.
 *
 * One shared constant, spliced as bound parameters: the trigger carries the
 * same list as literal SQL and `header-allowlist.test.ts` asserts they agree.
 *
 * Returns how many rows this batch rewrote. Zero ends the caller's loop.
 */
export async function reduceRawHeadersBatch(
  tx: Executor,
  accountIds: string[],
  batchSize: number,
): Promise<number> {
  if (accountIds.length === 0) return 0
  const ids = accountListSql(accountIds)
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${MAIL}.messages m
         SET raw_headers = coalesce((
               SELECT jsonb_object_agg(k, m.raw_headers -> k)
                 FROM jsonb_object_keys(${headersAsObject("m.raw_headers")}) k
                WHERE k IN (${HEADER_ALLOWLIST_SQL})), '{}'::jsonb)
       WHERE m.id IN (
         SELECT id FROM ${MAIL}.messages
          WHERE account_id IN (${ids})
            AND ${headersOutsideAllowlist("raw_headers")}
          ORDER BY created_at ASC, id ASC LIMIT ${batchSize})
      RETURNING m.id::text AS id`),
  ).length
}

/**
 * Count what is STILL readable. Exported because the dry run reports the same
 * numbers before the purge: the operator's before and after are then the same
 * measurement rather than two different ones that have to be reconciled.
 */
export async function countRemainingPlaintext(
  tx: Executor,
  accountIds: string[],
): Promise<RemainingPlaintext> {
  if (accountIds.length === 0) {
    return {
      messages: 0,
      conversations: 0,
      drafts: 0,
      messagesWithNonAllowlistedHeaders: 0,
    }
  }
  const ids = drizzleSql.join(
    accountIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )
  const row = extractRows<{
    messages: number
    conversations: number
    drafts: number
    headers: number
  }>(
    await tx.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM ${MAIL}.messages
          WHERE account_id IN (${ids})
            AND (nullif(subject, '') IS NOT NULL OR nullif(text_body, '') IS NOT NULL
              OR nullif(html_body, '') IS NOT NULL OR nullif(snippet, '') IS NOT NULL)) AS messages,
        (SELECT count(*)::int FROM ${MAIL}.conversations
          WHERE account_id IN (${ids})
            AND (nullif(subject, '') IS NOT NULL OR nullif(snippet, '') IS NOT NULL))
          AS conversations,
        (SELECT count(*)::int FROM ${MAIL}.drafts
          WHERE account_id IN (${ids})
            AND (nullif(subject, '') IS NOT NULL OR nullif(text_body, '') IS NOT NULL
              OR nullif(html_body, '') IS NOT NULL)) AS drafts,
        (SELECT count(*)::int FROM ${MAIL}.messages
          WHERE account_id IN (${ids})
            AND ${headersOutsideAllowlist("raw_headers")}) AS headers`),
  )[0]
  return {
    messages: row?.messages ?? 0,
    conversations: row?.conversations ?? 0,
    drafts: row?.drafts ?? 0,
    messagesWithNonAllowlistedHeaders: row?.headers ?? 0,
  }
}

export async function purgeMailboxPlaintext(
  userId: string,
  orgId: string,
  deps: PurgeDeps = {},
): Promise<PurgeResult> {
  const run = runPrivileged(deps)
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE

  // ── The gate. Nothing below runs unless this passes. ──────────────────────
  const accountIds = await run(orgId, "mailbox-purge:gate", async (tx) => {
    const ids = await personalAccountIds(tx, userId, orgId)
    await assertStoredAckCoversCurrentRows(tx, userId, orgId)
    await assertBackfillCompleted(tx, userId)
    await assertFullySealed(tx, ids)
    return ids
  })

  const purgedAt = new Date()
  let messagesPurged = 0
  let conversationsPurged = 0
  let draftsPurged = 0
  let headersReduced = 0

  const accountList = drizzleSql.join(
    accountIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )

  // ── 7a: NULL the plaintext content columns, batched. ──────────────────────
  if (accountIds.length > 0) {
    // `messages.plaintext_purged_at` is a per-row breadcrumb for the rows this
    // statement actually rewrote, NEVER the mailbox-level fact. A message that
    // legitimately carried none of the four content values is not matched by the
    // predicate below and ends the purge with the column still NULL, so reading
    // it per row would report a false gap. The mailbox-level fact is
    // `kernel.mailbox_migration_state.plaintext_purged_at`, stamped once below.
    for (;;) {
      const done = await run(
        orgId,
        "mailbox-purge:messages",
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
            UPDATE ${MAIL}.messages
               SET subject = CASE WHEN subject_ciphertext IS NOT NULL THEN NULL ELSE subject END,
                   text_body = CASE WHEN text_body_ciphertext IS NOT NULL THEN NULL ELSE text_body END,
                   html_body = CASE WHEN html_body_ciphertext IS NOT NULL THEN NULL ELSE html_body END,
                   snippet = CASE WHEN snippet_ciphertext IS NOT NULL THEN NULL ELSE snippet END,
                   plaintext_purged_at = ${purgedAt.toISOString()}::timestamptz
             WHERE id IN (
               SELECT id FROM ${MAIL}.messages
                WHERE account_id IN (${accountList})
                  AND coalesce(enc_version, 0) > 0
                  AND ((subject IS NOT NULL AND subject_ciphertext IS NOT NULL)
                    OR (text_body IS NOT NULL AND text_body_ciphertext IS NOT NULL)
                    OR (html_body IS NOT NULL AND html_body_ciphertext IS NOT NULL)
                    OR (snippet IS NOT NULL AND snippet_ciphertext IS NOT NULL))
                ORDER BY created_at ASC, id ASC LIMIT ${batchSize})
            RETURNING id::text AS id`),
          ).length,
      )
      messagesPurged += done
      if (done === 0) break
    }

    for (;;) {
      const done = await run(
        orgId,
        "mailbox-purge:conversations",
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
            UPDATE ${MAIL}.conversations
               SET subject = CASE WHEN subject_ciphertext IS NOT NULL THEN NULL ELSE subject END,
                   snippet = CASE WHEN snippet_ciphertext IS NOT NULL THEN NULL ELSE snippet END
             WHERE id IN (
               SELECT id FROM ${MAIL}.conversations
                WHERE account_id IN (${accountList})
                  AND coalesce(enc_version, 0) > 0
                  AND ((subject IS NOT NULL AND subject_ciphertext IS NOT NULL)
                    OR (snippet IS NOT NULL AND snippet_ciphertext IS NOT NULL))
                ORDER BY created_at ASC, id ASC LIMIT ${batchSize})
            RETURNING id::text AS id`),
          ).length,
      )
      conversationsPurged += done
      if (done === 0) break
    }

    // Drafts are user-typed plaintext, and section 7 step 7a names them
    // explicitly. Migration 0035 is what makes the three columns nullable.
    for (;;) {
      const done = await run(
        orgId,
        "mailbox-purge:drafts",
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
            UPDATE ${MAIL}.drafts
               SET subject = CASE WHEN subject_ciphertext IS NOT NULL THEN NULL ELSE subject END,
                   text_body = CASE WHEN body_ciphertext IS NOT NULL THEN NULL ELSE text_body END,
                   html_body = CASE WHEN html_body_ciphertext IS NOT NULL THEN NULL ELSE html_body END
             WHERE id IN (
               SELECT id FROM ${MAIL}.drafts
                WHERE account_id IN (${accountList})
                  AND coalesce(enc_version, 0) > 0
                  AND ((nullif(subject, '') IS NOT NULL AND subject_ciphertext IS NOT NULL)
                    OR (nullif(text_body, '') IS NOT NULL AND body_ciphertext IS NOT NULL)
                    OR (nullif(html_body, '') IS NOT NULL AND html_body_ciphertext IS NOT NULL))
                ORDER BY created_at ASC, id ASC LIMIT ${batchSize})
            RETURNING id::text AS id`),
          ).length,
      )
      draftsPurged += done
      if (done === 0) break
    }

    // ── 7b: reduce raw_headers to the section 5.2 allowlist. ────────────────
    // One shared constant, spliced as bound parameters: the trigger carries the
    // same list as literal SQL and `header-allowlist.test.ts` asserts they agree.
    for (;;) {
      const done = await run(orgId, "mailbox-purge:headers", (tx) =>
        reduceRawHeadersBatch(tx, accountIds, batchSize),
      )
      headersReduced += done
      if (done === 0) break
    }
  }

  // ── 7c: attachment derivatives. ───────────────────────────────────────────
  const derivatives = await (deps.purgeDerivatives ?? purgeMailAttachmentDerivatives)(userId)

  // ── 7d + step 8: control-plane residue and the search index. ──────────────
  const residue = await purgeControlPlaneResidue(run, userId, orgId, accountIds)
  const searchPurge = await purgeSearchDocuments(run, deps, orgId, accountIds)
  const searchDocumentsDeleted = searchPurge.deleted

  // ── Backup clearance: a WAITING PERIOD, never a delete. ───────────────────
  const backupConfig = backupConfigFromEnv()
  const policies = deps.repoPolicies ?? backupConfig.repos
  let clearance: BackupClearance | null = null
  let backupsClearAfter = new Date(
    purgedAt.getTime() +
      Math.max(
        ...policies.map((p) =>
          p.type === "count"
            ? p.retentionFull * (p.fullIntervalDays ?? 1)
            : Math.max(p.retentionFull, p.complianceLockDays ?? 0),
        ),
      ) *
        24 *
        60 *
        60 *
        1000,
  )
  if (deps.pgbackrestInfo !== undefined) {
    clearance = computeBackupClearance({
      info: deps.pgbackrestInfo,
      stanza: deps.stanza ?? backupConfig.stanza,
      plaintextPurgedAt: purgedAt,
      repos: policies,
    })
    backupsClearAfter = clearance.clearAfter
  }

  // Attachment BYTES received before enrolment are still stored as they
  // arrived: there is no backfill phase that seals them. The derivative purge
  // above cleared their thumbnails and analysis text, so what remains is the
  // substantive content of that historical mail, readable by the operator.
  //
  // While that count is non-zero the cutover is NOT complete, and the ledger
  // says so by NOT stamping `plaintext_purged_at` or starting the backup
  // clearance clock. `meili_purged_at` is stamped independently, and only when
  // the index delete actually succeeded. Stamping a completion that has not
  // happened is the one outcome worth refusing here: an operator reading this
  // ledger would conclude the mailbox is closed when the attachments are wide
  // open, or that the index is clean when the subjects are still in it.
  const unsealedAttachments = await (deps.countUnsealedAttachments ?? countUnsealedMailAttachments)(
    userId,
  )
  const cutoverComplete = unsealedAttachments === 0

  // `meili_purged_at = meili_purged_at` is the deliberate no-op: on a failed
  // index delete the column keeps whatever it held, so a re-run can stamp it.
  const meiliStamp = searchPurge.ok
    ? drizzleSql`${purgedAt.toISOString()}::timestamptz`
    : drizzleSql`meili_purged_at`
  // `plaintext_purge_ran_at` is stamped on BOTH branches, and that is the point
  // of it (migration 0042). The completion columns stay behind
  // `cutoverComplete`, so the refusal to declare a cutover closed while
  // attachments are readable is untouched; what changes is that a mailbox whose
  // bodies have been destroyed can no longer read as untouched. An operator who
  // is interrupted, or who comes back the next day, would otherwise see
  // `plaintext_purged_at IS NULL` and conclude nothing happened, when the only
  // remaining readable copies are inside compliance-locked backups.
  await run(orgId, "mailbox-purge:ledger", (tx) =>
    cutoverComplete
      ? tx.execute(drizzleSql`
        UPDATE ${K}.mailbox_migration_state
           SET plaintext_purge_ran_at = coalesce(plaintext_purge_ran_at, ${purgedAt.toISOString()}::timestamptz),
               plaintext_purged_at = coalesce(plaintext_purged_at, ${purgedAt.toISOString()}::timestamptz),
               meili_purged_at = ${meiliStamp},
               backups_clear_after = ${backupsClearAfter.toISOString()}::timestamptz
         WHERE user_id = ${userId}::uuid`)
      : tx.execute(drizzleSql`
        UPDATE ${K}.mailbox_migration_state
           SET plaintext_purge_ran_at = coalesce(plaintext_purge_ran_at, ${purgedAt.toISOString()}::timestamptz),
               meili_purged_at = ${meiliStamp}
         WHERE user_id = ${userId}::uuid`),
  )

  // Measured AFTER the writes, so it reports the state an operator would find,
  // not the state this function believes it produced.
  const remainingPlaintext = await run(orgId, "mailbox-purge:remaining", (tx) =>
    countRemainingPlaintext(tx, accountIds),
  )

  if (!searchPurge.ok) {
    log.error(
      { userId, orgId },
      "mailbox search purge did not complete: meili_purged_at left unstamped so step 8 can be re-run",
    )
  }

  if (!cutoverComplete) {
    log.error(
      { userId, orgId, unsealedAttachments },
      "mailbox cutover NOT marked complete: personal-mail attachment objects are still stored in the clear, " +
        "so the operator can still read the substantive content of this historical mail",
    )
  }

  const alreadyPurged =
    messagesPurged === 0 &&
    conversationsPurged === 0 &&
    draftsPurged === 0 &&
    headersReduced === 0 &&
    derivatives.filesCleared === 0 &&
    residue === 0

  log.warn(
    {
      userId,
      messagesPurged,
      conversationsPurged,
      draftsPurged,
      headersReduced,
      derivativesCleared: derivatives.filesCleared,
      searchDocumentsDeleted,
      residueRows: residue,
      backupsClearAfter,
      unsealedAttachments,
      cutoverComplete,
      remainingPlaintext,
    },
    cutoverComplete
      ? "mailbox plaintext purged (irreversible)"
      : "mailbox plaintext purged (irreversible), cutover INCOMPLETE: unsealed attachment objects remain",
  )

  return {
    userId,
    orgId,
    messagesPurged,
    conversationsPurged,
    draftsPurged,
    headersReduced,
    derivativesCleared: derivatives.filesCleared,
    searchDocumentsDeleted,
    plaintextPurgedAt: purgedAt,
    plaintextPurgeRanAt: purgedAt,
    remainingPlaintext,
    backupsClearAfter,
    backupClearance: clearance,
    alreadyPurged,
    unsealedAttachments,
    cutoverComplete,
  }
}

/**
 * Step 7d: the control-plane residue that accumulated BEFORE the cutover.
 *
 * Everything written after the cutover is already envelope-only (Phase 6), so
 * this is strictly about history: audit-log change payloads, timeline entries,
 * thread titles, approval payloads and the tool-call results persisted on
 * `kernel.messages.metadata`, for mail entities of this mailbox.
 */
async function purgeControlPlaneResidue(
  run: ReturnType<typeof runPrivileged>,
  userId: string,
  orgId: string,
  accountIds: string[],
): Promise<number> {
  if (accountIds.length === 0) return 0
  return run(orgId, "mailbox-purge:residue", async (tx) => {
    const accountList = drizzleSql.join(
      accountIds.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql.raw(", "),
    )
    const entityIds = drizzleSql`
      SELECT id::text AS id FROM ${MAIL}.messages WHERE account_id IN (${accountList})
      UNION ALL
      SELECT id::text FROM ${MAIL}.conversations WHERE account_id IN (${accountList})
      UNION ALL
      SELECT id::text FROM ${MAIL}.drafts WHERE account_id IN (${accountList})`

    let touched = 0
    touched += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.audit_log SET changes = '{}'::jsonb
         WHERE org_id = ${orgId}::uuid AND app = 'mail'
           AND changes IS NOT NULL AND changes <> '{}'::jsonb
           AND entity_id IN (${entityIds})
        RETURNING id::text AS id`),
    ).length

    touched += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.threads SET title = 'Mail conversation'
          FROM ${MAIL}.conversations c
         WHERE c.account_id IN (${accountList})
           AND ${K}.threads.id = c.internal_thread_id
           AND ${K}.threads.title IS NOT NULL
           AND ${K}.threads.title <> 'Mail conversation'
        RETURNING ${K}.threads.id::text AS id`),
    ).length

    touched += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
           SET tool_params = '{}'::jsonb, current_payload = '{}'::jsonb, summary = NULL
         WHERE org_id = ${orgId}::uuid AND tool_name LIKE 'mail\_\_%'
           AND requested_by = ${userId}::uuid
           AND (tool_params <> '{}'::jsonb OR current_payload <> '{}'::jsonb
                OR summary IS NOT NULL)
        RETURNING id::text AS id`),
    ).length

    // `kernel.messages.metadata.toolCalls[].result` is where a mail read the
    // agent performed before the cutover is still sitting in cleartext.
    touched += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.messages SET metadata = metadata #- '{toolCalls}'
         WHERE org_id = ${orgId}::uuid
           AND EXISTS (
             SELECT 1 FROM ${K}.thread_participants p
              WHERE p.thread_id = ${K}.messages.thread_id AND p.user_id = ${userId}::uuid)
           AND jsonb_typeof(metadata -> 'toolCalls') = 'array'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(metadata -> 'toolCalls') tc
              WHERE tc ->> 'toolName' LIKE 'mail\_\_%' AND tc -> 'result' IS NOT NULL)
        RETURNING id::text AS id`),
    ).length

    return touched
  })
}

/**
 * Step 8: delete this mailbox's documents from every Meili index that could
 * hold content.
 *
 * Liaison has ONE canonical index today (`effectiveIndexName()`), and kernel
 * threads live in it alongside the mail entities, so the "thread index" the
 * spec names is covered by deleting the thread documents of these
 * conversations. Both entity type spellings are deleted because
 * `documentId` is built from whatever the registration used.
 */
async function purgeSearchDocuments(
  run: ReturnType<typeof runPrivileged>,
  deps: PurgeDeps,
  orgId: string,
  accountIds: string[],
): Promise<{ deleted: number; ok: boolean }> {
  if (accountIds.length === 0) return { deleted: 0, ok: true }
  const ids = await run(orgId, "mailbox-purge:search-ids", async (tx) => {
    const accountList = drizzleSql.join(
      accountIds.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql.raw(", "),
    )
    const rows = extractRows<{ kind: string; id: string }>(
      await tx.execute(drizzleSql`
        SELECT 'message' AS kind, id::text AS id FROM ${MAIL}.messages
         WHERE account_id IN (${accountList})
        UNION ALL
        SELECT 'conversation', id::text FROM ${MAIL}.conversations
         WHERE account_id IN (${accountList})
        UNION ALL
        SELECT 'draft', id::text FROM ${MAIL}.drafts WHERE account_id IN (${accountList})
        UNION ALL
        SELECT 'thread', internal_thread_id::text FROM ${MAIL}.conversations
         WHERE account_id IN (${accountList}) AND internal_thread_id IS NOT NULL`),
    )
    const out: string[] = []
    for (const row of rows) {
      if (row.kind === "thread") {
        out.push(documentId(orgId, "kernel", "thread", row.id))
        continue
      }
      out.push(documentId(orgId, "mail", row.kind, row.id))
      out.push(documentId(orgId, "mail", `${row.kind}s`, row.id))
    }
    return out
  })
  if (ids.length === 0) return { deleted: 0, ok: true }

  const indexName = effectiveIndexName()
  const remove =
    deps.deleteSearchDocuments ??
    // Through the one index writer: a rebuild running now replays the delete
    // into its shadow index, which may hold these documents from before.
    (async (_name: string, documentIds: string[]) => {
      await deleteSearchDocumentsNow(orgId, documentIds)
    })
  try {
    await remove(indexName, ids)
  } catch (err) {
    // A Meili outage must not roll back the database purge, and it must not be
    // recorded as a completed step 8 either. The caller leaves `meili_purged_at`
    // NULL on a false here, so step 8 can be re-run against this exact mailbox:
    // the plaintext subjects and snippets are still live in the index, and the
    // database purge has already removed the rows that would regenerate a signal
    // that they are there. The ledger is the durable record, so it must not
    // assert a purge that did not happen.
    log.error({ err, indexName, count: ids.length }, "mailbox search purge failed")
    return { deleted: 0, ok: false }
  }
  return { deleted: ids.length, ok: true }
}
