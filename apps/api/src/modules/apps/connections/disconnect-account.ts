// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DISCONNECTING ONE ACCOUNT BY NAME: `liaison disconnect <app>/<connection>
// <account>` and the in-app agent's `kernel__connection_disconnect`.
//
// Who may disconnect what:
//   - an ORGANIZATION connection: whoever holds the connection's admin scope
//     (connections/admin-scope.ts, default `<app>:accounts:admin`); the
//     operator's CLI runs privileged and counts as one;
//   - a PERSONAL connection: its owner. Anybody else only with an explicit
//     force (the CLI's --force), which writes an audit entry naming the
//     owner. The in-app agent never forces: someone else's personal account
//     is the CLI's, or its owner's, to remove.
//
// What goes is said before it goes (the app's own "Disconnect" warning: what
// Liaison imported from the account is deleted, the provider keeps the
// original), and the disconnect itself is the Settings button's: the app's
// before-disconnect cleanup, the connection's tokens cleared, the grant
// revoked at the provider.

import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts, users } from "~/db/schema/kernel"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { runBeforeDisconnect } from "~/modules/apps/connections/before-disconnect"
import { runConnectionTeardown } from "~/modules/apps/connections/revoke"
import { disconnectConnection } from "~/modules/apps/connections/service"
import { writeAuditLog } from "~/modules/audit/service"
import { serverT } from "~/modules/i18n/server-i18n"
import { hasScope } from "~/modules/permissions/permissions"

/** The disconnect event's actor id for a disconnect no person made (the CLI). */
const SYSTEM_ACTOR_ID = "system"

export interface DisconnectTarget {
  id: string
  appName: string
  connectionName: string
  identifier: string
  ownerType: "user" | "org"
  ownerId: string | null
  ownerEmail: string | null
}

/**
 * The active connections of `<app>/<connection>` matching `account` (the
 * address or identifier, case-insensitive, or the connection id).
 */
export async function findDisconnectTargets(
  orgId: string,
  appName: string,
  connectionName: string,
  account: string,
): Promise<DisconnectTarget[]> {
  const wanted = account.trim().toLowerCase()
  const rows = await withPrivilegedDb(orgId, "disconnect-account-find", (tx) =>
    tx
      .select({
        id: connectedAccounts.id,
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
        identifier: connectedAccounts.identifier,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        ownerEmail: users.email,
      })
      .from(connectedAccounts)
      .leftJoin(users, eq(users.id, connectedAccounts.ownerId))
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, appName),
          eq(connectedAccounts.connectionName, connectionName),
          eq(connectedAccounts.status, "active"),
          drizzleSql`(lower(${connectedAccounts.identifier}) = ${wanted} OR ${connectedAccounts.id}::text = ${wanted})`,
        ),
      ),
  )
  return rows.map(
    (r): DisconnectTarget => ({
      ...r,
      ownerType: r.ownerType === "org" ? "org" : "user",
    }),
  )
}

/** Who asks: the privileged CLI, or a person (with the scopes they act with). */
export type DisconnectActor = { kind: "cli" } | { kind: "user"; userId: string; scopes: string[] }

export type DisconnectDecision =
  | { allowed: true; forced: boolean }
  | {
      allowed: false
      code: "ADMIN_SCOPE_REQUIRED" | "NOT_OWNER" | "FORCE_REQUIRED"
      message: string
    }

/** The rule above, as one decision. */
export function decideDisconnect(
  orgId: string,
  target: DisconnectTarget,
  actor: DisconnectActor,
  opts: { force?: boolean } = {},
): DisconnectDecision {
  const adminScope = connectionAdminScope(orgId, target.appName, target.connectionName)
  const isAdmin = actor.kind === "cli" || hasScope(adminScope, actor.scopes)
  if (target.ownerType === "org") {
    return isAdmin
      ? { allowed: true, forced: false }
      : {
          allowed: false,
          code: "ADMIN_SCOPE_REQUIRED",
          message: `Disconnecting the organization's ${target.identifier} takes ${adminScope}.`,
        }
  }
  if (actor.kind === "user" && actor.userId === target.ownerId)
    return { allowed: true, forced: false }
  if (!isAdmin) {
    return {
      allowed: false,
      code: "NOT_OWNER",
      message: `${target.identifier} is ${target.ownerEmail ?? "another member"}'s personal connection: only they can disconnect it.`,
    }
  }
  if (!opts.force) {
    return {
      allowed: false,
      code: "FORCE_REQUIRED",
      message: `${target.identifier} is ${target.ownerEmail ?? "another member"}'s personal connection. Ask them to disconnect it, or pass --force (recorded in the audit log).`,
    }
  }
  return { allowed: true, forced: true }
}

/** The app's own words for what a disconnect deletes. */
const IMPACT_KEYS: Record<string, string> = {
  mail: "mail.disconnectConfirmBody",
  tickets: "tickets.disconnectConfirmBody",
  "google-drive": "google-drive.disconnectConfirmBody",
  calendar: "calendar.disconnectConfirmBody",
}

export function disconnectImpact(appName: string): string {
  const key = IMPACT_KEYS[appName]
  const text = key ? serverT("en", key) : key
  return text && text !== key
    ? text
    : "Liaison stops using this account, and what the app imported from it is deleted from Liaison. The data itself stays with the provider."
}

/**
 * Disconnect one connection the decision allowed. The disconnect event and the
 * audit entry name the same actor: the person for an in-app disconnect, the
 * system (the operator's CLI) otherwise, never a member who did nothing.
 */
export async function performDisconnect(input: {
  orgId: string
  target: DisconnectTarget
  actor: DisconnectActor
  forced: boolean
}): Promise<void> {
  const { orgId, target } = input
  await runBeforeDisconnect(orgId, target.id)
  await withPrivilegedDb(orgId, "disconnect-account", async (tx) => {
    await disconnectConnection(
      tx,
      orgId,
      input.actor.kind === "user" ? input.actor.userId : SYSTEM_ACTOR_ID,
      target.id,
    )
    await writeAuditLog(tx, {
      orgId,
      actorId: input.actor.kind === "user" ? input.actor.userId : "system:cli",
      actorType: input.actor.kind === "user" ? "user" : "system",
      app: "kernel",
      entityType: "connected_account",
      entityId: target.id,
      action: input.forced ? "connection.disconnect.forced" : "connection.disconnect",
      metadata: {
        appName: target.appName,
        connectionName: target.connectionName,
        identifier: target.identifier,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        ...(input.forced
          ? { reason: "personal connection disconnected by an admin (--force)" }
          : {}),
      },
    })
  })
  await runConnectionTeardown(target.id)
}
