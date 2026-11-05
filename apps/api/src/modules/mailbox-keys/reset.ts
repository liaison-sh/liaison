// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox reset: what a user does when they have forgotten their mailbox
// password.
//
// There is no recovery phrase and nobody can recover an Account Key, so the
// only way back into an encrypted personal mailbox without the password is to
// start again. That is acceptable because everything in the mailbox is a COPY
// of the provider's mail: it re-downloads. The only data that exists in Liaison
// alone, drafts written here and agent-written sends waiting for approval, is
// lost, and the product accepts that loss.
//
// What the reset does, for the CALLING user only (their org, their user id,
// taken from the authenticated context and never from the request), in ONE
// transaction:
//   * deletes the keyring: every identity row and every unlock wrap,
//   * deletes every message, conversation and draft of the user's personal
//     mailboxes, and every `kernel.files` row parented to them (attachments,
//     their derivatives, outbound staging),
//   * deletes the internal discussion thread of each deleted conversation (or,
//     when an approval or task still references it, empties it), and clears
//     the ticket links that point at deleted conversations,
//   * cancels the pending sealed mail approvals of those mailboxes and strips
//     the sealed payload from every such approval (the ciphertext is under a
//     key that no longer exists), including their copies in the event outbox,
//   * deletes the user's headless mailbox client jobs,
//   * clears the per-user cutover ledger's backfill and verification columns
//     (they describe a corpus that no longer exists), keeping `enrolled_at` and
//     the purge history: `enrolled_at` is what keeps the mailbox ARMED
//     (`mailbox_invariant_armed`), and the purge history records when the
//     backups stop holding plaintext, which a reset does not change,
//   * moves each personal mailbox back to `pending_enrollment` (its sync is
//     suspended until new keys exist) and resets its sync cursor to
//     `pre-sync`, so the next enrollment re-downloads the mailbox from scratch;
//     the cursor carries this transaction's id, which a sync run that started
//     before the reset is refused by (see `assertMailboxNotResetMidRun`),
//   * writes an audit log row.
//
// What it keeps: the mail account rows and the OAuth connection
// (`kernel.connected_accounts`), so no reconnect is needed.
//
// NO PLAINTEXT IS WRITTEN AFTER A RESET. The owner has enrolled before, so
// `mailbox_invariant_armed` stays true with no identity at all: every writer
// must seal, has no key to seal to, and refuses. Sync is suspended by
// `pending_enrollment`. Re-enrolling arms the mailbox to the new key and
// `enqueueResyncForReadyMailboxes` starts the initial sync.
//
// The search index documents and the stored attachment objects are removed
// AFTER the commit, best effort, exactly like the Phase 12 purge: a Meili or
// bucket outage must not roll the database back, and the rows that could
// regenerate those documents are already gone.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { effectiveIndexName } from "~/infra/search/client"
import { deleteObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { loadApprovalSummary } from "~/modules/approvals/event-data"
import { writeAuditLog } from "~/modules/audit/service"
import { advanceOwnerEncryptionState } from "~/modules/mailbox-keys/encryption-state"
import { documentId } from "~/modules/search/document-id"
import { deleteSearchDocumentsNow } from "~/modules/search/index-writer"

const log = rootLogger.child({ module: "mailbox-reset" })

const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

type Executor = Pick<PrivilegedDb, "execute">

/** The caller has no encrypted mailbox: nothing to reset. The route answers 409. */
export class MailboxNotEnrolledError extends Error {
  constructor() {
    super("there is no encrypted mailbox to reset: set up mailbox encryption first")
    this.name = "MailboxNotEnrolledError"
  }
}

export interface MailboxResetCounts {
  accounts: number
  messages: number
  conversations: number
  drafts: number
  files: number
  approvalsCancelled: number
  approvalPayloadsCleared: number
  /** Delivered outbox copies of those approvals, deleted. */
  approvalEventsDeleted: number
  /** Undelivered outbox copies, kept for delivery with the payload emptied. */
  approvalEventsCleared: number
  /** Internal discussion threads of the deleted conversations. */
  threadsDeleted: number
  /** Such threads an approval or task still references: emptied, not deleted. */
  threadsNeutralised: number
  /** Tickets whose link to a deleted conversation was cleared. */
  ticketLinksCleared: number
  clientJobs: number
  wraps: number
  identities: number
}

export interface MailboxResetResult {
  /** The personal mailboxes that were reset, and will re-sync after enrollment. */
  accountIds: string[]
  counts: MailboxResetCounts
  /** False when the index delete failed; the rows are gone either way. */
  searchDocumentsDeleted: boolean
}

export interface MailboxResetDeps {
  privileged?: <T>(
    orgId: string,
    reason: string,
    fn: (tx: PrivilegedDb) => Promise<T>,
  ) => Promise<T>
  deleteSearchDocuments?: (indexName: string, ids: string[]) => Promise<void>
  deleteStoredObject?: (key: string) => Promise<void>
}

function idList(ids: string[]) {
  return drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )
}

