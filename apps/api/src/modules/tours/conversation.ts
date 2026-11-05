// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The conversation a guided tour run talks to the person's agent in, for a
 * tour that talks to it (`talksToAgent`: the demo scenarios and the app tours
 * that ask the agent): the person's one conversation with their own agent,
 * the DM "Message" and the Chats list open, made when missing. A run never
 * starts another one: it carries on in that DM like the person would, earlier
 * turns included.
 *
 * A tour naming an org agent (`agent`, a handle) talks to that agent
 * instead: the person's one DM with it, found or made the same way.
 *
 * The start route and the CLI call `runConversationId` before `startTour`,
 * which records the id on the run (`RUN_CONVERSATION`).
 */
import type { Tour } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createOrGetAgentDm } from "~/modules/threads/thread"

/** The run's conversation for a tour that talks to an agent; undefined for one that does not. */
export async function runConversationId(
  orgId: string,
  userId: string,
  tour: Pick<Tour, "talksToAgent" | "agent">,
): Promise<string | undefined> {
  if (!tour.talksToAgent) return undefined
  return tour.agent ? orgAgentDmId(orgId, userId, tour.agent) : personalAgentDmId(orgId, userId)
}

export async function personalAgentDmId(orgId: string, userId: string): Promise<string> {
  return agentDmId(orgId, userId, (tx) => getOrCreatePersonalAgentId(tx, { orgId, userId }))
}

/** The person's DM with the org agent `handle` (`@operations`); refuses when the org has none. */
async function orgAgentDmId(orgId: string, userId: string, handle: string): Promise<string> {
  return agentDmId(orgId, userId, async (tx) => {
    const [row] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, handle)))
      .limit(1)
    if (!row) throw new Error(`No agent ${handle} in this org for the tour to talk to`)
    return row.id
  })
}

type PrivilegedTx = Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]

async function agentDmId(
  orgId: string,
  userId: string,
  findAgent: (tx: PrivilegedTx) => Promise<string>,
): Promise<string> {
  const { agentId, perms } = await withPrivilegedDb(orgId, "tour-run-conversation", async (tx) => ({
    agentId: await findAgent(tx),
    perms: await loadEffectivePermissions(tx, userId, orgId),
  }))
  // Found or made as the person, under their own row-level rules, like "Message".
  const asPerson = {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
  const dm = await withRlsContext(asPerson, (tx) =>
    createOrGetAgentDm(tx, { orgId, userId, agentId }),
  )
  if (!dm) throw new Error(`No conversation could be opened with agent ${agentId}`)
  return dm.id
}
