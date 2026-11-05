// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting a mailbox deletes what Liaison imported from it.
//
// A mail account's content exists in Liaison only because the connection let
// Liaison read it: the conversations, messages and drafts synced from the
// provider, the attachments stored with them and their search documents. When
// the kernel connection is disconnected (the `connected_account:disconnect`
// event, which also deleted the tokens and revoked the grant), all of it goes.
// The account row stays, marked disconnected, so the mailbox's settings and
// access grants survive a reconnect; a reconnect re-imports from the provider.
//
// Kept: tickets converted from a conversation (a ticket is a team record with its
// own copy of the messages; the link back to the conversation is nulled by its
// foreign key), and contacts created from senders (CRM records).
//
// A Google re-authorization replaces the connection with a new active one for
// the same address: the content then stays (same as Calendar).

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { imapVerifyLogin } from "~/modules/apps/sandbox/imap-bridge"
import { destroyMailboxServerKeys } from "~/modules/mailbox-crypto/managed-keys"

function mailRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_mail")}.${name}`)
}

const K = drizzleSql.raw(schemaRef("kernel"))

export interface MailAccountPurgeResult {
  /** True when an active connection holds the address again: nothing deleted. */
  kept: boolean
  conversations: number
  messages: number
  drafts: number
  files: number
}

const NOTHING: MailAccountPurgeResult = {
  kept: false,
  conversations: 0,
  messages: 0,
  drafts: 0,
  files: 0,
}

/**
 * Delete one mail account's imported content inside `tx`. Returns what went,
 * plus the ids the caller removes from the search index once `tx` commits.
 */
export async function purgeMailAccountContent(
  tx: Pick<PrivilegedDb, "execute" | "queueEvent">,
  orgId: string,
  accountId: string,
  /** `force`: the row is being removed, so its content goes whoever holds the address. */
  opts: { force?: boolean } = {},
): Promise<MailAccountPurgeResult & { conversationIds: string[]; messageIds: string[] }> {
  const empty = { ...NOTHING, conversationIds: [], messageIds: [] }
  const account = extractRows<{
    email_address: string
    owner_type: string
    owner_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT email_address, owner_type, owner_id::text AS owner_id FROM ${mailRel("accounts")}
      WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
      FOR UPDATE
    `),
  )[0]
  if (!account) return empty

  // Re-authorization: a new active mail connection for the same address AND the
  // same owner. Another owner's connection of the address (an admin taking a
  // member's account over for the organization) does not keep this row's content:
  // that connection gets a mailbox of its own.
  const held = opts.force
    ? []
    : extractRows<{ held: number }>(
        await tx.execute(drizzleSql`
          SELECT 1 AS held FROM ${K}.connected_accounts
          WHERE org_id = ${orgId}::uuid AND app_name = 'mail' AND status = 'active'
            AND lower(identifier) = lower(${account.email_address})
            AND owner_type = ${account.owner_type}
            AND owner_id IS NOT DISTINCT FROM ${account.owner_id}::uuid
          LIMIT 1
        `),
      )
  if (held.length > 0) return { ...empty, kept: true }

  // Disconnected FIRST, in this transaction: a sync page write takes the account
  // row FOR SHARE and refuses a disconnected account (page-write.ts), so a sync
  // racing this purge either committed before the lock (its rows are deleted
  // below) or waits for this commit and then writes nothing. The provider cursor
  // goes too: a reconnect re-imports from scratch instead of resuming past mail
  // that is no longer here.
  await tx.execute(drizzleSql`
    UPDATE ${mailRel("accounts")}
    SET sync_status = 'disconnected', disconnected_at = COALESCE(disconnected_at, now()),
        sync_state = NULL, last_sync_error = NULL, updated_at = now()
    WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
  `)

  const messageIds = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${mailRel("messages")}
      WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
    `),
  ).map((r) => r.id)
  const draftIds = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${mailRel("drafts")}
      WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
    `),
  ).map((r) => r.id)

  // Attachments (and files staged on drafts): the rows go here, each with the
  // `kernel.file.delete` event whose consumer deletes the stored object once
  // this transaction commits.
  const fileRows =
    messageIds.length + draftIds.length === 0
      ? []
      : extractRows<{
          id: string
          entity_type: string
          entity_id: string
          storage_key: string
          thumbnail_key: string | null
        }>(
          await tx.execute(drizzleSql`
            DELETE FROM ${K}.files
            WHERE org_id = ${orgId}::uuid AND app = 'mail'
              AND (
                (entity_type = 'message' AND entity_id = ANY(${`{${messageIds.join(",")}}`}::text[]))
                OR (entity_type = 'draft' AND entity_id = ANY(${`{${draftIds.join(",")}}`}::text[]))
              )
            RETURNING id::text AS id, entity_type, entity_id, storage_key, thumbnail_key
          `),
        )
  for (const f of fileRows) {
    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: f.id,
      orgId,
      actorId: null,
      actorType: "system",
      timestamp: new Date().toISOString(),
      data: {
        id: f.id,
        app: "mail",
        entityType: f.entity_type,
        entityId: f.entity_id,
        storageKey: f.storage_key,
        thumbnailKey: f.thumbnail_key,
      },
    })
  }

  const drafts = draftIds.length
  await tx.execute(drizzleSql`
    DELETE FROM ${mailRel("drafts")}
    WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
  `)
  await tx.execute(drizzleSql`
    DELETE FROM ${mailRel("messages")}
    WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
  `)
  const conversationIds = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      DELETE FROM ${mailRel("conversations")}
      WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
      RETURNING id::text AS id
    `),
  ).map((r) => r.id)

  return {
    kept: false,
    conversations: conversationIds.length,
    messages: messageIds.length,
    drafts,
    files: fileRows.length,
    conversationIds,
    messageIds,
  }
}

