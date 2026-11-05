// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type Agent, agents } from "~/db/schema/kernel/agents"

/**
 * `@base` is the org's built-in `kind='system'` agent (base-agent.ts). It
 * stays a visible row for admin purposes but is excluded from any list of
 * DM-able or mentionable agents at read time (A1, spec-agents.md): this is
 * a read-time filter, not an RLS policy change. Filtering on `kind !=
 * 'system'` rather than the literal handle `@base` generalizes if a second
 * system agent is ever added.
 */
function rlsCtx(userId: string, orgId: string): UserContext {
  return { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
}

/**
 * THE ONE PREDICATE every addressable-agent read shares (A41).
 *
 * Live, this org's, not a `kind='system'` row, AND, since the agent pages
 * exist, not a personal agent somebody else owns: a personal agent is one
 * colleague's own Liaison, and the rest of the org has no business addressing
 * it, mentioning it or seeing that it exists. Its owner sees it here; an
 * ADMIN sees it through `kernel:agents:read`, which is a route-level decision
 * (the routes hold the caller's scopes, this module does not) and never a
 * widening of this predicate.
 */
function addressableAgents(orgId: string, userId: string): SQL | undefined {
  return and(
    eq(agents.orgId, orgId),
    ne(agents.kind, "system"),
    isNull(agents.archivedAt),
    or(ne(agents.kind, "personal"), eq(agents.ownerUserId, userId)),
  )
}

/**
 * The DIRECTORY's predicate (P4c FX-F3): `addressableAgents` plus, for an
 * admin only, the `kind='system'` row.
 *
 * The agents directory is not an addressing surface. It is the roster, and
 * `@base` is a real row of it: spec-agents.md keeps the system agent VISIBLE
 * for admin purposes (the directory draws it dimmed, with no DM and no other
 * action) while it stays out of every list of agents a person can address.
 * Without it `/agents/@base` resolves to nothing at all and the dimmed card
 * is permanently empty.
 *
 * Deliberately a SECOND predicate rather than a widening of
 * `addressableAgents`: the DM picker and mention completion call the
 * addressable one and must keep excluding `@base` whoever is asking.
 */
function directoryAgents(orgId: string, userId: string, includeSystem: boolean): SQL | undefined {
  if (!includeSystem) return addressableAgents(orgId, userId)
  return and(
    eq(agents.orgId, orgId),
    isNull(agents.archivedAt),
    or(ne(agents.kind, "personal"), eq(agents.ownerUserId, userId)),
  )
}

/**
 * The agents the DIRECTORY lists for this caller. `includeSystem` is the
 * route's decision, taken from the caller's scopes (`kernel:agents:admin`):
 * this module never sees a scope, exactly as with `kernel:agents:read` above.
 */
export async function listDirectoryAgents(
  orgId: string,
  userId: string,
  opts?: { includeSystem?: boolean },
): Promise<Agent[]> {
  const includeSystem = opts?.includeSystem === true
  return withRlsContext(rlsCtx(userId, orgId), async (tx) => {
    return tx
      .select()
      .from(agents)
      .where(directoryAgents(orgId, userId, includeSystem))
  })
}

/**
 * Agents a user can open a DM with: every agent in their org except the
 * `kind='system'` ones (currently only `@base`) and except another
 * colleague's personal agent. RLS already scopes the underlying `agents`
 * SELECT to the org.
 */
export async function listDmableAgents(orgId: string, userId: string): Promise<Agent[]> {
  return withRlsContext(rlsCtx(userId, orgId), async (tx) => {
    return tx.select().from(agents).where(addressableAgents(orgId, userId))
  })
}

/**
 * Agents offered by `@`-mention completion: same exclusion as
 * listDmableAgents, kept as a separate export since the two call sites
 * (DM picker, mention completion) are independent of each other even
 * though the filter is identical today.
 */
export async function listMentionableAgents(orgId: string, userId: string): Promise<Agent[]> {
  return withRlsContext(rlsCtx(userId, orgId), async (tx) => {
    return tx.select().from(agents).where(addressableAgents(orgId, userId))
  })
}

/**
 * Whether ONE agent is in that listing for that user, asked without reading
 * the whole roster. Same predicate as `listMentionableAgents`, so a caller
 * that gates on "an agent this person could have addressed" (the desktop's
 * local claim, A31) cannot drift from what the mention picker offers.
 */
export async function isMentionableAgent(
  orgId: string,
  userId: string,
  agentId: string,
): Promise<boolean> {
  return withRlsContext(rlsCtx(userId, orgId), async (tx) => {
    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), addressableAgents(orgId, userId)))
      .limit(1)
    return rows.length > 0
  })
}
