// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent presence factory: what makes an agent read as somebody at work
// rather than a blank page. A person's personal agent looked up by its owner,
// that person's direct messages with it (through the product's own
// find-or-create), an agent's recorded purpose, and its seats in the
// conversations it works in; plus the org's titled conversations, which the
// other agent factories resolve a spec's room by.
//
// Privileged: `kernel.agents` is privileged-write by design (its RLS policies
// grant SELECT only), and an agent's seat in a room is written the way the
// kernel seats an agent participant. The direct messages are opened under the
// person's own RLS context.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { threadParticipants, threads } from "~/db/schema/kernel/threads"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"

/** A person's RLS actor in the org, from their effective permissions. */
export async function personActor(ctx: SeedContext, userId: string) {
  const perms = await withPrivilegedDb(ctx.orgId, "seed-person-actor", (tx) =>
    loadEffectivePermissions(tx, userId, ctx.orgId),
  )
  return {
    actorType: "user" as const,
    userId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}

/** The personal agent `userId` owns, or null when they have none. */
export async function personalAgentOf(ctx: SeedContext, userId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(ctx.orgId, "seed-personal-agent-of", (tx) =>
    tx
      .select({ id: agents.id })
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
  return row?.id ?? null
}

/**
 * `userId`'s direct messages with `agentId`, found or opened through the
 * product's own find-or-create, so the conversation "Message" opens is this one.
 */
export async function agentDmWith(
  ctx: SeedContext,
  userId: string,
  agentId: string,
): Promise<string> {
  const actor = await personActor(ctx, userId)
  const dm = await withRlsContext(actor, (tx) =>
    createOrGetAgentDm(tx as never, { orgId: ctx.orgId, userId, agentId }),
  )
  if (!dm) throw new Error("agent presence seed: the agent has no direct messages")
  return dm.id
}

/** Every titled conversation in the org, by title. */
export async function threadsByTitle(
  ctx: SeedContext,
): Promise<Map<string, { id: string; handle: string }>> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-threads-by-title", (tx) =>
    tx
      .select({ id: threads.id, handle: threads.handle, title: threads.title })
      .from(threads)
      .where(and(eq(threads.orgId, ctx.orgId), isNotNull(threads.title))),
  )
  const out = new Map<string, { id: string; handle: string }>()
  for (const r of rows) if (r.title !== null) out.set(r.title, { id: r.id, handle: r.handle })
  return out
}

/** Record what an agent is for. */
export async function describeAgent(
  ctx: SeedContext,
  agentId: string,
  purpose: string,
): Promise<void> {
  await withPrivilegedDb(ctx.orgId, "seed-agent-purpose", (tx) =>
    tx
      .update(agents)
      .set({ purpose, updatedAt: sql`now()` })
      .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, agentId))),
  )
}

/**
 * Seat an agent, as a member, in the org's conversations with these titles.
 * A seat it already has stands. Returns how many of the titles were found.
 */
export async function seatAgentInThreads(
  ctx: SeedContext,
  agentId: string,
  titles: readonly string[],
): Promise<number> {
  return withPrivilegedDb(ctx.orgId, "seed-agent-seats", async (tx) => {
    const found = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.orgId, ctx.orgId), inArray(threads.title, [...titles])))
    for (const room of found) {
      await tx
        .insert(threadParticipants)
        .values({
          threadId: room.id,
          orgId: ctx.orgId,
          participantType: "agent",
          agentId,
          role: "member",
        })
        .onConflictDoNothing({
          target: [threadParticipants.threadId, threadParticipants.agentId],
          where: sql`agent_id IS NOT NULL`,
        })
    }
    return found.length
  })
}
