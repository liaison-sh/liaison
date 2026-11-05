// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Your mailbox is not syncing until you set up encryption": the attention item
// a personal mailbox raises while it cannot receive mail.
//
// A personal mailbox that is not `ready` fetches nothing (Invariant P: its mail
// may only be stored sealed, and there is no key to seal to). Its sync jobs are
// silent about it on purpose (the stranded-sync sweep skips it, the tick logs at
// debug), so without this item the owner's mailbox simply never fills and
// nobody says why (prod 2026-09-30: connected six days, zero conversations).
//
// Why a PROVIDER and not an event: the item is derived from the account row on
// every feed read, so it exists exactly while the condition holds and vanishes
// the moment the owner enrolls. There is one per mailbox, never one per sync
// tick, and the attention state materializer routes a notification only on its
// first sighting (a known source key is never re-sent), so the owner is told
// once, not every five minutes.
//
// Only the OWNER sees it: the query keys on `owner_id = <the reader>`, and the
// item carries the mailbox's own address and state, nothing of its content.

import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appSettingsPath } from "~/modules/apps/settings-paths"

/** The states in which a personal mailbox fetches no mail, and what to do. */
const NOT_SYNCING_STATES = ["pending_enrollment", "blocked", "paused"] as const
type NotSyncingState = (typeof NOT_SYNCING_STATES)[number]

function summaryFor(email: string, state: NotSyncingState): string {
  if (state === "blocked") {
    return `Mailbox ${email} stopped syncing: its encryption keys cannot be used. Open Settings > Mail to reset them.`
  }
  return `Mailbox ${email} is not syncing yet: set up mailbox encryption in Settings > Mail to start receiving mail.`
}

/**
 * Kernel attention provider (registered as `kernel.mailbox_enrollment`). Items
 * for the reader's own personal mailboxes that cannot sync.
 */
export async function computeMailboxEnrollmentAttentionItems(
  _tx: RlsClient,
  orgId: string,
  userId: string,
): Promise<AttentionItem[]> {
  if (!userId) return []
  const mail = schemaRef("app_mail")
  const rows = await withPrivilegedDb(
    orgId,
    "mailbox-enrollment-attention",
    async (tx: PrivilegedDb) => {
      // The mail app is optional: no accounts table, no mailbox, no item.
      const [reg] = extractRows<{ t: string | null }>(
        await tx.execute(drizzleSql`SELECT to_regclass(${`${mail}.accounts`})::text AS t`),
      )
      if (!reg?.t) return []
      return extractRows<{
        id: string
        connected_account_id: string
        email_address: string
        encryption_state: NotSyncingState
        created_at: string
      }>(
        await tx.execute(drizzleSql`
        SELECT id::text AS id, connected_account_id::text AS connected_account_id, email_address, encryption_state, created_at::text AS created_at
          FROM ${drizzleSql.raw(`"${mail}"`)}.accounts
         WHERE org_id = ${orgId}::uuid
           AND owner_type = 'user'
           AND owner_id = ${userId}::uuid
           AND disconnected_at IS NULL
           AND encryption_state IN (${drizzleSql.join(
             NOT_SYNCING_STATES.map((s) => drizzleSql`${s}`),
             drizzleSql.raw(", "),
           )})
         ORDER BY created_at`),
      )
    },
  )

  return rows.map((row) => ({
    id: `kernel:mailbox_enrollment:${row.id}`,
    app: "kernel",
    // Addressed as the mailbox's connection, so the web's existing
    // `kernel/connected_account` opener lands it in Settings, on the route
    // below, with no per-feature client code.
    entity: "connected_account",
    entityId: row.connected_account_id,
    kind: "admin_action",
    summary: summaryFor(row.email_address, row.encryption_state),
    // Below the urgent-email threshold (70): the owner is told in the feed and
    // by the materializer's one-time notification, not paged.
    urgency: 60,
    occurredAt: new Date(row.created_at).toISOString(),
    action: { type: "open_entity", tabType: "kernel:settings", entityId: row.connected_account_id },
    metadata: {
      settingsRoute: appSettingsPath(orgId, "mail"),
      mailAccountId: row.id,
      encryptionState: row.encryption_state,
    },
  }))
}
