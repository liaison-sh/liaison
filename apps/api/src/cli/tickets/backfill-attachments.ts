// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `tickets backfill-attachments` — re-fetch Gmail attachments for inbound
 * ticket messages ingested before the sync layer hydrated provider-id
 * attachments (they were silently dropped: parse recorded the attachment but
 * nothing downloaded the bytes, so no `kernel.files` row was ever created).
 *
 * For every inbound message in the window that has an `external_message_id`
 * and no `kernel.files` children, look the message up in each of the org's
 * connected tickets Gmail mailboxes by `rfc822msgid:`, hydrate its attachment
 * bytes via the Gmail attachments API, and persist them through the same
 * `persistInboundAttachments` path live sync uses (same size caps, same
 * storage layout, same CID handling). Idempotent: messages that already have
 * files are excluded by the NOT EXISTS, and re-running on a failure resumes
 * where it left off.
 *
 *   liaison tickets backfill-attachments [--org <slug>] [--days <n=90>] [--dry-run]
 *
 * I/O discipline (matches `tickets import`): machine-readable JSON report on
 * STDOUT (written by the dispatcher), human progress on STDERR.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { persistInboundAttachments } from "~/apps/tickets/inbound"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { gmailFetchByRfc822MessageId, type SyncCtx } from "~/apps/tickets/sync"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { getTokenForConnection } from "~/modules/apps/connections/service"

const log = rootLogger.child({ module: "cli-tickets-backfill-attachments" })

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export interface BackfillAttachmentsResult {
  exitCode: number
  report: unknown
  message?: string
}

type CandidateMessage = {
  id: string
  ticket_id: string
  external_message_id: string
}

/** Minimal SyncCtx for the Gmail read path — only fetch + getAccessToken are
 *  exercised by `gmailFetchByRfc822MessageId`; the sync-job affordances are
 *  inert stubs. */
function buildGmailReadCtx(orgId: string, actorUserId: string): SyncCtx {
  return {
    fetch: globalThis.fetch,
    getAccessToken: async (conn, email) =>
      withPrivilegedDb(orgId, "tickets-backfill-token", (db) =>
        getTokenForConnection(db, orgId, actorUserId, "tickets", conn, email, {
          actorType: "system",
        }),
      ),
    enqueueJob: async () => {},
    imapFetch: async () => ({ messages: [] }),
    loadAccount: async () => {
      throw new Error("not used by backfill")
    },
    saveAccountMetadata: async () => {},
    loadInboxByAccountId: async () => null,
  }
}

export async function runTicketsBackfillAttachments(opts: {
  orgSlug?: string
  days?: number
  dryRun?: boolean
}): Promise<BackfillAttachmentsResult> {
  const resolved = await resolveOrgId(
    opts.orgSlug,
    "multiple orgs exist — pass --org <slug> to tickets backfill-attachments",
  )
  if (!resolved.ok)
    return { exitCode: 1, report: { error: resolved.message }, message: resolved.message }
  const orgId = resolved.orgId
  const days = opts.days ?? 90

  const { accounts, actorUserId, candidates } = await withPrivilegedDb(
    orgId,
    "tickets-backfill-scan",
    async (tx) => {
      const accounts = extractRows<{ identifier: string }>(
        await tx.execute(drizzleSql`
          SELECT identifier FROM ${kernelRel("connected_accounts")}
          WHERE org_id = ${orgId}::uuid AND app_name = 'tickets'
            AND connection_name = 'gmail' AND status = 'active'
          ORDER BY created_at ASC
        `),
      )
      const users = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${kernelRel("users")}
          WHERE org_id = ${orgId} AND status = 'active'
          ORDER BY created_at ASC LIMIT 1
        `),
      )
      const candidates = extractRows<CandidateMessage>(
        await tx.execute(drizzleSql`
          SELECT m.id, m.ticket_id, m.external_message_id
          FROM ${ticketsRel("messages")} m
          WHERE m.org_id = ${orgId}::uuid
            AND m.kind = 'inbound'
            AND m.external_message_id IS NOT NULL
            AND m.created_at > now() - make_interval(days => ${days})
            AND NOT EXISTS (
              SELECT 1 FROM ${kernelRel("files")} f
              WHERE f.org_id = ${orgId}::uuid AND f.app = 'tickets'
                AND f.entity_type = 'message' AND f.entity_id = m.id::text
            )
          ORDER BY m.created_at ASC
        `),
      )
      return { accounts, actorUserId: users[0]?.id ?? NIL_UUID, candidates }
    },
  )

  if (accounts.length === 0) {
    const message = "no active tickets Gmail connected account for this org"
    return { exitCode: 1, report: { error: message }, message }
  }

  const ctx = buildGmailReadCtx(orgId, actorUserId)
  let matched = 0
  let filesPersisted = 0
  let skippedNoGmailMatch = 0
  let skippedNoAttachments = 0
  const failed: Array<{ messageId: string; error: string }> = []

  for (const msg of candidates) {
    try {
      let parsed: Awaited<ReturnType<typeof gmailFetchByRfc822MessageId>> = null
      for (const account of accounts) {
        parsed = await gmailFetchByRfc822MessageId(ctx, account.identifier, msg.external_message_id)
        if (parsed) break
      }
      if (!parsed) {
        skippedNoGmailMatch += 1
        continue
      }
      const withBytes = (parsed.attachments ?? []).filter((a) => a.bytesBase64)
      if (withBytes.length === 0) {
        skippedNoAttachments += 1
        continue
      }
      matched += 1
      if (opts.dryRun) {
        filesPersisted += withBytes.length
        log.info(
          { messageId: msg.id, ticketId: msg.ticket_id, attachments: withBytes.length },
          "dry-run: would persist attachments",
        )
        continue
      }
      await withPrivilegedDb(orgId, "tickets-backfill-persist", async (db) => {
        await persistInboundAttachments(
          { db: db as never, orgId },
          { messageId: msg.id, attachments: parsed.attachments ?? [] },
        )
      })
      filesPersisted += withBytes.length
      log.info(
        { messageId: msg.id, ticketId: msg.ticket_id, attachments: withBytes.length },
        "backfilled attachments",
      )
    } catch (err) {
      failed.push({ messageId: msg.id, error: (err as Error).message })
      log.error({ err, messageId: msg.id }, "backfill failed for message")
    }
  }

  return {
    exitCode: failed.length > 0 ? 1 : 0,
    report: {
      dryRun: Boolean(opts.dryRun),
      scanned: candidates.length,
      matched,
      filesPersisted,
      skippedNoGmailMatch,
      skippedNoAttachments,
      failed,
    },
  }
}
