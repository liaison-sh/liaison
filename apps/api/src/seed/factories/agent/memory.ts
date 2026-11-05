// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent memory factory: the entries an agent has written while working,
// and the conversations it remembers, each through the product's own writer.
//
//   * Entries go through `handleMemorySet`, under the writer's RLS context,
//     so the reserved `MEMORY.md` index row an agent turn reads is rebuilt
//     exactly as a real write rebuilds it, stamped with `ctx.now` (the
//     writer's `now`) rather than the wall clock.
//   * Remembered conversations go through `writeEpisode`, the one call
//     consolidation's `writeEpisodeForRegion` ends in: the `episode` row at
//     `episodes/<thread handle>/<day>.md` with `source_kind = 'consolidation'`
//     and the `source_thread_id` Forget deletes on, plus its `MEMORY.md`
//     folder line. Consolidation closes an episode off a background job hours
//     after a conversation goes quiet, so this is history only time produces.
//
// Privileged: the exact episode path is deleted before it is rewritten
// (`writeEpisode` always inserts and suffixes a same-day collision, so a
// re-seed would otherwise grow a file per run), and the thread checkpoint
// version that Forget deletes beside an episode is inserted ON CONFLICT DO
// NOTHING (version rows are immutable by trigger once written), both as the
// consolidation job writes them, over the privileged connection.
import { and, asc, desc, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agentMemory } from "~/db/schema/kernel/agent-memory"
import { agentThreadCheckpoints } from "~/db/schema/kernel/agent-thread-checkpoints"
import { messages } from "~/db/schema/kernel/threads"
import { handleMemorySet, writeEpisode } from "~/modules/agent/memory/memory"
import type { SeedContext } from "~/seed/context"
import { personActor } from "./presence"

const DAY_MS = 86_400_000

export interface MemoryEntrySeed {
  /** The agent whose memory tree the entry lives in. */
  ownerAgentId: string
  type: "user" | "feedback" | "project" | "reference"
  name: string
  description: string
  content: string
}

/**
 * Memory entries written as `writerUserId` (who must be allowed to write each
 * owning agent's memory: an admin for role agents), addressed at the agent's
 * tree through `ownerAgentId`. Entries carry no scoped data and gate on nothing.
 */
export async function seedMemoryEntries(
  ctx: SeedContext,
  input: { writerUserId: string; entries: readonly MemoryEntrySeed[] },
): Promise<void> {
  const actor = await personActor(ctx, input.writerUserId)
  for (const spec of input.entries) {
    await withRlsContext(actor, (tx) =>
      handleMemorySet(
        {
          type: spec.type,
          name: spec.name,
          description: spec.description,
          content: spec.content,
        },
        {
          userId: input.writerUserId,
          orgId: ctx.orgId,
          db: tx as never,
          scopes: actor.scopes,
          ownerAgentId: spec.ownerAgentId,
          // The seed clock, not the wall clock: the row and its `MEMORY.md`
          // line carry the tier's base time, so a fixed base time reproduces them.
          now: ctx.now,
        } as never,
        [],
      ),
    )
  }
}

export interface EpisodeSeed {
  agentId: string
  /** The tree owner's legacy id: the person for a personal agent, null for a role agent. */
  ownerLegacyUserId: string | null
  /** Who writes it: the agent's owner for a personal agent, an admin otherwise. */
  writerUserId: string
  thread: { id: string; handle: string }
  /** Days before `ctx.now` the room went quiet and the job closed it. */
  daysAgo: number
  body: string
  /** The agent's rolling summary of the room, as a checkpoint version. */
  checkpoint: string
}

/** Remembered conversations with their checkpoints. Returns each episode's path. */
export async function seedRememberedConversations(
  ctx: SeedContext,
  episodes: readonly EpisodeSeed[],
): Promise<string[]> {
  const { orgId } = ctx
  const actors = new Map<string, Awaited<ReturnType<typeof personActor>>>()
  const actorFor = async (userId: string) => {
    const known = actors.get(userId)
    if (known) return known
    const actor = await personActor(ctx, userId)
    actors.set(userId, actor)
    return actor
  }

  const paths: string[] = []
  for (const spec of episodes) {
    const room = spec.thread
    const closedAt = new Date(ctx.now.getTime() - spec.daysAgo * DAY_MS)
    const closedOn = closedAt.toISOString().slice(0, 10)
    const path = `episodes/${room.handle}/${closedOn}.md`

    // The region the episode covers, named the way the real writer names it:
    // the first and the last message of the conversation, or null for a room
    // with no message yet.
    const [first, last] = await withPrivilegedDb(orgId, "seed-episode-region", async (tx) => {
      const inRoom = and(eq(messages.orgId, orgId), eq(messages.threadId, room.id))
      const [a] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(inRoom)
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(1)
      const [z] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(inRoom)
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1)
      return [a?.id ?? null, z?.id ?? null] as const
    })

    await withPrivilegedDb(orgId, "seed-episode-reset", (tx) =>
      tx
        .delete(agentMemory)
        .where(
          and(
            eq(agentMemory.orgId, orgId),
            eq(agentMemory.ownerAgentId, spec.agentId),
            eq(agentMemory.type, "episode"),
            eq(agentMemory.path, path),
          ),
        ),
    )

    const writer = await actorFor(spec.writerUserId)
    await withRlsContext(writer, (tx) =>
      writeEpisode(
        {
          threadId: room.id,
          threadHandle: room.handle,
          closedOn,
          // Byte for byte the description `writeEpisodeForRegion` builds.
          description: `Conversation in ${room.handle} on ${closedOn}`,
          body: spec.body,
          fromMessageId: first,
          toMessageId: last,
        },
        {
          userId: writer.userId,
          orgId,
          db: tx as never,
          scopes: writer.scopes,
          ownerAgentId: spec.agentId,
          ownerLegacyUserId: spec.ownerLegacyUserId,
          // The job's own provenance, not a human edit and not an agent tool call.
          sourceKind: "consolidation",
          // Written when the job closed the room, on the seed clock.
          now: closedAt,
        } as never,
        [],
      ),
    )

    await withPrivilegedDb(orgId, "seed-episode-checkpoint", (tx) =>
      tx
        .insert(agentThreadCheckpoints)
        .values({
          orgId,
          agentId: spec.agentId,
          threadId: room.id,
          uptoMessageId: last,
          summary: spec.checkpoint,
          requiredScopes: [],
          // The estimator's own rule of thumb, four characters to a token.
          tokenEstimate: Math.ceil(spec.checkpoint.length / 4),
          version: 1,
          flushedAt: closedAt,
        })
        .onConflictDoNothing({
          target: [
            agentThreadCheckpoints.agentId,
            agentThreadCheckpoints.threadId,
            agentThreadCheckpoints.version,
          ],
        }),
    )
    paths.push(path)
  }
  return paths
}
