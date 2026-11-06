// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Choosing the shared drives an ORGANIZATION's Drive connection shares
 * (drive-scope.ts): one service behind every surface that lists or changes
 * them — the Settings card (routes in shared-drives-routes.ts), the agent's
 * `google-drive__shared_drives` tool (bridge.ts) and `liaison config apply`
 * (`apps[].connection.sharedDrives`, cli/provisioners/drive-shared-drives.ts).
 *
 * - Listing asks Google (drives.list) for the shared drives the CONNECTING
 *   account is a member of: a drive the account is not a member of can't be
 *   chosen (Liaison could not read it anyway). Every Liaison member who may use
 *   the org connection sees the files of a chosen drive.
 * - Choosing replaces the set. Only an admin of the connection
 *   (`connectionAdminScope`, `google-drive:accounts:admin` by default) lists or
 *   chooses. A choice is checked against drives.list, by id or by name.
 * - An org connection with no drive chosen reads nothing; admins get an
 *   attention item until they choose ("pick the shared drives").
 */
import { and, eq } from "drizzle-orm"
import { makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import {
  MAX_SHARED_DRIVES,
  type SharedDrive,
  sharedDrivesOf,
} from "~/apps/google-drive/drive-scope"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { appsLogger as log } from "~/lib/logger"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope } from "~/modules/permissions/permissions"

const DRIVE_APP = "google-drive"
const DRIVE_CONNECTION = "drive"

export class SharedDrivesError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "not_a_member" | "too_many",
    message: string,
  ) {
    super(message)
    this.name = "SharedDrivesError"
  }
}

export interface SharedDrivesCaller {
  orgId: string
  userId: string
  scopes: readonly string[]
}

export interface OrgDriveAccountView {
  id: string
  identifier: string
  /** The shared drives this connection shares with the organization. */
  sharedDrives: SharedDrive[]
  /** No shared drive chosen yet: the connection reads nothing until an admin picks. */
  needsSharedDrives: boolean
}

export interface SharedDrivesState {
  /** The caller may list and choose the shared drives. */
  canManage: boolean
  accounts: OrgDriveAccountView[]
}

type OrgAccountRow = { id: string; identifier: string; metadata: Record<string, unknown> | null }

function mayManage(caller: SharedDrivesCaller): boolean {
  return hasScope(connectionAdminScope(caller.orgId, DRIVE_APP, DRIVE_CONNECTION), [
    ...caller.scopes,
  ])
}

function requireManage(caller: SharedDrivesCaller): void {
  if (!mayManage(caller)) {
    throw new SharedDrivesError(
      "forbidden",
      `Choosing the organization's shared drives needs ${connectionAdminScope(caller.orgId, DRIVE_APP, DRIVE_CONNECTION)}`,
    )
  }
}

/** The organization's active Drive connections (org-owned only). */
async function orgDriveAccounts(orgId: string): Promise<OrgAccountRow[]> {
  return withPrivilegedDb(orgId, "drive-shared-drives-accounts", (tx) =>
    tx
      .select({
        id: connectedAccounts.id,
        identifier: connectedAccounts.identifier,
        metadata: connectedAccounts.metadata,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, DRIVE_APP),
          eq(connectedAccounts.connectionName, DRIVE_CONNECTION),
          eq(connectedAccounts.ownerType, "org"),
          eq(connectedAccounts.status, "active"),
        ),
      ),
  )
}

function viewOf(row: OrgAccountRow): OrgDriveAccountView {
  const sharedDrives = sharedDrivesOf(row.metadata)
  return {
    id: row.id,
    identifier: row.identifier,
    sharedDrives,
    needsSharedDrives: sharedDrives.length === 0,
  }
}

/** Seeing the organization's Drive connections takes the app's read scope. */
const DRIVE_READ_SCOPE = "google-drive:accounts:read"

/**
 * The organization's Drive connections and the shared drives each shares.
 * Refused without the app's read scope: the Google addresses the organization
 * connected are not every member's to see.
 */
export async function sharedDrivesState(caller: SharedDrivesCaller): Promise<SharedDrivesState> {
  if (!mayManage(caller) && !hasScope(DRIVE_READ_SCOPE, [...caller.scopes])) {
    throw new SharedDrivesError(
      "forbidden",
      `Seeing the organization's Drive connections needs ${DRIVE_READ_SCOPE}`,
    )
  }
  const rows = await orgDriveAccounts(caller.orgId)
  return { canManage: mayManage(caller), accounts: rows.map(viewOf) }
}

/**
 * The org account a call is about: by id, by its Google address, or the only
 * one there is. Several org accounts and no pick: refused by name.
 */
