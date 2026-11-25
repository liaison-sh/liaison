// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `studio-chat-question`: the services world's chat scenario event. A teammate
// opens a channel with the visitor and asks a question whose answer is on a
// page, so the agent the visitor brings in reads the page and cites it. The
// page is a fictional one on a reserved `.example` host the demo answers in
// process (`web-fixture.ts`), labelled fictional in the message itself. Fixed
// content; the channel is written once per org, the question once per run.
import { STUDIO_CHAT_QUESTION_INJECTOR } from "@liaison/shared"
import { and, eq, gte } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, threads } from "~/db/schema/kernel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { sendMessage } from "~/modules/threads/message"
import { createThread } from "~/modules/threads/thread"
import { worldActor, worldPersonId } from "~/seed/world/people"
import { STUDIO_DATA_CONTRACTS_URL } from "./web-fixture"

/** The teammate who asks (a seeded person of the demo company). */
export const STUDIO_CHAT_ASKER = "Sofia Lind"
export const STUDIO_CHAT_CHANNEL = "Warehouse data"
export const STUDIO_CHAT_QUESTION =
  "What should a data contract between a warehouse and its suppliers hold, and what does that " +
  "mean for the stock feeds we build? A fictional guide to start from: " +
  STUDIO_DATA_CONTRACTS_URL

export const studioChatQuestionInjector: WorldInjector = {
  id: STUDIO_CHAT_QUESTION_INJECTOR,
  world: "studio",
  async injectWorldEvent({ orgId, ownerUserId, runStartedAt }) {
    const askerId = await worldPersonId(orgId, STUDIO_CHAT_ASKER)
    const asker = await worldActor(orgId, askerId)
    const existing = await withPrivilegedDb(orgId, "demo-world-studio-chat-read", async (tx) => {
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, STUDIO_CHAT_CHANNEL)))
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
            title: STUDIO_CHAT_CHANNEL,
            forceCreate: true,
          })
        ).id
      await sendMessage(tx, {
        orgId,
        userId: askerId,
        threadId,
        content: STUDIO_CHAT_QUESTION,
        requiredScopes: [],
      })
    })
  },
  // The channel: the beats after the question open it and read the message there.
  async entityOf({ orgId }) {
    return withPrivilegedDb(orgId, "demo-world-studio-chat-channel", async (tx) => {
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, STUDIO_CHAT_CHANNEL)))
        .limit(1)
      return thread?.id ?? null
    })
  },
}
