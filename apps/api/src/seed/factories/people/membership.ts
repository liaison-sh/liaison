// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The membership factory: put a person inside the world other writers made.
// Join them to the org's conversations (thread visibility is participant
// gated in RLS, so an account in none opens onto an empty Chats list) and add
// them to the notify set of every approval still pending (the approval queue
// lists only what the caller is notified about).
//
// Privileged: the conversations and approvals belong to other people, so
// neither is visible to the person before they are added; the rows are
// written over the privileged connection, pinned to the org, with Drizzle.
// Idempotent: a seat collides on its unique index, and the notify-set update
// checks before it appends.
import { and, asc, eq, isNotNull, not, notExists, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { threadParticipants, threads } from "~/db/schema/kernel/threads"

/**
 * Every conversation `userId` belongs in, oldest first: every one EXCEPT a
 * discoverable channel they are not already in. A discoverable channel exists
 * to be found in the channel browser; joining them to it would leave the
 * workspace nothing to discover. One they are already in keeps them in it.
 */
export async function threadsToJoin(orgId: string, userId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "seed-membership-threads", async (tx) => {
    const rows = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.orgId, orgId),
          not(
            and(
              eq(threads.discoverable, true),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(threadParticipants)
                  .where(
                    and(
                      eq(threadParticipants.threadId, threads.id),
                      eq(threadParticipants.userId, userId),
                    ),
                  ),
              ),
            ) ?? sql`false`,
          ),
        ),
      )
      .orderBy(asc(threads.createdAt))
    return rows.map((r) => String(r.id))
  })
}

/** Seat `userId` as a member in every conversation listed. Returns how many were listed. */
export async function joinThreads(
  orgId: string,
  userId: string,
  threadIds: readonly string[],
): Promise<number> {
  if (threadIds.length === 0) return 0
  await withPrivilegedDb(orgId, "seed-membership-join", async (tx) => {
    for (const threadId of threadIds) {
      await tx
        .insert(threadParticipants)
        .values({ threadId, userId, orgId, participantType: "user", role: "member" })
        .onConflictDoNothing({
          target: [threadParticipants.threadId, threadParticipants.userId],
          where: isNotNull(threadParticipants.userId),
        })
    }
  })
  return threadIds.length
}

/** Add `userId` to the notify set of every approval still pending. Returns how many. */
export async function joinPendingApprovals(orgId: string, userId: string): Promise<number> {
  return withPrivilegedDb(orgId, "seed-membership-approvals", async (tx) => {
    const rows = await tx
      .update(approvalRequests)
      .set({ notifyUserIds: sql`array_append(${approvalRequests.notifyUserIds}, ${userId}::uuid)` })
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          eq(approvalRequests.status, "pending"),
          sql`NOT (${userId}::uuid = ANY(${approvalRequests.notifyUserIds}))`,
        ),
      )
      .returning({ id: approvalRequests.id })
    return rows.length
  })
}