/**
 * The `kernel.files` rows parented to these mailboxes. The same scope as the
 * derivative purge (`attachment-derivatives.ts`), so the two can never
 * disagree about which files belong to a personal mailbox.
 */
function mailFileScope(accountIds: string[]) {
  const ids = idList(accountIds)
  return drizzleSql`
    f.app = 'mail' AND (
      (f.entity_type IN ('message', 'messages') AND f.entity_id IN (
         SELECT id::text FROM ${MAIL}.messages WHERE account_id IN (${ids})))
      OR (f.entity_type IN ('conversation', 'conversations') AND f.entity_id IN (
         SELECT id::text FROM ${MAIL}.conversations WHERE account_id IN (${ids})))
      OR (f.entity_type IN ('draft', 'drafts') AND f.entity_id IN (
         SELECT id::text FROM ${MAIL}.drafts WHERE account_id IN (${ids})))
      OR (f.entity_type = 'outbound_staging' AND f.entity_id IN (
         SELECT id::text FROM ${MAIL}.accounts WHERE id IN (${ids})))
    )`
}

/**
 * Mail approvals that act on one of these mailboxes, sealed or not. The
 * target's ids stay in clear in both shapes (`accountId`, `conversationId`,
 * `messageId`, `draftId`), which is what ties the approval to a mailbox.
 */
function mailApprovalScope(orgId: string, accountIds: string[]) {
  const ids = idList(accountIds)
  const param = (key: string) =>
    drizzleSql`coalesce(ar.tool_params ->> ${key}, ar.current_payload ->> ${key})`
  return drizzleSql`
    ar.org_id = ${orgId}::uuid
    AND ar.tool_name LIKE 'mail\\_\\_%'
    AND (
      ${param("accountId")} IN (SELECT id::text FROM ${MAIL}.accounts WHERE id IN (${ids}))
      OR ${param("conversationId")} IN (
        SELECT id::text FROM ${MAIL}.conversations WHERE account_id IN (${ids}))
      OR ${param("messageId")} IN (
        SELECT id::text FROM ${MAIL}.messages WHERE account_id IN (${ids}))
      OR ${param("draftId")} IN (
        SELECT id::text FROM ${MAIL}.drafts WHERE account_id IN (${ids}))
    )`
}

/** Of those, the ones whose payload was SEALED under the key the reset destroys. */
function sealedMailApprovalScope(orgId: string, accountIds: string[]) {
  return drizzleSql`${mailApprovalScope(orgId, accountIds)}
    AND (ar.tool_params ->> 'mailboxSealed' = 'true' OR ar.current_payload ->> 'mailboxSealed' = 'true')`
}

/** What an approval list shows for an approval the reset cancelled. */
const RESET_CANCELLED_SUMMARY = {
  kind: "mail",
  title: "Cancelled: mailbox was reset",
  lines: ["The mailbox this email belonged to was reset, so the email was not sent."],
  impact: "external",
}

/** What it shows for a decided approval whose sealed content the reset removed. */
const RESET_CLEARED_SUMMARY = {
  kind: "mail",
  title: "Email content removed: mailbox was reset",
  lines: ["This email was encrypted with keys that no longer exist."],
  impact: "external",
}

