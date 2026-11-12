// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Room floor resolver (D2). Decides which effective-scope case applies to the
// current thread and returns the human members' current grants the floor is
// computed from. The intersection itself is done by the caller.
//
//   routine      -> routine_tick, no requester and no floor
//   agent_chat   -> dm, the requester alone (adding a participant to an
//                   agent_chat promotes it to a 'thread', so it holds one human)
//   thread       -> channel, every human participant, plus the requester
//   approval     -> channel, same as thread: an approval discussion holds the
//                   requester plus the notify audience and gains members through
//                   addParticipant without ever changing type
//   subrun       -> throws: a hidden subrun thread has no participant rows, so
//                   neither the mention route nor runAgentChat can reach it, and
//                   the subrun worker runs its own loop with its own scopes
//
// Fail-closed: a missing thread or any other type throws. Nothing here ever
// falls back to routine_tick, which is the one unfloored case.

import { and, asc, eq, isNotNull } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

export type RoomFloor =
  | {
      kind: "channel" | "dm"
      memberGrants: string[][]
      /** The requester's own grants, also present in `memberGrants`. */
      requesterGrants: string[]
      /** The people the floor counts (the requester included), in `memberGrants` order: who the
       *  turn's reply reaches, which a shared resource's readers are checked against (rule 15e). */
      memberIds: string[]
    }
  | { kind: "routine_tick" }

export type RoomFloorErrorCode =
  | "E_ROOM_FLOOR_THREAD_NOT_FOUND"
  | "E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE"

export class RoomFloorError extends Error {
  readonly code: RoomFloorErrorCode
  constructor(code: RoomFloorErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "RoomFloorError"
    this.code = code
  }
}

async function grantsOf(db: PrivilegedDb, userId: string, orgId: string): Promise<string[]> {
  return (await loadEffectivePermissions(db, userId, orgId)).scopes
}

export async function resolveRoomFloor(
  db: PrivilegedDb,
  orgId: string,
  threadId: string,
  requesterUserId: string,
): Promise<RoomFloor> {
  const [thread] = await db
    .select({ type: threads.type })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    .limit(1)
  if (!thread) {
    throw new RoomFloorError("E_ROOM_FLOOR_THREAD_NOT_FOUND", `thread ${threadId} not in org`)
  }

  switch (thread.type) {
    case "routine":
      return { kind: "routine_tick" }

    case "agent_chat": {
      const requesterGrants = await grantsOf(db, requesterUserId, orgId)
      return {
        kind: "dm",
        memberGrants: [requesterGrants],
        requesterGrants,
        memberIds: [requesterUserId],
      }
    }

    case "thread":
    case "approval": {
      const rows = await db
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.orgId, orgId),
            // Human members only: since 0075 a participant row can be an AGENT
            // (user_id NULL), which holds no user grants and so contributes no
            // floor. Its ceiling is applied by the agent machinery instead.
            isNotNull(threadParticipants.userId),
          ),
        )
        .orderBy(asc(threadParticipants.createdAt), asc(threadParticipants.userId))
      const memberIds = rows.flatMap((r) => (r.userId === null ? [] : [r.userId]))
      // The turn answers the requester, so their grants always bound it, even
      // when they are not (or no longer) a participant. This also keeps the
      // list non-empty: an empty list must never read as "no floor".
      if (!memberIds.includes(requesterUserId)) memberIds.push(requesterUserId)
      const memberGrants: string[][] = []
      let requesterGrants: string[] = []
      for (const userId of memberIds) {
        const grants = await grantsOf(db, userId, orgId)
        if (userId === requesterUserId) requesterGrants = grants
        memberGrants.push(grants)
      }
      return { kind: "channel", memberGrants, requesterGrants, memberIds }
    }

    default:
      throw new RoomFloorError(
        "E_ROOM_FLOOR_UNSUPPORTED_THREAD_TYPE",
        `thread type '${thread.type}' has no room floor case`,
      )
  }
}
