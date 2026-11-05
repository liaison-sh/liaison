// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Google Picker side of a Drive connected with `drive.file` only (mode
 * `picked`, drive-mode.ts): what a person sees of their Drive accounts, the
 * short-lived session the browser opens the Picker with, and saving what they
 * picked.
 *
 * Picked items live on the connected account (`metadata.pickedItems`). They reach
 * Knowledge through one synced source per account whose folder ref is
 * `PICKED_ROOT_REF`: its listing is the picked list (adapter.ts), so the existing
 * reconciler syncs them, follows picked folders as far as Drive lets drive.file
 * see, and archives what is no longer picked. Disconnecting the account deletes
 * that source like any Drive folder (disconnect.ts).
 *
 * Who may pick: the owner of a personal Drive account; for an organization's
 * Drive account, a holder of the connection's admin scope. Only a Drive in
 * picked mode has picks: a full-mode account never gets a picker session (its
 * token reads the whole Drive) nor a picked source.
 *
 * The picked source belongs to the account AND its owner: a personal account's
 * source is owned by that person, an organization account's is shared. Another
 * owner connecting the same Google account never syncs into it.
 */
import { and, sql as drizzleSql, eq, or } from "drizzle-orm"
import { createGoogleDriveAdapter } from "~/apps/google-drive/adapter"
import {
  DRIVE_FOLDER_MIME,
  type DriveMode,
  driveModeOf,
  mergePickedItems,
  PICKED_ROOT_REF,
  type PickedItem,
  pickedItemsOf,
  pickerConfigured,
} from "~/apps/google-drive/drive-mode"
import { driveHasText, driveTypeLabel } from "~/apps/google-drive/drive-text"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { createSyncedSource } from "~/apps/knowledge/synced-sources"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { connectedAccounts } from "~/db/schema/kernel"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { hasScope } from "~/modules/permissions/permissions"

export const DRIVE_APP = "google-drive"
export const DRIVE_CONNECTION = "drive"

/** How often the picked-items source re-syncs on its own (seconds). */
const PICKED_SYNC_INTERVAL_SECONDS = 15 * 60

export class DrivePickerError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "not_picked_mode" | "picker_not_configured",
    message: string,
  ) {
    super(message)
    this.name = "DrivePickerError"
  }
}

export interface DriveAccountView {
  id: string
  identifier: string
  ownerType: "user" | "org"
  mode: DriveMode
  picked: PickedItem[]
  /**
   * Picked files with no text form (a PDF, an image): Knowledge does not import
   * them, so the card and the agent say so by name (drive-text.ts).
   */
  notImported: Array<{ id: string; name: string; type: string }>
  sync: {
    sourceId: string
    status: string
    lastSyncAt: string | null
    lastError: string | null
    documents: number
  } | null
}

export interface DrivePickerState {
  /** The deployment set GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER. */
  pickerConfigured: boolean
  accounts: DriveAccountView[]
}

interface Caller {
  orgId: string
  userId: string
  scopes: readonly string[]
}

type AccountRow = {
  id: string
  identifier: string
  ownerType: "user" | "org"
  ownerId: string | null
  metadata: Record<string, unknown> | null
}

function mayManage(row: AccountRow, caller: Caller): boolean {
  if (row.ownerType === "user") return row.ownerId === caller.userId
  return hasScope(connectionAdminScope(caller.orgId, DRIVE_APP, DRIVE_CONNECTION), [
    ...caller.scopes,
  ])
}

async function activeAccounts(caller: Caller): Promise<AccountRow[]> {
  const rows = await withPrivilegedDb(caller.orgId, "drive-picker-accounts", (tx) =>
    tx
      .select({
        id: connectedAccounts.id,
        identifier: connectedAccounts.identifier,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        metadata: connectedAccounts.metadata,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, caller.orgId),
          eq(connectedAccounts.appName, DRIVE_APP),
          eq(connectedAccounts.connectionName, DRIVE_CONNECTION),
          eq(connectedAccounts.status, "active"),
        ),
      ),
  )
  return rows
    .map((r) => ({ ...r, ownerType: r.ownerType === "org" ? ("org" as const) : ("user" as const) }))
    .filter((r) => mayManage(r, caller))
}

/** The owner a picked source of this account has: the person, or none (org). */
function sourceOwnerOf(row: Pick<AccountRow, "ownerType" | "ownerId">): string | null {
  return row.ownerType === "org" ? null : row.ownerId
}

