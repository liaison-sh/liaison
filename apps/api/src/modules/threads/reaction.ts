// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, isNull } from "drizzle-orm"
import type { RlsClient, RlsTx } from "~/db"
import { messageReactions, messages, threadParticipants, users } from "~/db/schema/kernel"

interface ReactionParams {
  orgId: string
  userId: string
  userName?: string
  threadId: string
  messageId: string
  emoji: string
}

/**
 * Re-run `fn` up to `attempts` times on Postgres deadlock (SQLSTATE 40P01).
 * Two reaction inserts on the same message — common in chatty threads — touch
 * `kernel.message_reactions` + `kernel.pending_events` in opposite orders
 * (depending on FK validation timing), which Postgres legitimately reports as
 * a deadlock and aborts one transaction. The standard remedy is for the app
 * to retry the aborted transaction; both branches will then succeed in
 * sequence. 50ms × small attempt count keeps p99 latency bounded.
 */
async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code !== "40P01") throw err
      lastErr = err
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * The message a reaction lands on: null unless the user takes part in the
 * thread and the message belongs to this thread and org, not soft-deleted.
 */
async function loadReactionTarget(db: RlsClient, params: ReactionParams) {
  const { orgId, userId, threadId, messageId } = params
  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  const [msg] = await db
    .select({ id: messages.id, replyRootId: messages.replyRootId })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        eq(messages.orgId, orgId),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1)
  return msg ?? null
}

/** Queue the reaction's add/remove event, naming the user (looked up when the caller gave no name). */
async function queueReactionEvent(
  tx: RlsTx,
  action: "add" | "remove",
  params: ReactionParams,
  replyRootId: string | null,
) {
  const { orgId, userId, threadId, messageId, emoji } = params
  let userName = params.userName
  if (!userName) {
    const [user] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    userName = user?.name ?? ""
  }

  await tx.queueEvent({
    app: "kernel",
    entity: "reaction",
    action,
    entityId: messageId,
    orgId,
    actorId: userId,
    // A16: a reaction on a reply updates the open panel, not the channel.
    data: {
      messageId,
      threadId,
      replyRootId,
      userId,
      userName,
      emoji,
    },
  })
}

export async function addReaction(db: RlsClient, params: ReactionParams) {
  const { orgId, userId, messageId, emoji } = params
  const msg = await loadReactionTarget(db, params)
  if (!msg) return null

  // Wrap mutation + event in transaction for atomicity
  return await retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(messageReactions)
        .values({ messageId, userId, orgId, emoji })
        .onConflictDoNothing()
        .returning({ id: messageReactions.id })
      if (inserted.length === 0) return { added: false }

      await queueReactionEvent(tx, "add", params, msg.replyRootId ?? null)
      return { added: true }
    }),
  )
}

export async function removeReaction(db: RlsClient, params: ReactionParams) {
  const { userId, messageId, emoji } = params
  const msg = await loadReactionTarget(db, params)
  if (!msg) return null

  // Wrap mutation + event in transaction for atomicity
  return await retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      const deleted = await tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .returning({ id: messageReactions.id })

      if (deleted.length === 0) return { removed: false }

      await queueReactionEvent(tx, "remove", params, msg.replyRootId ?? null)
      return { removed: true }
    }),
  )
}
