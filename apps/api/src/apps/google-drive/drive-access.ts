// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Resolve a Drive connection's token AND its read scope (drive-scope.ts) from
 * one connection lookup. Every Drive read path builds its fetchers
 * (`makeDriveFetchers`, drive-rest.ts) from this, so the account that answered
 * the lookup is the account whose scope is enforced.
 */
import { type DriveAccess, driveScopeOf } from "~/apps/google-drive/drive-scope"
import type { PrivilegedDb, RlsClient } from "~/db"
import { NoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"

export const DRIVE_APP_NAME = "google-drive"
export const DRIVE_CONNECTION_NAME = "drive"

export interface ResolvedDriveAccess extends DriveAccess {
  accountId: string
  identifier: string
  ownerType: "org" | "user"
}

/**
 * Whose Drive row a SOURCE reads from, when one Google account holds both an
 * organization row and a member's personal row (the manifest's
 * `orgAndPersonalCoexist`): an organization source (no owner) reads through
 * the org row, a member's personal source through that member's own row; each
 * falls back to the other kind only when its own kind is not connected (a
 * member's personal folder picked from the org's shared drives, an org folder
 * added from an admin's own Drive before the org was connected). Never another
 * member's personal row.
 */
export type DriveSourceOwner = { kind: "org"; creatorId: string } | { kind: "user"; userId: string }

/** The owner kind of a synced source (no owner: the organization's). */
export function driveSourceOwnerOf(source: {
  ownerUserId: string | null
  createdBy: string
}): DriveSourceOwner {
  return source.ownerUserId
    ? { kind: "user", userId: source.ownerUserId }
    : { kind: "org", creatorId: source.createdBy }
}

export async function resolveDriveAccess(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  opts?: {
    identifier?: string
    actorType?: "user" | "system"
    ownerType?: "org" | "user"
    /** Only this exact account (a picker ticket's). */
    accountId?: string
    /** The source the read is for (see DriveSourceOwner). */
    sourceOwner?: DriveSourceOwner
  },
): Promise<ResolvedDriveAccess> {
  const { resolveConnectionAccount } = await import("~/modules/apps/connections/service")
  const lookup = (owner?: { ownerType: "org" | "user"; ownerId?: string }) =>
    resolveConnectionAccount(
      tx,
      orgId,
      userId,
      DRIVE_APP_NAME,
      DRIVE_CONNECTION_NAME,
      opts?.identifier,
      {
        ...(opts?.actorType ? { actorType: opts.actorType } : {}),
        ...(opts?.ownerType ? { ownerType: opts.ownerType } : {}),
        ...(opts?.accountId ? { accountId: opts.accountId } : {}),
        ...(owner ?? {}),
      },
    )
  let account: Awaited<ReturnType<typeof lookup>> | null = null
  const source = opts?.sourceOwner
  if (!source) {
    account = await lookup()
  } else {
    const orgRow = { ownerType: "org" as const }
    const userRow = {
      ownerType: "user" as const,
      ownerId: source.kind === "org" ? source.creatorId : source.userId,
    }
    for (const owner of source.kind === "org" ? [orgRow, userRow] : [userRow, orgRow]) {
      try {
        account = await lookup(owner)
        break
      } catch (err) {
        if (!(err instanceof NoConnectedAccountError)) throw err
      }
    }
    if (!account) throw new NoConnectedAccountError(DRIVE_CONNECTION_NAME)
  }
  return {
    token: account.token,
    readScope: driveScopeOf(account),
    accountId: account.id,
    identifier: account.identifier,
    ownerType: account.ownerType,
  }
}
