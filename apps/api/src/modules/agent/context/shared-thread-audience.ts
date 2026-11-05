// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHO READS THE REPLY. A turn in a conversation other people can see (a task's
 * discussion, a channel, a ticket's internal thread) is posted to all of them,
 * yet nothing in the prompt said so: the agent wrote as if it were in a private
 * chat with the person who asked. Asked in a task's discussion to file subtasks
 * and then answer a teammate, it posted its retry notes, a blocker report full
 * of tool detail, a "say the word" aimed at the asker, and the teammate's
 * answer as an unsent draft, all in front of the teammate.
 *
 * This module names the audience (the human participants other than the asker)
 * and renders the short section the turn's runtime context carries when there
 * is one. A private agent chat has no one else in it and gets nothing, so the
 * section costs nothing there. The same audience decides what the turn persists
 * (agent-service.ts: only the final answer, never the narration between tools).
 */
import { and, eq, isNotNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { threadParticipants, threads, users } from "~/db/schema/kernel"

/** The people besides the asker who read a reply posted in a thread. */
export interface SharedThreadAudience {
  /** The asker's display name. */
  askerName: string
  /** Every other human participant's display name, in seat order. */
  others: string[]
  /** A discoverable channel: anyone in the workspace may open it too. */
  discoverable: boolean
}

/** At most this many names are listed; the rest are counted. */
const MAX_NAMED = 8

/**
 * The thread's audience for a reply to `askerId`, or null when no other person
 * is in the conversation (a private agent chat, a thread the asker is alone in).
 * Read privileged: the asker's participation was already checked by the caller,
 * and the names are what every participant already sees in the header.
 */
export async function loadSharedThreadAudience(
  orgId: string,
  threadId: string,
  askerId: string,
): Promise<SharedThreadAudience | null> {
  return withPrivilegedDb(orgId, "context-shared-audience", async (tx) => {
    const rows = await tx
      .select({ userId: threadParticipants.userId, name: users.name })
      .from(threadParticipants)
      .innerJoin(users, eq(users.id, threadParticipants.userId))
      .where(
        and(
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.orgId, orgId),
          isNotNull(threadParticipants.userId),
        ),
      )
      .orderBy(threadParticipants.createdAt)
    const others = rows.filter((r) => r.userId !== askerId).map((r) => r.name)
    if (others.length === 0) return null
    const [thread] = await tx
      .select({ discoverable: threads.discoverable })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    return {
      askerName: rows.find((r) => r.userId === askerId)?.name ?? "the person who asked",
      others,
      discoverable: thread?.discoverable === true,
    }
  })
}

/** The heading the section opens with, for tests and the token measure. */
export const SHARED_THREAD_HEADING = "## This conversation is shared"

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED)
  const rest = names.length - shown.length
  const items = rest > 0 ? [...shown, `${rest} others`] : shown
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/**
 * The section itself. Short and imperative on purpose: weak models follow a
 * handful of concrete rules, and the turn's prompt is already near its cap.
 * The last rule overrides a tool result that asks for a blocker report.
 */
export function renderSharedThreadAudience(audience: SharedThreadAudience): string {
  const readers = audience.discoverable
    ? `${nameList(audience.others)}, and anyone in the workspace who opens it,`
    : nameList(audience.others)
  return [
    SHARED_THREAD_HEADING,
    `${audience.askerName} asked you this in a conversation ${readers} can also read. Your reply is posted to all of them, so write it for them:`,
    "- Address the people here, by name when it helps.",
    "- Post only your final answer: no tool names, errors, retries or internal detail.",
    "- No drafts meant for someone else: post the message to them, or don't.",
    '- No "say the word" or offer aimed at one person in front of the others.',
    `- If the work failed, write one plain sentence saying what didn't happen and what happens next, naming ${audience.askerName} if they need to act. This holds even when a tool result asks you to report a blocker.`,
  ].join("\n")
}