/** Remove the purged conversations and their message fragments from search. */
async function removeFromSearch(
  orgId: string,
  conversationIds: string[],
  messageIds: string[],
): Promise<void> {
  if (conversationIds.length === 0 && messageIds.length === 0) return
  const [{ recordLiveIndex }, { entityLiveIndexItem }, { mailFragmentRemovalItem }] =
    await Promise.all([
      import("~/modules/search/live-index-queue"),
      import("~/modules/search/indexer"),
      import("~/apps/mail/search-enrichment"),
    ])
  const items = [
    ...conversationIds.map((entityId) =>
      entityLiveIndexItem({
        action: "delete",
        orgId,
        app: "mail",
        entityType: "conversation",
        entityId,
      }),
    ),
    ...messageIds.map((id) => mailFragmentRemovalItem(orgId, id)),
  ]
  for (let i = 0; i < items.length; i += 1000) {
    await recordLiveIndex(items.slice(i, i + 1000))
  }
}

/**
 * Delete a disconnected mail account's imported content, then its search
 * documents. The database side is one transaction; the search side runs after
 * it commits and is best effort (a reindex rebuilds from the rows, which are gone).
 */
export async function purgeDisconnectedMailAccount(
  orgId: string,
  accountId: string,
): Promise<MailAccountPurgeResult> {
  const result = await withPrivilegedDb(orgId, "mail:purge-disconnected-account", (tx) =>
    purgeMailAccountContent(tx, orgId, accountId),
  )
  if (result.kept) {
    log.info({ orgId, accountId }, "mail disconnect: address reconnected, content kept")
    return result
  }
  try {
    await removeFromSearch(orgId, result.conversationIds, result.messageIds)
  } catch (err) {
    log.warn(
      { orgId, accountId, err: (err as Error).message },
      "mail disconnect: could not queue the search removals; a reindex drops them",
    )
  }
  log.info(
    {
      orgId,
      accountId,
      conversations: result.conversations,
      messages: result.messages,
      drafts: result.drafts,
      files: result.files,
    },
    "mail disconnect: imported content deleted",
  )
  const { conversationIds: _c, messageIds: _m, ...summary } = result
  return summary
}

/** What became of another owner's mailbox row a connect met (releaseForeignMailAccount). */
export type ForeignMailAccountOutcome =
  /** The row and its content are gone: the connect gets a mailbox of its own. */
  | { outcome: "released"; conversations: number; messages: number }
  /** The row's own connection is still active: the connect is refused. */
  | { outcome: "held"; heldBy: "org" | "user" }
  /** The connect did not prove it controls the account (an IMAP login the
   *  server refused, or the connection is gone): the row is left alone. */
  | { outcome: "unproven" }

/** Test seam: an IMAP sign-in check that answers without a mail server. */
let imapLoginCheck: ((credentials: Record<string, string>) => Promise<void>) | null = null
export const ForeignMailAccountTestAccess = {
  setImapLoginCheck(fn: typeof imapLoginCheck): void {
    imapLoginCheck = fn
  },
}

/**
 * Whether a new mail connection proved it controls its account: an OAuth grant
 * is a sign-in at the provider as that account; a credentials save checks no
 * password, so its IMAP login is tried now.
 */
