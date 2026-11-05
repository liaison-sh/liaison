// SPDX-License-Identifier: FSL-1.1-ALv2
// Reactive visibility. A grant or revoke that can change a user's effective
// scope queues a kernel permission event in the SAME transaction as the write,
// and that event names its target: `data.targetUserId` for a per-user grant,
// `data.targetUserIds` for a change that touches several members at once (an
// app turned Off or restricted in the workspace), `data.roleId` for a
// role-level one.
//
// Delivery resolves everything it needs from that event and the database, at
// delivery time, for the users the DELIVERING process has connected. Nothing is
// carried between calls, so any process can serve any event: a grant made on
// process A reaches process B over Redis and still invalidates B's own sockets.
// It also means there is no store to grow: an event for a user nobody has
// connected resolves to nothing and leaves nothing behind.
//
// A2: a resolved payload carries only that user's own participated thread ids,
// so the delivery side can send it to that user's own connections and nowhere
// else, and never carries message content.

import { and, asc, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { threadParticipants, userRoles } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "grant-invalidation" })

/** One user's invalidation: that user's id and that user's own thread ids. */
export interface ScopeGrantInvalidation {
  userId: string
  /** Threads the affected user participates in, resolved at delivery. */
  threadIds: string[]
}

/** The fields the delivery side reads off a queued kernel permission event. */
interface PermissionEventLike {
  entity?: string
  orgId?: string
  data?: unknown
}

/** Thread ids per user, one query, with an entry for every requested user. */
async function participatedThreadIdsByUser(
  userIds: string[],
  orgId: string,
): Promise<Map<string, string[]>> {
  const rows = await withPrivilegedDb(orgId, "grant-invalidation: participated threads", (tx) =>
    tx
      .select({ userId: threadParticipants.userId, threadId: threadParticipants.threadId })
      .from(threadParticipants)
      .where(and(inArray(threadParticipants.userId, userIds), eq(threadParticipants.orgId, orgId)))
      .orderBy(asc(threadParticipants.threadId)),
  )
  const byUser = new Map<string, string[]>(userIds.map((userId) => [userId, []]))
  for (const row of rows) {
    // user_id is nullable since 0075 (agent participant rows); the inArray
    // predicate above never matches one, so this is a type narrowing only.
    if (row.userId === null) continue
    const threadIds = byUser.get(row.userId)
    if (threadIds && !threadIds.includes(row.threadId)) threadIds.push(row.threadId)
  }
  return byUser
}

async function roleMemberIds(roleId: string, orgId: string): Promise<string[]> {
  const rows = await withPrivilegedDb(orgId, "grant-invalidation: role members", (tx) =>
    tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.roleId, roleId), eq(userRoles.orgId, orgId))),
  )
  return [...new Set(rows.map((row) => row.userId))]
}

/**
 * Delivery side. Given a kernel permission event and the ids of the users this
 * process currently has connected, resolve who must be invalidated and what
 * each one's own thread ids are.
 *
 * Targets come from the event: a per-user grant names `data.targetUserId`, a
 * role-level one names `data.roleId` and this reads that role's current members.
 * Either way the result is narrowed to users this process has connected, since
 * nobody else can be delivered to from here, and each entry carries only that
 * user's own ids.
 *
 * An event naming neither fails closed (nobody is invalidated) rather than
 * falling back to the whole org. Never throws: a resolution failure is logged
 * and delivers nothing, because a WebSocket fan-out must not be broken by it.
 */
export async function resolveGrantInvalidations(
  event: PermissionEventLike,
  connectedUserIds: Iterable<string>,
): Promise<ScopeGrantInvalidation[]> {
  const orgId = event.orgId
  if (!orgId) return []
  const connected = new Set(connectedUserIds)
  if (connected.size === 0) return []

  const data = event.data as
    | { targetUserId?: unknown; targetUserIds?: unknown; roleId?: unknown }
    | undefined
  try {
    let targets: string[]
    if (typeof data?.targetUserId === "string" && data.targetUserId.length > 0) {
      targets = connected.has(data.targetUserId) ? [data.targetUserId] : []
    } else if (Array.isArray(data?.targetUserIds)) {
      // A change of an app's state or access in the workspace (S19, S20)
      // touches many members at once: the event lists them.
      targets = [
        ...new Set(
          data.targetUserIds.filter(
            (id): id is string => typeof id === "string" && connected.has(id),
          ),
        ),
      ]
    } else if (typeof data?.roleId === "string" && data.roleId.length > 0) {
      targets = (await roleMemberIds(data.roleId, orgId)).filter((userId) => connected.has(userId))
    } else {
      log.warn(
        { entity: event.entity, orgId },
        "grant-invalidation: permission event names no target user or role, invalidating nobody",
      )
      return []
    }
    if (targets.length === 0) return []

    const byUser = await participatedThreadIdsByUser(targets, orgId)
    return targets.map((userId) => ({ userId, threadIds: byUser.get(userId) ?? [] }))
  } catch (err) {
    log.error(
      { err, entity: event.entity, orgId },
      "grant-invalidation: could not resolve invalidation targets",
    )
    return []
  }
}
