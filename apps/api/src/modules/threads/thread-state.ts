// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, desc, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { messages, threadParticipants, userThreadState } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { notStatusLine } from "~/modules/threads/status-line-sql"

interface UpdateStateParams {
  orgId: string
  userId: string
  threadId: string
  isArchived?: boolean
  isMuted?: boolean
  isPinned?: boolean
  notifyAllPosts?: boolean
}

/** A4: the channel view of `kernel.messages` (see CHANNEL_MESSAGE_PREDICATE). */
const channelVisible = drizzleSql`(${messages.replyRootId} IS NULL OR ${messages.alsoInChannel})`

/**
 * The channel read mark was given a reply the channel does not show (A4). The
 * reader is a participant; the id is what is wrong, so the route answers 400
 * with this code instead of a participant refusal.
 */
export const HIDDEN_REPLY_NOT_CHANNEL_MESSAGE = "hidden_reply_not_channel_message"

export class HiddenReplyReadError extends Error {
  readonly code = HIDDEN_REPLY_NOT_CHANNEL_MESSAGE
  constructor() {
    super(
      "This message is a reply that is not in the channel: mark it read through its reply thread",
    )
    this.name = "HiddenReplyReadError"
  }
}

interface MarkReadParams {
  orgId: string
  userId: string
  threadId: string
  lastReadMessageId?: string
}

/** The reader's own flags on one thread, as stored after a write. */
export interface ThreadStateFlags {
  isArchived: boolean
  isMuted: boolean
  isPinned: boolean
  /** Interrupted by every post of this channel, not only by mentions (0259). */
  notifyAllPosts: boolean
}

/**
 * Write the caller's own mute / archive / pin / notify-all flags on a thread.
 *
 * Returns `null` when the caller is not a participant, otherwise
 * `{ state }`: the flags as stored after the write, so the caller can tell the
 * reader's other devices (broadcastReadState `thread_state`), or `state: null`
 * for an empty body, which writes nothing and announces nothing.
 */
export async function updateThreadState(
  db: RlsClient,
  params: UpdateStateParams,
): Promise<{ state: ThreadStateFlags | null } | null> {
  const { orgId, userId, threadId, isArchived, isMuted, isPinned, notifyAllPosts } = params

  // No-op if no state fields provided (empty PATCH body)
  if (
    isArchived === undefined &&
    isMuted === undefined &&
    isPinned === undefined &&
    notifyAllPosts === undefined
  ) {
    return { state: null }
  }

  // Verify user is a participant of this thread in this org
  const [participant] = await db
    .select({ id: threadParticipants.id })
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

  const [state] = await db
    .insert(userThreadState)
    .values({
      userId,
      threadId,
      orgId,
      isArchived: isArchived ?? false,
      isMuted: isMuted ?? false,
      isPinned: isPinned ?? false,
      notifyAllPosts: notifyAllPosts ?? false,
    })
    .onConflictDoUpdate({
      target: [userThreadState.userId, userThreadState.threadId],
      set: {
        ...(isArchived !== undefined ? { isArchived } : {}),
        ...(isMuted !== undefined ? { isMuted } : {}),
        ...(isPinned !== undefined ? { isPinned } : {}),
        ...(notifyAllPosts !== undefined ? { notifyAllPosts } : {}),
      },
    })
    .returning({
      isArchived: userThreadState.isArchived,
      isMuted: userThreadState.isMuted,
      isPinned: userThreadState.isPinned,
      notifyAllPosts: userThreadState.notifyAllPosts,
    })
  return { state: state ?? null }
}

export async function markThreadRead(db: RlsClient, params: MarkReadParams): Promise<boolean> {
  const { orgId, userId, threadId } = params

  // Verify user is a participant of this thread in this org
  const [participant] = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return false

  // Resolve message ID: use the provided one or fall back to the latest in the thread
  let msgId = params.lastReadMessageId
  if (msgId) {
    // Validate message belongs to this thread, and to its CHANNEL view (A4): a
    // reply the channel does not show is read through its own reply thread's
    // mark, never the channel's.
    const [validMsg] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, msgId),
          eq(messages.threadId, threadId),
          drizzleSql`${messages.deletedAt} IS NULL`,
          channelVisible,
        ),
      )
      .limit(1)
    if (!validMsg) {
      // A reply of THIS thread that the channel does not show is a wrong id,
      // not a foreign one: say which.
      const [hidden] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.id, msgId),
            eq(messages.threadId, threadId),
            drizzleSql`${messages.deletedAt} IS NULL`,
            drizzleSql`${messages.replyRootId} IS NOT NULL`,
          ),
        )
        .limit(1)
      if (hidden) throw new HiddenReplyReadError()
      return false // Reject foreign messageId
    }
  } else {
    const [latest] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          drizzleSql`${messages.deletedAt} IS NULL`,
          channelVisible,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    if (!latest) return true // Empty thread is validly "read"
    msgId = latest.id
  }

  await db
    .insert(userThreadState)
    .values({
      userId,
      threadId,
      orgId,
      lastReadMessageId: msgId!,
      lastReadAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userThreadState.userId, userThreadState.threadId],
      set: {
        lastReadMessageId: drizzleSql`
          CASE WHEN (
            SELECT ${messages.createdAt} FROM ${messages} WHERE ${messages.id} = ${msgId!}
          ) > COALESCE(
            (SELECT ${messages.createdAt} FROM ${messages} WHERE ${messages.id} = ${userThreadState.lastReadMessageId}),
            '1970-01-01'::timestamptz
          )
          THEN ${msgId!}::uuid
          ELSE ${userThreadState.lastReadMessageId}
          END
        `,
        lastReadAt: drizzleSql`
          CASE WHEN (
            SELECT ${messages.createdAt} FROM ${messages} WHERE ${messages.id} = ${msgId!}
          ) > COALESCE(
            (SELECT ${messages.createdAt} FROM ${messages} WHERE ${messages.id} = ${userThreadState.lastReadMessageId}),
            '1970-01-01'::timestamptz
          )
          THEN NOW()
          ELSE ${userThreadState.lastReadAt}
          END
        `,
      },
    })
  return true
}

/**
 * The reader's unread count for one thread, by the SAME predicate the thread
 * list uses (thread.ts `unread_count`): channel-visible, not deleted, not the
 * reader's own words, newer than their read mark. Read after a mark moved so
 * the reader's other devices are told the exact count, not a guess of zero
 * that a message landing mid-read would make wrong.
 */
export async function countThreadUnread(
  db: RlsClient,
  params: { userId: string; threadId: string },
): Promise<number> {
  const { userId, threadId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{ unread: number }>(
    await db.execute(drizzleSql`
      SELECT COUNT(*)::int AS unread
      FROM ${k}.messages m
      LEFT JOIN ${k}.user_thread_state uts
        ON uts.thread_id = m.thread_id AND uts.user_id = ${userId}
      WHERE m.thread_id = ${threadId}
        AND m.deleted_at IS NULL
        AND (m.reply_root_id IS NULL OR m.also_in_channel)
        AND NOT (m.author_id = ${userId} AND m.author_type IN ('user', 'system'))
        AND ${notStatusLine()}
        AND m.created_at > COALESCE(
          (SELECT m2.created_at FROM ${k}.messages m2 WHERE m2.id = uts.last_read_message_id),
          '1970-01-01'::timestamptz
        )
    `),
  )
  return rows[0]?.unread ?? 0
}