async function connectionProvesControl(orgId: string, connectionId: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "mail:foreign-account-connection", async (tx) =>
    extractRows<{
      provider_type: string
      status: string
      connection_name: string
      identifier: string
      owner_type: string
      created_by: string
    }>(
      await tx.execute(drizzleSql`
        SELECT provider_type, status, connection_name, identifier, owner_type,
               created_by::text AS created_by
        FROM ${K}.connected_accounts
        WHERE org_id = ${orgId}::uuid AND id = ${connectionId}::uuid AND app_name = 'mail'
      `),
    ),
  )
  const connection = rows[0]
  if (connection?.status !== "active") return false
  if (connection.provider_type !== "credentials") return true
  // The one active account of this identifier (unique per connection), read as the system.
  const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
  const credentials = await withPrivilegedDb(orgId, "mail:foreign-account-credentials", (tx) =>
    getCredentialsForConnection(
      tx,
      orgId,
      connection.created_by,
      "mail",
      connection.connection_name,
      connection.identifier,
      { actorType: "system", ownerType: connection.owner_type === "org" ? "org" : "user" },
    ),
  ).catch(() => null)
  if (!credentials) return false
  try {
    if (imapLoginCheck) await imapLoginCheck(credentials)
    else
      await imapVerifyLogin({
        host: credentials.imapHost ?? "",
        port: Number(credentials.imapPort),
        username: credentials.username ?? "",
        password: credentials.password ?? "",
      })
    return true
  } catch (err) {
    log.info(
      { orgId, connectionId, err: (err as Error).message },
      "mail connect: the IMAP login failed, so it cannot replace another owner's mailbox",
    )
    return false
  }
}

/**
 * Another owner's mailbox row holds the address a new connection is for (one
 * row per address). It is released, its imported content and the row itself
 * deleted, only when its own connection is no longer active (whatever the row's
 * sync status says: a takeover retires the connection before any disconnect
 * handler ran) and the new connection proved it controls the account. Content
 * is purged even when an older disconnect left it behind, so nothing is
 * orphaned. Otherwise the row is left as it is.
 */
export async function releaseForeignMailAccount(
  orgId: string,
  accountId: string,
  connectionId: string,
): Promise<ForeignMailAccountOutcome> {
  const held = await withPrivilegedDb(orgId, "mail:foreign-account-held", async (tx) =>
    foreignRowHeld(tx, orgId, accountId, connectionId),
  )
  if (held) return { outcome: "held", heldBy: held }
  if (!(await connectionProvesControl(orgId, connectionId))) return { outcome: "unproven" }

  const result = await withPrivilegedDb(orgId, "mail:release-foreign-account", async (tx) => {
    // Checked again under the row lock the purge takes: a reconnect may have won.
    const purged = await purgeMailAccountContent(tx, orgId, accountId, { force: true })
    const stillHeld = await foreignRowHeld(tx, orgId, accountId, connectionId)
    if (stillHeld) throw new ForeignRowHeldError(stillHeld)
    await tx.execute(drizzleSql`
      DELETE FROM ${mailRel("accounts")} WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
    `)
    // The row is gone: a server-managed mailbox's data key goes with it.
    await destroyMailboxServerKeys(tx, orgId, accountId)
    return purged
  }).catch((err) => {
    if (err instanceof ForeignRowHeldError) return err
    throw err
  })
  if (result instanceof ForeignRowHeldError) return { outcome: "held", heldBy: result.heldBy }
  try {
    await removeFromSearch(orgId, result.conversationIds, result.messageIds)
  } catch (err) {
    log.warn(
      { orgId, accountId, err: (err as Error).message },
      "mail connect: could not queue the search removals; a reindex drops them",
    )
  }
  log.info(
    { orgId, accountId, conversations: result.conversations, messages: result.messages },
    "mail connect: another owner's disconnected mailbox released",
  )
  return { outcome: "released", conversations: result.conversations, messages: result.messages }
}

class ForeignRowHeldError extends Error {
  constructor(readonly heldBy: "org" | "user") {
    super("the mailbox row's own connection is active")
  }
}

/** The owner of the row's own connection while it is active (and not this connect's), else null. */
async function foreignRowHeld(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  accountId: string,
  connectionId: string,
): Promise<"org" | "user" | null> {
  const rows = extractRows<{ owner_type: string }>(
    await tx.execute(drizzleSql`
      SELECT ca.owner_type FROM ${mailRel("accounts")} a
      JOIN ${K}.connected_accounts ca
        ON ca.org_id = a.org_id AND ca.id = a.connected_account_id
      WHERE a.org_id = ${orgId}::uuid AND a.id = ${accountId}::uuid
        AND ca.status = 'active' AND ca.id <> ${connectionId}::uuid
    `),
  )
  if (rows.length === 0) return null
  return rows[0]?.owner_type === "org" ? "org" : "user"
}