async function deleteReturningCount(tx: Executor, query: ReturnType<typeof drizzleSql>) {
  return extractRows<{ id: string }>(await tx.execute(query)).length
}

/**
 * Reset the calling user's encrypted personal mailbox. `userId` and `orgId`
 * MUST come from the authenticated request context: every statement below is
 * filtered on them and on nothing the client sent.
 */
export async function resetMailbox(
  userId: string,
  orgId: string,
  deps: MailboxResetDeps = {},
): Promise<MailboxResetResult> {
  const run =
    deps.privileged ??
    (<T>(org: string, reason: string, fn: (tx: PrivilegedDb) => Promise<T>) =>
      withPrivilegedDb(org, reason, fn))

  const { accountIds, counts, searchIds, storageKeys } = await run(
    orgId,
    "mailbox-reset",
    async (tx) => {
      // Lock the owner's personal mailboxes first. The advisory lock is the
      // one every mail sync write takes SHARED (`assertMailboxNotResetMidRun`
      // in the sandbox bridge): taking it exclusive waits for any write in
      // flight to commit, so what it wrote is deleted below, and holds back
      // any write that arrives meanwhile until this reset is visible to it.
      const ownedAccounts = drizzleSql`
          SELECT id::text AS id FROM ${MAIL}.accounts
           WHERE org_id = ${orgId}::uuid AND owner_type = 'user' AND owner_id = ${userId}::uuid
           ORDER BY id`
      const locked = new Set<string>()
      const lockAccounts = async (ids: string[]) => {
        for (const id of ids) {
          if (locked.has(id)) continue
          await tx.execute(
            drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`mailbox-reset:${id}`}, 0))`,
          )
          locked.add(id)
        }
      }
      await lockAccounts(
        extractRows<{ id: string }>(await tx.execute(ownedAccounts)).map((r) => r.id),
      )
      const accountIds = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`${ownedAccounts} FOR UPDATE`),
      ).map((r) => r.id)
      await lockAccounts(accountIds)

      // Only a mailbox that was ever encrypted can be reset. A caller who never
      // enrolled has nothing to reset, and writing `enrolled_at` below would
      // ARM their mailboxes (`mailbox_invariant_armed`) with no key to seal to.
      const enrolledBefore = extractRows<{ ok: boolean }>(
        await tx.execute(drizzleSql`
          SELECT (
            EXISTS (SELECT 1 FROM ${K}.user_mailbox_identities
                     WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid)
            OR EXISTS (SELECT 1 FROM ${K}.mailbox_migration_state
                        WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid
                          AND enrolled_at IS NOT NULL)
          ) AS ok`),
      )[0]?.ok
      if (!enrolledBefore) throw new MailboxNotEnrolledError()

      const counts: MailboxResetCounts = {
        accounts: accountIds.length,
        messages: 0,
        conversations: 0,
        drafts: 0,
        files: 0,
        approvalsCancelled: 0,
        approvalPayloadsCleared: 0,
        approvalEventsDeleted: 0,
        approvalEventsCleared: 0,
        threadsDeleted: 0,
        threadsNeutralised: 0,
        ticketLinksCleared: 0,
        clientJobs: 0,
        wraps: 0,
        identities: 0,
      }
      let searchIds: string[] = []
      let storageKeys: string[] = []
      let cancelledApprovalIds: string[] = []
      const sealedFlag = drizzleSql`(ar.tool_params ->> 'mailboxSealed' = 'true'
        OR ar.current_payload ->> 'mailboxSealed' = 'true')`

      if (accountIds.length > 0) {
        const ids = idList(accountIds)

        // Collected BEFORE the rows go: afterwards nothing names them.
        searchIds = extractRows<{ kind: string; id: string }>(
          await tx.execute(drizzleSql`
            SELECT 'message' AS kind, id::text AS id FROM ${MAIL}.messages
             WHERE account_id IN (${ids})
            UNION ALL
            SELECT 'conversation', id::text FROM ${MAIL}.conversations
             WHERE account_id IN (${ids})
            UNION ALL
            SELECT 'draft', id::text FROM ${MAIL}.drafts WHERE account_id IN (${ids})`),
        ).flatMap((row) => [
          documentId(orgId, "mail", row.kind, row.id),
          documentId(orgId, "mail", `${row.kind}s`, row.id),
        ])

        // The internal discussion thread of each conversation. Liaison-only
        // data, so it goes with the conversation (the product accepts that
        // loss), and so does its search document.
        const internalThreads = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT DISTINCT internal_thread_id::text AS id FROM ${MAIL}.conversations
             WHERE account_id IN (${ids}) AND internal_thread_id IS NOT NULL`),
        ).map((r) => r.id)
        for (const id of internalThreads) searchIds.push(documentId(orgId, "kernel", "thread", id))

        // Every approval for these mailboxes, BEFORE the rows it is resolved
        // through are deleted: their outbox copies are handled below.
        const approvalIds = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT ar.id::text AS id FROM ${K}.approval_requests ar
             WHERE ${sealedMailApprovalScope(orgId, accountIds)}`),
        ).map((r) => r.id)

        // Approvals first: their scope is resolved through the message and
        // conversation rows, which are deleted below.
        // Every PENDING mail approval on these mailboxes is cancelled, sealed or
        // not: the mail it acts on is deleted below. It keeps a readable
        // summary, so an approval list shows why rather than a bare tool name.
        cancelledApprovalIds = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            UPDATE ${K}.approval_requests ar
               SET status = 'cancelled', decided_at = now(),
                   reason = 'Cancelled: mailbox was reset',
                   approving_started_at = NULL,
                   summary = ${JSON.stringify(RESET_CANCELLED_SUMMARY)}::jsonb,
                   tool_params = CASE WHEN ${sealedFlag} THEN '{}'::jsonb ELSE ar.tool_params END,
                   current_payload = CASE WHEN ${sealedFlag} THEN '{}'::jsonb
                                          ELSE ar.current_payload END
             WHERE ar.status = 'pending' AND ${mailApprovalScope(orgId, accountIds)}
            RETURNING ar.id::text AS id`),
        ).map((r) => r.id)
        counts.approvalsCancelled = cancelledApprovalIds.length
        // Decided SEALED approvals lose their ciphertext too. `approving` is left
        // alone: its executor is reading the payload right now, and it fails on
        // its own when the send cannot be sealed.
        counts.approvalPayloadsCleared =
          counts.approvalsCancelled +
          (await deleteReturningCount(
            tx,
            drizzleSql`
              UPDATE ${K}.approval_requests ar
                 SET tool_params = '{}'::jsonb, current_payload = '{}'::jsonb,
                     summary = ${JSON.stringify(RESET_CLEARED_SUMMARY)}::jsonb
               WHERE ar.status NOT IN ('approving', 'pending', 'cancelled')
                 AND ${sealedMailApprovalScope(orgId, accountIds)}
              RETURNING ar.id::text AS id`,
          ))

        // The durable outbox copies of those approvals (`kernel.pending_events`
        // carries the summary and the payload, ciphertext included). Delivered
        // ones are history and go; undelivered ones stay so the outbox still
        // delivers the event, with the payload emptied.
        if (approvalIds.length > 0) {
          const approvalList = drizzleSql.join(
            approvalIds.map((id) => drizzleSql`${id}`),
            drizzleSql.raw(", "),
          )
          const approvalEvents = drizzleSql`
            org_id = ${orgId}::uuid
            AND payload ->> 'entity' = 'approval_request'
            AND payload ->> 'entityId' IN (${approvalList})`
          counts.approvalEventsDeleted = await deleteReturningCount(
            tx,
            drizzleSql`
              DELETE FROM ${K}.pending_events
               WHERE ${approvalEvents} AND processed_at IS NOT NULL
              RETURNING id::text AS id`,
          )
          counts.approvalEventsCleared = await deleteReturningCount(
            tx,
            drizzleSql`
              UPDATE ${K}.pending_events
                 SET payload = jsonb_set(payload, '{data}', '{"mailboxReset": true}'::jsonb)
               WHERE ${approvalEvents} AND processed_at IS NULL
              RETURNING id::text AS id`,
          )
        }

        // Tickets that point at these conversations: the link goes, the ticket
        // stays. The tickets app may not be installed at all.
        const ticketsInstalled = extractRows<{ ok: boolean }>(
          await tx.execute(drizzleSql`
            SELECT count(*) = 2 AS ok FROM information_schema.columns
             WHERE table_schema = ${schemaRef("app_tickets")} AND table_name = 'tickets'
               AND column_name IN ('source_conversation_id', 'converted_to_mail_conversation_id')`),
        )[0]?.ok
        if (ticketsInstalled) {
          const TICKETS = drizzleSql.raw(`"${schemaRef("app_tickets")}"`)
          counts.ticketLinksCleared = await deleteReturningCount(
            tx,
            drizzleSql`
              UPDATE ${TICKETS}.tickets t
                 SET source_conversation_id = CASE
                       WHEN t.source_conversation_id IN (
                         SELECT id FROM ${MAIL}.conversations WHERE account_id IN (${ids}))
                       THEN NULL ELSE t.source_conversation_id END,
                     converted_to_mail_conversation_id = CASE
                       WHEN t.converted_to_mail_conversation_id IN (
                         SELECT id FROM ${MAIL}.conversations WHERE account_id IN (${ids}))
                       THEN NULL ELSE t.converted_to_mail_conversation_id END
               WHERE t.org_id = ${orgId}::uuid
                 AND (t.source_conversation_id IN (
                        SELECT id FROM ${MAIL}.conversations WHERE account_id IN (${ids}))
                   OR t.converted_to_mail_conversation_id IN (
                        SELECT id FROM ${MAIL}.conversations WHERE account_id IN (${ids})))
              RETURNING t.id::text AS id`,
          )
        }

        const files = extractRows<{
          id: string
          storage_key: string | null
          thumbnail_key: string | null
        }>(
          await tx.execute(drizzleSql`
            DELETE FROM ${K}.files f
             WHERE f.org_id = ${orgId}::uuid AND ${mailFileScope(accountIds)}
            RETURNING f.id::text AS id, f.storage_key, f.thumbnail_key`),
        )
        counts.files = files.length
        const candidateKeys = [
          ...new Set(
            files.flatMap((f) => [f.storage_key, f.thumbnail_key]).filter((k): k is string => !!k),
          ),
        ]
        if (candidateKeys.length > 0) {
          // An object another file row still points at stays in the bucket.
          const stillReferenced = new Set(
            extractRows<{ key: string }>(
              await tx.execute(drizzleSql`
                SELECT storage_key AS key FROM ${K}.files
                 WHERE storage_key IN (${drizzleSql.join(
                   candidateKeys.map((k) => drizzleSql`${k}`),
                   drizzleSql.raw(", "),
                 )})
                UNION
                SELECT thumbnail_key FROM ${K}.files
                 WHERE thumbnail_key IN (${drizzleSql.join(
                   candidateKeys.map((k) => drizzleSql`${k}`),
                   drizzleSql.raw(", "),
                 )})`),
            ).map((r) => r.key),
          )
          storageKeys = candidateKeys.filter((k) => !stillReferenced.has(k))
        }

        counts.drafts = await deleteReturningCount(
          tx,
          drizzleSql`DELETE FROM ${MAIL}.drafts WHERE account_id IN (${ids}) RETURNING id::text AS id`,
        )
        counts.messages = await deleteReturningCount(
          tx,
          drizzleSql`DELETE FROM ${MAIL}.messages WHERE account_id IN (${ids}) RETURNING id::text AS id`,
        )
        counts.conversations = await deleteReturningCount(
          tx,
          drizzleSql`DELETE FROM ${MAIL}.conversations WHERE account_id IN (${ids}) RETURNING id::text AS id`,
        )

        // The internal threads, now that nothing in the mailbox points at them.
        // A thread an approval or a task still references cannot be deleted
        // (those foreign keys restrict), so it is emptied instead: its messages
        // go and its title is the neutral one the purge uses.
        if (internalThreads.length > 0) {
          const threadList = drizzleSql.join(
            internalThreads.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql.raw(", "),
          )
          const tasksInstalled = extractRows<{ ok: boolean }>(
            await tx.execute(drizzleSql`
              SELECT to_regclass(${`${schemaRef("app_projects")}.tasks`}) IS NOT NULL AS ok`),
          )[0]?.ok
          const referencedByTask = tasksInstalled
            ? drizzleSql`OR EXISTS (SELECT 1 FROM ${drizzleSql.raw(`"${schemaRef("app_projects")}"`)}.tasks tk
                                     WHERE tk.thread_id = th.id)`
            : drizzleSql``
          const kept = drizzleSql`(
            EXISTS (SELECT 1 FROM ${K}.approval_requests ar
                     WHERE ar.thread_id = th.id OR ar.originating_thread_id = th.id)
            ${referencedByTask})`
          counts.threadsDeleted = await deleteReturningCount(
            tx,
            drizzleSql`
              DELETE FROM ${K}.threads th
               WHERE th.org_id = ${orgId}::uuid AND th.id IN (${threadList}) AND NOT ${kept}
              RETURNING th.id::text AS id`,
          )
          await tx.execute(drizzleSql`
            DELETE FROM ${K}.messages m
             USING ${K}.threads th
             WHERE m.thread_id = th.id AND th.org_id = ${orgId}::uuid AND th.id IN (${threadList})`)
          counts.threadsNeutralised = await deleteReturningCount(
            tx,
            drizzleSql`
              UPDATE ${K}.threads th SET title = 'Mail conversation'
               WHERE th.org_id = ${orgId}::uuid AND th.id IN (${threadList})
              RETURNING th.id::text AS id`,
          )
        }

        // Back to waiting for keys. The state machine owns the column; `reset`
        // is legal from `ready`, `blocked` and `paused`, and a mailbox already
        // at `pending_enrollment` is left where it is.
        await advanceOwnerEncryptionState(tx, schemaRef("app_mail"), userId, "reset")

        // Start the import again from nothing once new keys exist: `pre-sync`
        // with no cursor is exactly how a newly connected mailbox begins.
        await tx.execute(drizzleSql`
          UPDATE ${MAIL}.accounts
             SET sync_status = 'pre-sync',
                 -- The marker a sync run that started before this reset is
                 -- refused by (assertMailboxNotResetMidRun).
                 sync_state = jsonb_build_object('resetXid', pg_current_xact_id()::text),
                 last_sync_at = NULL, last_sync_error = NULL
           WHERE id IN (${ids})`)
      }

      counts.clientJobs = await deleteReturningCount(
        tx,
        drizzleSql`
          DELETE FROM ${K}.mailbox_client_jobs
           WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
          RETURNING id::text AS id`,
      )
      counts.wraps = await deleteReturningCount(
        tx,
        drizzleSql`
          DELETE FROM ${K}.user_key_wraps
           WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
          RETURNING id::text AS id`,
      )
      counts.identities = await deleteReturningCount(
        tx,
        drizzleSql`
          DELETE FROM ${K}.user_mailbox_identities
           WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
          RETURNING id::text AS id`,
      )

      // The ledger. `enrolled_at` is SET (coalesce keeps the first enrolment)
      // rather than cleared: it is what keeps this mailbox armed while it has no
      // key. Everything describing the deleted corpus goes.
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.mailbox_migration_state (user_id, org_id, enrolled_at)
        VALUES (${userId}::uuid, ${orgId}::uuid, now())
        ON CONFLICT (user_id) DO UPDATE SET
          enrolled_at = coalesce(${K}.mailbox_migration_state.enrolled_at, now()),
          backfill_started_at = NULL,
          backfill_completed_at = NULL,
          backfill_cursor = NULL,
          messages_total = NULL,
          messages_sealed = NULL,
          verify_nonce = NULL,
          verify_nonce_issued_at = NULL,
          client_verified_at = NULL,
          client_ack_signature = NULL,
          client_ack_id_digest = NULL,
          client_ack_count = NULL,
          client_ack_key_id = NULL,
          client_ack_account_id = NULL,
          client_ack_nonce = NULL,
          client_ack_cursor = NULL`)

      // Open approval lists update live: the same event every other terminal
      // transition emits, carrying the readable cancelled summary.
      for (const id of cancelledApprovalIds) {
        await tx.queueEvent({
          app: "kernel",
          entity: "approval_request",
          action: "update",
          entityId: id,
          orgId,
          actorId: userId,
          actorType: "user",
          data: await loadApprovalSummary(tx, orgId, id),
        })
      }

      await writeAuditLog(tx, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: "kernel",
        entityType: "mailbox",
        entityId: userId,
        action: "mailbox_reset",
        // Counts and ids only: nothing here says anything about the mail.
        metadata: { accountIds, ...counts },
      })

      return { accountIds, counts, searchIds, storageKeys }
    },
  )

  let searchDocumentsDeleted = true
  if (searchIds.length > 0) {
    const remove =
      deps.deleteSearchDocuments ??
      // Through the one index writer: a rebuild running now replays the
      // delete into its shadow index, which may hold these documents too.
      (async (_name: string, documentIds: string[]) => {
        await deleteSearchDocumentsNow(orgId, documentIds)
      })
    try {
      await remove(effectiveIndexName(), searchIds)
    } catch (err) {
      searchDocumentsDeleted = false
      log.error({ err, userId, orgId }, "mailbox reset: search document delete failed")
    }
  }
  const removeObject = deps.deleteStoredObject ?? ((key: string) => deleteObject(key))
  for (const key of storageKeys) {
    try {
      await removeObject(key)
    } catch (err) {
      log.warn({ err, userId }, "mailbox reset: stored attachment object delete failed")
    }
  }

  log.warn({ userId, orgId, ...counts }, "mailbox reset by its owner")
  return { accountIds, counts, searchDocumentsDeleted }
}

/**
 * After (re-)enrollment: start the import for every personal mailbox of this
 * user that is armed to the new key and has never synced. That is the state a
 * reset leaves behind (`pre-sync`, no cursor). The fixed job id dedupes against
 * an import already queued. The enrollment has already committed, so a queue
 * failure does not fail it: each mailbox whose import could not be queued is
 * logged as an error and returned in `deferred`, which the route hands back to
 * the client, and the mail app's stranded-import sweep re-drives it. Nothing
 * is dropped silently.
 */
export async function enqueueResyncForReadyMailboxes(
  userId: string,
  orgId: string,
): Promise<{ enqueued: string[]; deferred: string[] }> {
  let rows: Array<{ id: string; provider: string }>
  try {
    rows = await withPrivilegedDb(orgId, "mailbox-reset:resync-scan", async (tx) =>
      extractRows<{ id: string; provider: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, provider FROM ${MAIL}.accounts
           WHERE org_id = ${orgId}::uuid AND owner_type = 'user' AND owner_id = ${userId}::uuid
             AND encryption_state = 'ready' AND sync_status = 'pre-sync'
             AND disconnected_at IS NULL`),
      ),
    )
  } catch (err) {
    log.error(
      { err, userId, orgId },
      "mailbox resync scan failed; the stranded-sync sweep will retry",
    )
    return { enqueued: [], deferred: [] }
  }
  const enqueued: string[] = []
  const deferred: string[] = []
  for (const row of rows) {
    const jobName = row.provider === "gmail" ? "gmail-initial-sync" : "imap-initial-sync"
    try {
      await enqueueAppJob(
        "mail",
        jobName,
        { orgId, accountId: row.id },
        { jobId: `${jobName}:${row.id}` },
      )
      enqueued.push(row.id)
    } catch (err) {
      deferred.push(row.id)
      log.error(
        { err, userId, orgId, accountId: row.id },
        "mailbox import could not be queued; the stranded-sync sweep will retry",
      )
    }
  }
  return { enqueued, deferred }
}
