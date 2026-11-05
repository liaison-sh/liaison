// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Cross-agent skill-index resolution (P1a-T28, seam for slice 3).
 *
 * This is the stub slice 3's `apps/api/src/modules/agent/context/context.ts`
 * composition API fills in for context assembly; slice 3 depends on this
 * function's shape (agentId, orgId) -> array of {skillId, skillName,
 * ownerAgentId}, do not change the return shape without checking slice 3's
 * blueprint first.
 */
import { inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { ensureBaseAgent } from "~/modules/agent/directory/base-agent"

export interface EffectiveSkillIndexRow {
  skillId: string
  skillName: string
  ownerAgentId: string
}

/**
 * An agent's full effective skill index: its own `agent_skill_index` rows
 * (T13) unioned with the org's `@base` agent's rows (T04's `ensureBaseAgent`,
 * read only here). `agent_knowledge_pointers`-style pointer rows are NOT
 * skills and are out of this function's scope; a knowledge lookup is a
 * separate concern.
 */
export async function resolveEffectiveSkillIndex(
  agentId: string,
  orgId: string,
): Promise<EffectiveSkillIndexRow[]> {
  const baseAgent = await ensureBaseAgent(orgId)
  const agentIds = Array.from(new Set([agentId, baseAgent.id]))

  const rows = await withPrivilegedDb(orgId, "resolve-effective-skill-index", (tx) =>
    tx.select().from(agentSkillIndex).where(inArray(agentSkillIndex.agentId, agentIds)),
  )

  return rows.map((row) => ({
    skillId: row.skillId,
    skillName: row.skillName,
    ownerAgentId: row.agentId,
  }))
}
