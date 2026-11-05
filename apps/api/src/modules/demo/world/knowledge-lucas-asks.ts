// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `knowledge-lucas-asks`: the company knowledge scenario's live event. Lucas
// Pereira, who joined support last month, asks Support Desk in #support the
// question the visitor just asked their own agent: the Q3 gross margin. His
// message is written and dispatched exactly as his own post would be (his RLS
// context, the one mention dispatch), so Support Desk's turn runs AS LUCAS:
// his user id, his scopes, his roles and his grants. The Q3 P&L is shared with
// finance and admins only, so the database gives the agent nothing finance
// related, and its answer says so. Nothing in that answer is written here.
//
// The channel is created once per org (when the seed has no #support); the
// question is asked once per run of the scenario, so Start again asks again,
// in the same channel. The turn spends on the box key: the registry holds the
// beat until the visitor confirmed their email (`spends`).
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

export const KNOWLEDGE_LUCAS_ASKS_INJECTOR_ID = "knowledge-lucas-asks"

/** The support teammate who asks (a seeded person of the demo company, support role). */
export const KNOWLEDGE_WORLD_ASKER = "Lucas Pereira"
/** The seeded support agent he asks. */
export const KNOWLEDGE_WORLD_AGENT = "Support Desk"
/** The channel he asks in (shown as #support). */
export const KNOWLEDGE_WORLD_CHANNEL = "Support"
export const KNOWLEDGE_WORLD_CHANNEL_TOPIC =
  "Customer questions, returns and the product manuals, with Support Desk on hand"
export const KNOWLEDGE_WORLD_QUESTION = "what was our gross margin in Q3?"

/** The message as Lucas writes it: the agent mention names Support Desk by id. */
export function knowledgeWorldMessage(agentId: string): string {
  return `@[${KNOWLEDGE_WORLD_AGENT}](agent:${agentId}) ${KNOWLEDGE_WORLD_QUESTION}`
}

async function supportDeskId(orgId: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-knowledge-agent", (tx) =>
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.displayName, KNOWLEDGE_WORLD_AGENT),
          isNull(agents.archivedAt),
        ),
      )
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no ${KNOWLEDGE_WORLD_AGENT} agent in this org`)
  return row.id
}

async function findChannel(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-knowledge-channel", (tx) =>
    tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.orgId, orgId), eq(threads.title, KNOWLEDGE_WORLD_CHANNEL)))
      .limit(1),
  )
  return row?.id ?? null
}

export const knowledgeLucasAsksInjector: WorldInjector = {
  id: KNOWLEDGE_LUCAS_ASKS_INJECTOR_ID,
  // Support Desk's turn runs on the box's model key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, runStartedAt }) {
    const askerId = await worldPersonId(orgId, KNOWLEDGE_WORLD_ASKER)
    const agentId = await supportDeskId(orgId)
    const asker = await worldActor(orgId, askerId)

    // The channel, once per org: Lucas opens it with the visitor in it.
    let channelId = await findChannel(orgId)
    if (!channelId) {
      channelId = await withRlsContext(asker, async (tx) => {
        const created = await createThread(tx, {
          orgId,
          userId: askerId,
          participantIds: [ownerUserId],
          title: KNOWLEDGE_WORLD_CHANNEL,
          discoverable: true,
          forceCreate: true,
        })
        return created.id
      })
    }

    const state = await withPrivilegedDb(orgId, "demo-world-knowledge-read", async (tx) => {
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
      await withPrivilegedDb(orgId, "demo-world-knowledge-seat", async (tx) => {
        for (const userId of [askerId, ownerUserId]) {
          if (state.seated.has(userId)) continue
          await tx
            .insert(threadParticipants)
            .values({ threadId: channelId, userId, orgId })
            .onConflictDoNothing()
        }
      })
    }

    // Lucas's own post, then the one mention dispatch, both as Lucas.
    const message = await withRlsContext(asker, (tx) =>
      sendMessage(tx, {
        orgId,
        userId: askerId,
        threadId: channelId,
        content: knowledgeWorldMessage(agentId),
        requiredScopes: [],
      }),
    )
    if (!message) throw new Error("demo world: Lucas could not post in #support")
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
      throw new Error(`demo world: ${KNOWLEDGE_WORLD_AGENT} was not dispatched for Lucas`)
    }
  },
  // #support: the next beat opens it and waits for Support Desk's answer there.
  async entityOf({ orgId }) {
    return findChannel(orgId)
  },
}