async function orgAccount(
  caller: SharedDrivesCaller,
  pick: { accountId?: string; identifier?: string },
): Promise<OrgAccountRow> {
  const rows = await orgDriveAccounts(caller.orgId)
  const found = pick.accountId
    ? rows.find((r) => r.id === pick.accountId)
    : pick.identifier
      ? rows.find((r) => r.identifier.toLowerCase() === pick.identifier?.toLowerCase())
      : rows.length === 1
        ? rows[0]
        : undefined
  if (found) return found
  if (rows.length === 0) {
    throw new SharedDrivesError(
      "not_found",
      "This organization has no Google Drive connection of its own. Connect Drive for the organization first (Settings > Connectors > Google Drive).",
    )
  }
  throw new SharedDrivesError(
    "not_found",
    pick.accountId || pick.identifier
      ? "No organization Drive connection matches that account"
      : `This organization has several Drive connections (${rows.map((r) => r.identifier).join(", ")}): say which account`,
  )
}

/** The shared drives the org account's Google account is a member of (drives.list). */
async function memberDrives(
  caller: SharedDrivesCaller,
  row: OrgAccountRow,
): Promise<SharedDrive[]> {
  const { resolveDriveAccess } = await import("~/apps/google-drive/drive-access")
  const fetchers = makeDriveFetchers(() =>
    withPrivilegedDb(caller.orgId, "drive-shared-drives-token", (tx) =>
      resolveDriveAccess(tx, caller.orgId, caller.userId, {
        identifier: row.identifier,
        actorType: "system",
        ownerType: "org",
      }),
    ),
  )
  return fetchers.listSharedDrives()
}

export interface AvailableSharedDrives {
  account: OrgDriveAccountView
  /** The shared drives the connecting account is a member of, each marked chosen or not. */
  available: Array<SharedDrive & { chosen: boolean }>
}

/** What an admin can choose from for one org Drive connection. */
export async function availableSharedDrives(
  caller: SharedDrivesCaller,
  pick: { accountId?: string; identifier?: string },
): Promise<AvailableSharedDrives> {
  requireManage(caller)
  const row = await orgAccount(caller, pick)
  const chosen = new Set(sharedDrivesOf(row.metadata).map((d) => d.id))
  const drives = await memberDrives(caller, row)
  return {
    account: viewOf(row),
    available: drives.map((d) => ({ ...d, chosen: chosen.has(d.id) })),
  }
}

/**
 * Replace the shared drives an org Drive connection shares. `drives` names
 * each by id or by name (case-insensitive); each must be a shared drive the
 * connecting account is a member of. An empty list shares none (reads stop).
 */
export async function chooseSharedDrives(
  caller: SharedDrivesCaller,
  pick: { accountId?: string; identifier?: string },
  drives: readonly string[],
): Promise<{ account: OrgDriveAccountView; changed: boolean }> {
  requireManage(caller)
  if (drives.length > MAX_SHARED_DRIVES) {
    throw new SharedDrivesError("too_many", `At most ${MAX_SHARED_DRIVES} shared drives`)
  }
  const row = await orgAccount(caller, pick)
  const member = drives.length > 0 ? await memberDrives(caller, row) : []
  const chosen: SharedDrive[] = []
  const unknown: string[] = []
  for (const wanted of drives) {
    const w = wanted.trim()
    const match =
      member.find((d) => d.id === w) ?? member.find((d) => d.name.toLowerCase() === w.toLowerCase())
    if (!match) unknown.push(w)
    else if (!chosen.some((d) => d.id === match.id)) chosen.push(match)
  }
  if (unknown.length > 0) {
    throw new SharedDrivesError(
      "not_a_member",
      `${row.identifier} is not a member of: ${unknown.join(", ")}. Add that Google account to each shared drive (any role) or connect with an account that is a member. Shared drives it can see: ${member.map((d) => d.name).join(", ") || "none"}.`,
    )
  }
  const before = sharedDrivesOf(row.metadata)
  const changed = before.length !== chosen.length || before.some((d, i) => d.id !== chosen[i]?.id)
  if (changed) {
    // A change to what the whole organization reads: audited with before and after.
    await withPrivilegedDb(caller.orgId, "drive-shared-drives-save", async (tx) => {
      await tx
        .update(connectedAccounts)
        .set({ metadata: { ...(row.metadata ?? {}), sharedDrives: chosen }, updatedAt: new Date() })
        .where(and(eq(connectedAccounts.id, row.id), eq(connectedAccounts.orgId, caller.orgId)))
      await writeAuditLog(tx, {
        orgId: caller.orgId,
        actorId: caller.userId,
        actorType: "user",
        app: DRIVE_APP,
        entityType: "connected_account",
        entityId: row.id,
        action: "google-drive.shared_drives.changed",
        metadata: {
          identifier: row.identifier,
          before: before.map((d) => d.id),
          after: chosen.map((d) => d.id),
        },
      })
    })
    log.info(
      {
        orgId: caller.orgId,
        actorId: caller.userId,
        accountId: row.id,
        sharedDrives: chosen.map((d) => d.id),
      },
      "google-drive: organization connection's shared drives changed",
    )
    // What its folders already hold is read again against the new choice:
    // hidden now, synced again at the next tick (org-drive-content.ts).
    const { onOrgSharedDrivesChanged } = await import("~/apps/google-drive/org-drive-content")
    await onOrgSharedDrivesChanged(caller.orgId, row.identifier)
  }
  return {
    account: viewOf({ ...row, metadata: { ...(row.metadata ?? {}), sharedDrives: chosen } }),
    changed,
  }
}