async function pickedSourceOf(
  orgId: string,
  row: Pick<AccountRow, "identifier" | "ownerType" | "ownerId">,
): Promise<DriveAccountView["sync"]> {
  const owner = sourceOwnerOf(row)
  return withPrivilegedDb(orgId, "drive-picker-source", async (tx) => {
    const rows = extractRows<{
      id: string
      last_sync_status: string
      last_sync_at: Date | string | null
      last_error: string | null
      documents: number | string
    }>(
      await tx.execute(drizzleSql`
        SELECT s.id, s.last_sync_status, s.last_sync_at, s.last_error,
          (SELECT count(*) FROM ${knowledgeRel("documents")} d
            WHERE d.synced_source_id = s.id AND d.archived_at IS NULL) AS documents
        FROM ${knowledgeRel("synced_sources")} s
        WHERE s.org_id = ${orgId}::uuid AND s.app_name = ${DRIVE_APP}
          AND s.folder_ref = ${PICKED_ROOT_REF}
          AND lower(s.source_account) = lower(${row.identifier})
          AND ${owner === null ? drizzleSql`s.owner_user_id IS NULL` : drizzleSql`s.owner_user_id = ${owner}::uuid`}
          AND s.archived_at IS NULL
        ORDER BY s.created_at DESC
        LIMIT 1
      `),
    )
    const r = rows[0]
    if (!r) return null
    return {
      sourceId: r.id,
      status: r.last_sync_status,
      lastSyncAt:
        r.last_sync_at instanceof Date ? r.last_sync_at.toISOString() : (r.last_sync_at ?? null),
      lastError: r.last_error,
      documents: Number(r.documents),
    }
  })
}

/** The picked files Knowledge does not import, with the type that keeps them out. */
export function notImportedOf(picked: readonly PickedItem[]): DriveAccountView["notImported"] {
  return picked
    .filter((p) => p.mimeType !== DRIVE_FOLDER_MIME && !driveHasText(p.mimeType))
    .map((p) => ({ id: p.id, name: p.name, type: driveTypeLabel(p.mimeType) }))
}

/** The caller's Drive accounts, with their mode, picked items and sync state. */
export async function drivePickerState(caller: Caller): Promise<DrivePickerState> {
  const accounts: DriveAccountView[] = []
  for (const row of await activeAccounts(caller)) {
    accounts.push({
      id: row.id,
      identifier: row.identifier,
      ownerType: row.ownerType,
      mode: driveModeOf(row.metadata),
      picked: pickedItemsOf(row.metadata),
      notImported: notImportedOf(pickedItemsOf(row.metadata)),
      sync: await pickedSourceOf(caller.orgId, row),
    })
  }
  return { pickerConfigured: pickerConfigured(env), accounts }
}

async function accountFor(caller: Caller, accountId: string): Promise<AccountRow> {
  const row = (await activeAccounts(caller)).find((a) => a.id === accountId)
  if (!row) throw new DrivePickerError("not_found", "No Drive account of yours with this id")
  return row
}

/** The account a picker ticket is for, when the caller may pick on it. */
export async function pickerAccount(
  caller: Caller,
  accountId: string,
): Promise<{ id: string; identifier: string }> {
  if (!pickerConfigured(env)) {
    throw new DrivePickerError(
      "picker_not_configured",
      "The Google Picker is not set up on this server (GOOGLE_PICKER_API_KEY, GOOGLE_CLOUD_PROJECT_NUMBER)",
    )
  }
  const row = await accountFor(caller, accountId)
  requirePickedMode(row)
  return { id: row.id, identifier: row.identifier }
}

function requirePickedMode(row: AccountRow): void {
  if (driveModeOf(row.metadata) !== "picked") {
    throw new DrivePickerError(
      "not_picked_mode",
      "This Drive account reads the whole Drive: there are no files to pick",
    )
  }
}

/** A signed-in person (or a picker ticket made for one): who saves picks. */
export interface PickerActor extends Caller {
  dimensionGrants: Record<string, string[]>
  roles: string[]
}

/** Saves a change of picks under the person's own context and starts the sync. */
export async function savePicks(
  who: PickerActor,
  accountId: string,
  change: { add: PickedItem[]; remove: string[] },
): Promise<{ picked: PickedItem[]; sourceId: string }> {
  const actor = knowledgeActorFromContext({
    orgId: who.orgId,
    userId: who.userId,
    scopes: [...who.scopes],
    dimensionGrants: who.dimensionGrants,
    roles: who.roles,
  })
  const result = await withRlsContext(
    {
      actorType: "user",
      orgId: who.orgId,
      userId: who.userId,
      scopes: [...who.scopes],
      dimensionGrants: who.dimensionGrants,
    },
    (tx) => updatePickedItems(tx, who, actor, accountId, change),
  )
  try {
    await enqueueAppJob(
      "knowledge",
      "sync-source",
      { sourceId: result.sourceId, trigger: "force-on-open", enqueuedBy: who.userId },
      { jobId: `sync:${result.sourceId}` },
    )
  } catch (err) {
    // The scheduled tick syncs it within its interval: the picks are saved.
    log.error(
      { err, orgId: who.orgId, sourceId: result.sourceId },
      "drive picker: sync enqueue failed",
    )
  }
  return result
}

/**
 * Adds and removes picked items on one account, makes sure its picked-items
 * source exists, and returns the source id to sync now.
 */
