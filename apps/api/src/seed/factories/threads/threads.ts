// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The threads factory: titled team rooms and channels with their history, and
// a person's direct messages with agents.
//
// Kernel services on an RLS transaction, as the person: `createThread`,
// `updateThread` (topic and description, the call the channel details panel
// makes), `createOrGetAgentDm` (the product's own DM find-or-create, so a
// re-seed adopts whatever DM exists) and `sendMessage`. An agent's turn is
// written the way a real one is stored: inside a person's transaction, with
// `authorType: "agent"` and the agent's id.
//
// Privileged reads only: how many messages a room already holds (so a re-run
// adopts its history instead of replaying it onto the end of itself), a
// person's personal agent, and rooms found by title for a later layer. No
// privileged write.
import { and, count, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { messages, threads } from "~/db/schema/kernel/threads"
import { SEEDED_METADATA } from "~/modules/notifications/seeded"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm, createThread, updateThread } from "~/modules/threads/thread"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, type SeedPerson } from "~/seed/factories/people/actors"

export interface ThreadMessageSpec {
  /** Person key, or an agent handle such as `@support`. */
  author: string
  body: string
  hoursAgo: number
}

export interface ThreadSpec {
  key: string
  title: string
  /** Person key: the thread's creator. */
  creator: string
  participants: string[]
  pinned?: boolean
  /** A CHANNEL: listed org wide and joinable by any member (titled rooms only). */
  discoverable?: boolean
  /** The one line beside the channel name. Capped at 250 by the column. */
  topic?: string
  /** The standing "what is this channel". Capped at 2000 by the column. */
  description?: string
  messages: ThreadMessageSpec[]
}

export interface AgentDmMessageSpec {
  /** The person's own turn, or the agent's. */
  from: "owner" | "agent"
  body: string
  hoursAgo: number
}

export interface AgentDmSpec {
  key: string
  /** `personal` for the person's own assistant, or a role agent handle. */
  agent: string
  messages: AgentDmMessageSpec[]
}

/** A role agent as the factories address it. */
export interface SeedAgentRef {
  agentId: string
  displayName: string
}

async function messageCount(ctx: SeedContext, threadId: string, reason: string): Promise<number> {
  const [row] = await withPrivilegedDb(ctx.orgId, reason, (tx) =>
    tx
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.orgId, ctx.orgId), eq(messages.threadId, threadId))),
  )
  return Number(row?.n ?? 0)
}

/**
 * Seed each titled room: created by its creator in its OWN transaction and
 * committed before any message is sent (a message's transaction re-reads the
 * room and its seats to authorize the write, which a second connection could
 * not see uncommitted), then its topic and description, then its history
 * unless an earlier run already wrote it. Room ids by spec key.
 */
export async function seedThreads(
  ctx: SeedContext,
  input: {
    actors: Record<string, UserContext>
    people: Record<string, SeedPerson | undefined>
    agentsByHandle: Record<string, SeedAgentRef | undefined>
    specs: readonly ThreadSpec[]
  },
): Promise<Record<string, string>> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  const byKey: Record<string, string> = {}

  for (const spec of input.specs) {
    const creator = input.actors[spec.creator]
    if (!creator) throw new Error(`threads seed: no actor for '${spec.creator}'`)

    const threadId = await asUser(creator, async (tx) => {
      const [existing] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.orgId, orgId), eq(threads.title, spec.title)))
        .limit(1)
      if (existing) return existing.id
      const created = await createThread(
        tx as never,
        {
          orgId,
          userId: creator.userId,
          participantIds: spec.participants
            .map((key) => input.people[key]?.userId)
            .filter((id): id is string => Boolean(id)),
          title: spec.title,
          isPinned: spec.pinned ?? false,
          ...(spec.discoverable ? { discoverable: true } : {}),
          // A TITLED thread refuses to be created twice. The title lookup above
          // is what keeps this idempotent; this only stops the refusal racing a
          // concurrent create.
          forceCreate: true,
        } as never,
      )
      return created.id as string
    })
    byKey[spec.key] = threadId

    // Skipped when the row already says what the spec says, so a re-run
    // writes nothing at all rather than touching `updated_at`.
    if (spec.topic !== undefined || spec.description !== undefined) {
      await asUser(creator, async (tx) => {
        const [current] = await tx
          .select({ topic: threads.topic, description: threads.description })
          .from(threads)
          .where(eq(threads.id, threadId))
        const changes: { topic?: string; description?: string } = {}
        if (spec.topic !== undefined && current?.topic !== spec.topic) changes.topic = spec.topic
        if (spec.description !== undefined && current?.description !== spec.description) {
          changes.description = spec.description
        }
        if (Object.keys(changes).length === 0) return
        await updateThread(tx as never, {
          orgId,
          userId: creator.userId,
          threadId,
          scopes: creator.scopes,
          changes,
        })
      })
    }

    if ((await messageCount(ctx, threadId, "seed-threads:history")) >= spec.messages.length) {
      continue
    }

    for (const msg of spec.messages) {
      const isAgent = msg.author.startsWith("@")
      const agent = isAgent ? input.agentsByHandle[msg.author] : undefined
      if (isAgent && !agent) throw new Error(`threads seed: no agent '${msg.author}'`)
      // `authorId` is whoever's turn it is and `authorAgentId` names the agent
      // that spoke, which is how a real agent reply is stored.
      const authorUser = isAgent ? creator : input.actors[msg.author]
      if (!authorUser) throw new Error(`threads seed: no actor for '${msg.author}'`)
      await asUser(authorUser, (tx) =>
        sendMessage(
          tx as never,
          {
            orgId,
            userId: authorUser.userId,
            threadId,
            content: msg.body,
            authorType: isAgent ? "agent" : "user",
            ...(isAgent
              ? {
                  agentId: (agent as SeedAgentRef).agentId,
                  agentAuthorLabel: (agent as SeedAgentRef).displayName,
                }
              : {}),
            requiredScopes: [],
            metadata: {
              ...SEEDED_METADATA,
              seededAt: clock.hoursBefore(msg.hoursAgo).toISOString(),
            },
          } as never,
        ),
      )
    }
  }

  return byKey
}

