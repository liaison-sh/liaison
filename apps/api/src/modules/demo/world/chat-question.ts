// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `chat-question`: the chat scenario's live event. A teammate opens a channel
// with the visitor and asks a question that needs fresh information from the
// web, so the agent the visitor brings in searches and answers with sources.
// Fixed content; the channel is written once per org and the question once
// per run of the scenario (starting it again asks again, in the same channel).
// The channel is what the beat records, so the steps after it open it.
import { and, eq, gte } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, threads } from "~/db/schema/kernel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { sendMessage } from "~/modules/threads/message"
import { createThread } from "~/modules/threads/thread"
import { worldActor, worldPersonId } from "~/seed/world/people"

export const CHAT_QUESTION_INJECTOR_ID = "chat-question"

/** The teammate who asks (a seeded person of the demo company). */
export const CHAT_WORLD_ASKER = "Tobias Braun"
export const CHAT_WORLD_CHANNEL = "Battery passport"
export const CHAT_WORLD_QUESTION =
  "Which EU rules on battery passports apply to us from 2027, and what do we need to change?"

export const chatQuestionInjector: WorldInjector = {
  id: CHAT_QUESTION_INJECTOR_ID,
  async injectWorldEvent({ orgId, ownerUserId, runStartedAt }) {
    const askerId = await worldPersonId(orgId, CHAT_WORLD_ASKER)
    const asker = await worldActor(orgId, askerId)
    const existing = await withPrivilegedDb(orgId, "demo-world-chat-read", async (tx) => {
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, CHAT_WORLD_CHANNEL)))
        .limit(1)
      if (!thread) return { threadId: null, asked: false }
      const [asked] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, thread.id),
            eq(messages.authorId, askerId),
            gte(messages.createdAt, runStartedAt),
          ),
        )
        .limit(1)
      return { threadId: thread.id, asked: Boolean(asked) }
    })
    if (existing.asked) return
    await withRlsContext(asker, async (tx) => {
      const threadId =
        existing.threadId ??
        (
          await createThread(tx, {
            orgId,
            userId: askerId,
            participantIds: [ownerUserId],
            title: CHAT_WORLD_CHANNEL,
            forceCreate: true,
          })
        ).id
      await sendMessage(tx, {
        orgId,
        userId: askerId,
        threadId,
        content: CHAT_WORLD_QUESTION,
        requiredScopes: [],
      })
    })
  },
  // The channel: the beats after the question open it and read his message there.
  async entityOf({ orgId }) {
    return withPrivilegedDb(orgId, "demo-world-chat-channel", async (tx) => {
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, CHAT_WORLD_CHANNEL)))
        .limit(1)
      return thread?.id ?? null
    })
  },
}
