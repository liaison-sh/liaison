// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent archival (D16, A12): the single entry point that decides whether an
 * agent can be archived and, when it can, carries out the archive.
 *
 * This supersedes the `archiveAgent` stub landed by T04 in `base-agent.ts`
 * (the `@base` short-circuit is folded in below) so there is exactly one
 * archive entry point; `base-agent.ts` re-exports from here for its
 * existing callers/tests.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { hasScope } from "~/modules/permissions/permissions"

export const BASE_AGENT_HANDLE = "@base"
const ARCHIVE_AGENT_SCOPE = "kernel:agents:admin"

/** Thrown by archiveAgent when the actor lacks kernel:agents:admin (or '*'). */
export class ArchiveForbiddenError extends Error {
  code = "archive_forbidden"
  constructor() {
    super("Archiving an agent requires kernel:agents:admin")
    this.name = "ArchiveForbiddenError"
  }
}

/** Thrown by archiveAgent when the looked-up agent belongs to a different org
 *  than the one the caller is acting in. */
export class ArchiveCrossOrgError extends Error {
  code = "archive_cross_org"
  constructor() {
    super("Agent does not belong to the caller's org")
    this.name = "ArchiveCrossOrgError"
  }
}

/** Thrown by archiveAgent when the target is the org's `@base` system agent. */
export class BaseAgentNotArchivableError extends Error {
  code = "base_agent_not_archivable"
  constructor() {
    super("base agent is not archivable")
    this.name = "BaseAgentNotArchivableError"
  }
}

export type ArchiveBlockingRoutine = { id: string; name: string }
export type ArchiveBlockingSkill = { id: string; name: string }

/**
 * Thrown by archiveAgent when the target agent still owns a shared routine,
 * or a skill another agent's `agent_skill_index` row references. Carries the
 * blocking list rather than a generic error so a caller can render it
 * (spec-agents.md's "Archive blocked" copy: "This agent still owns skills or
 * routines. Reassign them first.").
 */
export class ArchiveBlockedError extends Error {
  code = "archive_blocked"
  routines: ArchiveBlockingRoutine[]
  skills: ArchiveBlockingSkill[]
  constructor(routines: ArchiveBlockingRoutine[], skills: ArchiveBlockingSkill[]) {
    super("This agent still owns skills or routines. Reassign them first.")
    this.name = "ArchiveBlockedError"
    this.routines = routines
    this.skills = skills
  }
}

/**
 * Blocking check for archiving `agentId`: a shared routine it owns, or a
 * skill it owns that ANOTHER agent's `agent_skill_index` row references.
 * Purely personal, unreferenced skills/routines never block.
 *
 * `orgId` is REQUIRED and both selects are filtered by it. The handle here is
 * the system one, so without that predicate the blocking list is read across
 * every org in the installation: a caller asking about an agent id that is not
 * theirs would be handed another org's routine and skill NAMES. The org check
 * belongs to the caller too (an agent of another org reads as missing), but
 * this query must not depend on the caller having made it.
 */
export async function checkArchiveBlockers(
  agentId: string,
  orgId: string,
): Promise<{
  blocked: boolean
  routines: ArchiveBlockingRoutine[]
  skills: ArchiveBlockingSkill[]
}> {
  return withSystemDb("check-archive-blockers", async (tx) => {
    const blockingRoutines = await tx
      .select({ id: routines.id, name: routines.name })
      .from(routines)
      .where(
        and(
          eq(routines.ownerAgentId, agentId),
          eq(routines.orgId, orgId),
          eq(routines.visibility, "shared"),
        ),
      )

    const blockingSkills = await tx
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .innerJoin(
        agentSkillIndex,
        and(
          eq(agentSkillIndex.skillId, skills.id),
          eq(agentSkillIndex.orgId, orgId),
          ne(agentSkillIndex.agentId, agentId),
        ),
      )
      .where(and(eq(skills.ownerAgentId, agentId), eq(skills.orgId, orgId)))

    return {
      blocked: blockingRoutines.length > 0 || blockingSkills.length > 0,
      routines: blockingRoutines,
      skills: blockingSkills,
    }
  })
}

/**
 * Archive `agentId`: `@base` can never be archived (checked first, no matter
 * what else changes). Otherwise, a shared routine or a cross-agent-
 * referenced skill blocks the archive (ArchiveBlockedError, carrying the
 * blocking list). When neither blocks, the agent's `archivedAt` is set and
 * its purely personal, unreferenced skills are disabled (`skills.enabled =
 * false`) alongside it; per-routine archival status is out of scope (no
 * `archivedAt`/`enabled` concept exists on routines yet).
 *
 * Every row this writes also gets `updatedAt = now()`, so an archive reads as
 * an edit to anything that compares `updatedAt`: the agent migration's
 * rollback refuses to undo a skill changed after it ran.
 */
export async function archiveAgent(
  orgId: string,
  agentId: string,
  actorScopes: string[],
): Promise<void> {
  if (!hasScope(ARCHIVE_AGENT_SCOPE, actorScopes)) {
    throw new ArchiveForbiddenError()
  }

  const [row] = await withSystemDb("archive-agent-lookup", async (tx) => {
    return tx.select().from(agents).where(eq(agents.id, agentId))
  })

  if (!row) return
  if (row.orgId !== orgId) {
    throw new ArchiveCrossOrgError()
  }
  if (row.handle === BASE_AGENT_HANDLE) {
    throw new BaseAgentNotArchivableError()
  }

  const blockers = await checkArchiveBlockers(agentId, row.orgId)
  if (blockers.blocked) {
    throw new ArchiveBlockedError(blockers.routines, blockers.skills)
  }

  const blockedSkillIds = new Set(blockers.skills.map((s) => s.id))

  await withPrivilegedDb(row.orgId, "archive-agent", async (tx) => {
    await tx
      .update(agents)
      .set({ archivedAt: new Date(), updatedAt: sql`now()` })
      .where(eq(agents.id, agentId))

    const ownedSkills = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.ownerAgentId, agentId))
    const unreferencedSkillIds = ownedSkills
      .map((s) => s.id)
      .filter((id) => !blockedSkillIds.has(id))

    if (unreferencedSkillIds.length > 0) {
      await tx
        .update(skills)
        .set({ enabled: false, updatedAt: sql`now()` })
        .where(inArray(skills.id, unreferencedSkillIds))
    }
  })
}