/** `userId`'s personal agent, or undefined. */
async function personalAgentOf(
  ctx: SeedContext,
  userId: string,
): Promise<{ id: string; display_name: string } | undefined> {
  const [row] = await withPrivilegedDb(ctx.orgId, "seed-threads:owner-agent", (tx) =>
    tx
      .select({ id: agents.id, display_name: agents.displayName })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, ctx.orgId),
          eq(agents.kind, "personal"),
          eq(agents.ownerUserId, userId),
        ),
      )
      .limit(1),
  )
  return row
}

/**
 * The person's one to one rooms with agents, through the product's own DM
 * find-or-create, with their history unless an earlier run wrote it. A spec
 * whose agent is missing is skipped (logged). Room ids, in spec order.
 */
export async function seedAgentDms(
  ctx: SeedContext,
  owner: UserContext,
  input: {
    agentsByHandle: Record<string, SeedAgentRef | undefined>
    specs: readonly AgentDmSpec[]
  },
): Promise<string[]> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  const ownerUserId = owner.userId
  const threadIds: string[] = []

  for (const spec of input.specs) {
    const agent =
      spec.agent === "personal"
        ? await personalAgentOf(ctx, ownerUserId)
        : (() => {
            const role = input.agentsByHandle[spec.agent]
            return role ? { id: role.agentId, display_name: role.displayName } : undefined
          })()
    if (!agent) {
      ctx.log(`agent dms: no agent for '${spec.agent}', skipping that conversation`)
      continue
    }
    const dm = await asUser(owner, (tx) =>
      createOrGetAgentDm(tx as never, { orgId, userId: ownerUserId, agentId: agent.id }),
    )
    if (!dm) {
      ctx.log(`agent dms: agent '${spec.agent}' is gone, skipping that conversation`)
      continue
    }
    const threadId = dm.id
    threadIds.push(threadId)

    if ((await messageCount(ctx, threadId, "seed-threads:dm-history")) >= spec.messages.length) {
      continue
    }

    for (const msg of spec.messages) {
      const isAgent = msg.from === "agent"
      await asUser(owner, (tx) =>
        sendMessage(
          tx as never,
          {
            orgId,
            userId: ownerUserId,
            threadId,
            content: msg.body,
            authorType: isAgent ? "agent" : "user",
            ...(isAgent ? { agentId: agent.id, agentAuthorLabel: agent.display_name } : {}),
            requiredScopes: [],
            metadata: {
              ...SEEDED_METADATA,
              seededAt: clock.hoursBefore(msg.hoursAgo).toISOString(),
            },
          } as never,
        ),
      )
    }
  }

  return threadIds
}

/** Room ids by title, for the titles the org has. */
export async function threadIdsByTitle(
  ctx: SeedContext,
  titles: readonly string[],
): Promise<Map<string, string>> {
  if (titles.length === 0) return new Map()
  const rows = await withPrivilegedDb(ctx.orgId, "seed-threads:by-title", (tx) =>
    tx
      .select({ id: threads.id, title: threads.title })
      .from(threads)
      .where(and(eq(threads.orgId, ctx.orgId), inArray(threads.title, [...titles]))),
  )
  return new Map(rows.map((r) => [r.title ?? "", r.id]))
}
