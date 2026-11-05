// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Kernel-maintained `agent_skill_index` maintenance (D9, T13).
 *
 * The index is writable only through this module's two functions, called by
 * the skill mutation service (`~/modules/agent/tools/skills-routines-tools`) in
 * the SAME `withPrivilegedDb` transaction as the skill write it mirrors, so
 * the index is never observably stale to a subsequent read in this process.
 * `agent_skill_index` has no INSERT/UPDATE/DELETE RLS policy at all
 * (migration 0049) — every write here goes through the privileged
 * (BYPASSRLS) connection by construction; there is no other write path.
 */
import { eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"

/**
 * Upsert the `agent_skill_index` row for a skill, keyed by `(ownerAgentId,
 * skillName)`. A rename changes that key, so any existing row for this
 * `skillId` (under its old name) is removed first — this keeps a rename from
 * leaving two rows (old name + new name) behind, and makes this function the
 * single call a create OR an update needs.
 *
 * No-ops when `ownerAgentId` is null: `skills.owner_agent_id` is nullable
 * during the migration-sequencing transition (0046/T05), and a skill with no
 * owning agent has nothing to key the index by yet.
 */
export async function upsertSkillIndexRow(
  tx: PrivilegedDb,
  params: { orgId: string; ownerAgentId: string | null; skillId: string; skillName: string },
): Promise<void> {
  if (!params.ownerAgentId) return
  await tx.delete(agentSkillIndex).where(eq(agentSkillIndex.skillId, params.skillId))
  await tx
    .insert(agentSkillIndex)
    .values({
      orgId: params.orgId,
      agentId: params.ownerAgentId,
      skillId: params.skillId,
      skillName: params.skillName,
    })
    .onConflictDoUpdate({
      target: [agentSkillIndex.agentId, agentSkillIndex.skillName],
      set: { skillId: params.skillId, orgId: params.orgId },
    })
}

/** Delete the `agent_skill_index` row for a deleted (or disabled) skill. */
export async function removeSkillIndexRow(tx: PrivilegedDb, skillId: string): Promise<void> {
  await tx.delete(agentSkillIndex).where(eq(agentSkillIndex.skillId, skillId))
}
