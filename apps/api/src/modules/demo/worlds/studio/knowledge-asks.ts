// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `studio-knowledge-asks`: the services world's company knowledge scenario
// event. Mathis Aubry, a developer sizing the sign-on of a new project, asks
// Delivery Desk in #delivery how a past project handled it and what it cost.
// His message is written and dispatched exactly as his own post would be (his
// RLS context, the one mention dispatch), so Delivery Desk's turn runs AS
// MATHIS: his user id, his scopes, his roles and his grants. The past project's
// note is his to read; its costs are restricted to finance and admins, so the
// database gives the agent nothing of them, and its answer says so. Nothing in
// that answer is written here.
//
// The channel is the pack's #delivery (created once per org if it is missing);
// the question is asked once per run of the scenario, so Start again asks
// again, in the same channel. The turn spends on the box key: the registry
// holds the beat until the visitor confirmed their email (`spends`).
import { STUDIO_KNOWLEDGE_ASKS_INJECTOR } from "@liaison/shared"
import { and, eq, gte, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { sendMessage } from "~/modules/threads/message"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { createThread } from "~/modules/threads/thread"
import { worldActor, worldPersonId } from "~/seed/world/people"

/** The developer who asks (a seeded person of the studio, engineering role). */
export const STUDIO_KNOWLEDGE_ASKER = "Mathis Aubry"
/** The seeded delivery agent he asks. */
export const STUDIO_KNOWLEDGE_AGENT = "Delivery Desk"
/** The channel he asks in (shown as #delivery). */
export const STUDIO_KNOWLEDGE_CHANNEL = "Delivery"
export const STUDIO_KNOWLEDGE_QUESTION =
  "how did the OSIER project handle partner sign-on, how long did it take, and what did the project cost us?"

/** The message as Mathis writes it: the agent mention names Delivery Desk by id. */
export function studioKnowledgeMessage(agentId: string): string {
  return `@[${STUDIO_KNOWLEDGE_AGENT}](agent:${agentId}) ${STUDIO_KNOWLEDGE_QUESTION}`
}

async function deliveryDeskId(orgId: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-studio-knowledge-agent", (tx) =>
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.displayName, STUDIO_KNOWLEDGE_AGENT),
          isNull(agents.archivedAt),
        ),
      )
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no ${STUDIO_KNOWLEDGE_AGENT} agent in this org`)
  return row.id
}

async function findChannel(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-studio-knowledge-channel", (tx) =>
    tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.orgId, orgId), eq(threads.title, STUDIO_KNOWLEDGE_CHANNEL)))
      .limit(1),
  )
  return row?.id ?? null
}

export const studioKnowledgeAsksInjector: WorldInjector = {
  id: STUDIO_KNOWLEDGE_ASKS_INJECTOR,
  world: "studio",
  // Delivery Desk's turn runs on the box's model key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, runStartedAt }) {
    const askerId = await worldPersonId(orgId, STUDIO_KNOWLEDGE_ASKER)
    const agentId = await deliveryDeskId(orgId)
    const asker = await worldActor(orgId, askerId)

    // The channel, once per org when the pack has none: Mathis opens it with the visitor in it.
    let channelId = await findChannel(orgId)
    if (!channelId) {
      channelId = await withRlsContext(asker, async (tx) => {
        const created = await createThread(tx, {
          orgId,
          userId: askerId,
          participantIds: [ownerUserId],
          title: STUDIO_KNOWLEDGE_CHANNEL,
          discoverable: true,
          forceCreate: true,
        })
        return created.id
      })
    }

    const state = await withPrivilegedDb(orgId, "demo-world-studio-knowledge-read", async (tx) => {
      const [asked] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, channelId),
            eq(messages.authorId, askerId),
            gte(messages.createdAt, runStartedAt),
          ),
        )
        .limit(1)
      const seats = await tx
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(eq(threadParticipants.threadId, channelId))
      return {
        asked: Boolean(asked),
        seated: new Set(seats.map((s) => s.userId)),
      }
    })
    // Asked already in this run (a reload, a second pass): nothing more.
    if (state.asked) return
    // The channel predates this visitor's seat (another scenario left it): seat both.
    if (!state.seated.has(askerId) || !state.seated.has(ownerUserId)) {
      await withPrivilegedDb(orgId, "demo-world-studio-knowledge-seat", async (tx) => {
        for (const userId of [askerId, ownerUserId]) {
          if (state.seated.has(userId)) continue
          await tx
            .insert(threadParticipants)
            .values({ threadId: channelId, userId, orgId })
            .onConflictDoNothing()
        }
      })
    }

    // Mathis's own post, then the one mention dispatch, both as Mathis.
    const message = await withRlsContext(asker, (tx) =>
      sendMessage(tx, {
        orgId,
        userId: askerId,
        threadId: channelId,
        content: studioKnowledgeMessage(agentId),
        requiredScopes: [],
      }),
    )
    if (!message) throw new Error("demo world: Mathis could not post in #delivery")
    const { dispatchedAgentIds } = await dispatchForPostedMessage(
      (fn) => withRlsContext(asker, fn),
      {
        orgId,
        threadId: channelId,
        message,
        actor: {
          userId: askerId,
          orgId,
          scopes: asker.scopes,
          dimensionGrants: asker.dimensionGrants,
        },
      },
    )
    if (!dispatchedAgentIds.includes(agentId)) {
      throw new Error(`demo world: ${STUDIO_KNOWLEDGE_AGENT} was not dispatched for Mathis`)
    }
  },
  // #delivery: the next beat opens it and waits for Delivery Desk's answer there.
  async entityOf({ orgId }) {
    return findChannel(orgId)
  },
}