export async function updatePickedItems(
  /** The request's transaction (createSyncedSource's discipline marker). */
  tx: RlsClient,
  caller: Caller,
  actor: KnowledgeActor,
  accountId: string,
  change: { add: PickedItem[]; remove: string[] },
): Promise<{ picked: PickedItem[]; sourceId: string }> {
  // One save per account at a time, until this transaction ends: two saves
  // never lose each other's change, and two first saves never make two sources.
  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${`drive-picker:${caller.orgId}:${accountId}`}))`,
  )
  // Read after the lock: the picks another save just wrote are in it.
  const row = await accountFor(caller, accountId)
  requirePickedMode(row)
  const picked = mergePickedItems(pickedItemsOf(row.metadata), change.add, change.remove)
  await withPrivilegedDb(caller.orgId, "drive-picker-save", (tx) =>
    tx
      .update(connectedAccounts)
      .set({
        metadata: drizzleSql`coalesce(${connectedAccounts.metadata}, '{}'::jsonb) || ${JSON.stringify({ pickedItems: picked })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connectedAccounts.id, row.id),
          eq(connectedAccounts.orgId, caller.orgId),
          eq(connectedAccounts.status, "active"),
        ),
      ),
  )
  const existing = await pickedSourceOf(caller.orgId, row)
  if (existing) return { picked, sourceId: existing.sourceId }
  const source = await createSyncedSource(
    tx,
    {
      appName: DRIVE_APP,
      folderRef: PICKED_ROOT_REF,
      displayName: `Google Drive: ${row.identifier}`,
      syncIntervalSeconds: PICKED_SYNC_INTERVAL_SECONDS,
      scope: row.ownerType === "org" ? "organization" : "personal",
      ...(row.ownerType === "org" ? { defaultSensitivity: "internal" } : {}),
    },
    actor,
    // The picked root is listed from the list just saved: no Drive call to precheck.
    { adapter: createGoogleDriveAdapter(pickedOnlyDeps(picked)) },
  )
  // The source syncs from THIS account, whichever Drive account is newest.
  await withPrivilegedDb(caller.orgId, "drive-picker-source-account", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")} SET source_account = ${row.identifier}
      WHERE id = ${source.id}::uuid AND org_id = ${caller.orgId}::uuid
    `),
  )
  return { picked, sourceId: source.id }
}

/** Adapter deps that only list the picked root (the precheck). */
function pickedOnlyDeps(picked: PickedItem[]) {
  const refuse = async (): Promise<never> => {
    throw new Error("not available in the picked-items precheck")
  }
  return {
    getToken: refuse,
    fetchDrive: refuse,
    getPickedItems: async () => picked,
  }
}

/**
 * The picked items of the account a synced source syncs from (the sync worker):
 * the active account with that address AND the source's owner (the person for a
 * personal source, the organization for a shared one). None when the account
 * now belongs to someone else: the source then lists nothing and is emptied.
 */
export async function loadPickedItems(
  orgId: string,
  identifier: string,
  sourceOwnerUserId: string | null,
): Promise<PickedItem[]> {
  const rows = await withPrivilegedDb(orgId, "drive-picker-load", (tx) =>
    tx
      .select({ metadata: connectedAccounts.metadata })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, DRIVE_APP),
          eq(connectedAccounts.connectionName, DRIVE_CONNECTION),
          drizzleSql`lower(${connectedAccounts.identifier}) = lower(${identifier})`,
          eq(connectedAccounts.status, "active"),
          sourceOwnerUserId === null
            ? eq(connectedAccounts.ownerType, "org")
            : and(
                eq(connectedAccounts.ownerType, "user"),
                eq(connectedAccounts.ownerId, sourceOwnerUserId),
              ),
        ),
      )
      .limit(1),
  )
  return pickedItemsOf(rows[0]?.metadata)
}

/**
 * What the agent's Drive tools see for one person: whether a Drive they use
 * (their own, or the organization's) is in picked mode, and the items picked on
 * those accounts. Search lists them (tools.ts), since in picked mode they are
 * all Liaison can see besides the files it made.
 */
export async function pickedFilesForUser(
  orgId: string,
  userId: string,
): Promise<{ picked: boolean; items: PickedItem[] }> {
  const rows = await withPrivilegedDb(orgId, "drive-picked-files-for-user", (tx) =>
    tx
      .select({ metadata: connectedAccounts.metadata })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, DRIVE_APP),
          eq(connectedAccounts.connectionName, DRIVE_CONNECTION),
          eq(connectedAccounts.status, "active"),
          or(
            eq(connectedAccounts.ownerType, "org"),
            and(eq(connectedAccounts.ownerType, "user"), eq(connectedAccounts.ownerId, userId)),
          ),
        ),
      ),
  )
  const pickedRows = rows.filter((r) => driveModeOf(r.metadata) === "picked")
  const items = mergePickedItems(
    [],
    pickedRows.flatMap((r) => pickedItemsOf(r.metadata)),
    [],
  )
  return { picked: pickedRows.length > 0, items }
}
