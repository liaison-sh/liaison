// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * User offboarding (D16, A12): archives the user's personal agent and pauses
 * (never deletes) its routines, unless a blocking asset first requires an
 * admin transfer.
 *
 * Per A12 ("the blocking check above forces reassignment ... before the
 * archive"), this runs T25's `checkArchiveBlockers` FIRST. When blocked, the
 * personal agent is left untouched and the report names exactly which
 * routines/skills need an admin transfer; the transfer UI itself is out of
 * this slice's scope (EXPANSION-PROGRESS.md gives 1a no UI files) and is a
 * future consumer of this report.
 */
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { hasScope } from "~/modules/permissions/permissions"
import type { ArchiveBlockingRoutine, ArchiveBlockingSkill } from "./archive"
import { checkArchiveBlockers } from "./archive"

const OFFBOARD_SCOPE = "kernel:users:admin"

/** Thrown by offboardUser when the actor lacks kernel:users:admin (or '*'). */
export class OffboardForbiddenError extends Error {
  code = "offboard_forbidden"
  constructor() {
    super("Offboarding a user requires kernel:users:admin")
    this.name = "OffboardForbiddenError"
  }
}

/** Thrown by offboardUser when the target user's personal agent belongs to a
 *  different org than the one the caller is acting in. */
export class OffboardCrossOrgError extends Error {
  code = "offboard_cross_org"
  constructor() {
    super("User does not belong to the caller's org")
    this.name = "OffboardCrossOrgError"
  }
}

export interface OffboardReport {
  archived: boolean
  agentId: string | null
  blockingRoutines: ArchiveBlockingRoutine[]
  blockingSkills: ArchiveBlockingSkill[]
}

/**
 * Offboard `userId`: locates their personal agent, checks for blocking
 * assets, and either archives the agent (pausing its routines with
 * `status = 'paused_user'`) or returns the blocking list untouched.
 *
 * `actorScopes` must include `kernel:users:admin` (or `*`) — offboarding is
 * an admin action like `archiveAgent`'s (OffboardForbiddenError otherwise).
 * `orgId` must match the target user's personal agent's org — a caller
 * cannot offboard a user belonging to a different org.
 *
 * A user with no personal agent is a no-op report (`archived: false,
 * agentId: null`), since there is nothing to archive.
 */
export async function offboardUser(
  orgId: string,
  userId: string,
  actorScopes: string[],
): Promise<OffboardReport> {
  if (!hasScope(OFFBOARD_SCOPE, actorScopes)) {
    throw new OffboardForbiddenError()
  }

  const [agentRow] = await withSystemDb("offboard-find-personal-agent", (tx) =>
    tx.select().from(agents).where(eq(agents.ownerUserId, userId)),
  )

  if (agentRow && agentRow.orgId !== orgId) {
    throw new OffboardCrossOrgError()
  }

  if (!agentRow) {
    return { archived: false, agentId: null, blockingRoutines: [], blockingSkills: [] }
  }

  const blockers = await checkArchiveBlockers(agentRow.id, agentRow.orgId)
  if (blockers.blocked) {
    return {
      archived: false,
      agentId: agentRow.id,
      blockingRoutines: blockers.routines,
      blockingSkills: blockers.skills,
    }
  }

  await withPrivilegedDb(agentRow.orgId, "offboard-archive-agent", async (tx) => {
    await tx.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, agentRow.id))
    await tx
      .update(routines)
      .set({ status: "paused_user" })
      .where(eq(routines.ownerAgentId, agentRow.id))
  })

  return { archived: true, agentId: agentRow.id, blockingRoutines: [], blockingSkills: [] }
}
