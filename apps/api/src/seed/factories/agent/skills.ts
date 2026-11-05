// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The skills factory: an org's shared playbooks, each owned by the agent that
// curates it, written with its `agent_skill_index` mirror in the same
// transaction exactly as `handleCreateSkill` does, and converged on content
// (a re-seed restores a body that drifted).
//
// Privileged: `kernel.skills` and its index are written by the kernel's skill
// tools over the privileged connection too (the index is the kernel's own
// mirror). Also here: re-pointing a still-unedited pending skill approval at
// the row it edits, and retiring the skills and routines a seeder wrote that
// its current spec no longer declares.
import { and, eq, notInArray, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { upsertSkillIndexRow } from "~/modules/agent/skills/skill-index"
import type { SeedContext } from "~/seed/context"

export interface SkillSeed {
  /** Kebab case, unique per owning agent. */
  name: string
  /** At most 100 characters (DB check constraint). */
  description: string
  /** The routing slug a scoped skill approval is decided against. */
  domain: string
  ownerAgentId: string
  /** Only a caller holding all of these is handed the playbook. */
  requiredScopes: string[]
  /** `auto_attach.keywords` and `auto_attach.apps`. */
  keywords: string[]
  apps: string[]
  body: string
}

/** The id a skill is first inserted under: what another layer's approval names it by. */
export function skillId(ctx: SeedContext, name: string): string {
  return ctx.id("skill", name)
}

/**
 * Org shared skills (`author_user_id` NULL, so every person's agent is handed
 * them), converged on `(owner_agent_id, name)`. Returns id by name.
 */
export async function seedOrgSkills(
  ctx: SeedContext,
  input: { createdByUserId: string; skills: readonly SkillSeed[] },
): Promise<Record<string, string>> {
  const byName: Record<string, string> = {}
  for (const spec of input.skills) {
    const row = await withPrivilegedDb(ctx.orgId, "seed-skill", async (tx: PrivilegedDb) => {
      const autoAttach = { keywords: spec.keywords, apps: spec.apps }
      const [inserted] = await tx
        .insert(skills)
        .values({
          // The id another layer's approvals may already name: inserting under
          // it makes such an approval resolve instead of failing "Skill not
          // found" on Approve.
          id: skillId(ctx, spec.name),
          orgId: ctx.orgId,
          ownerAgentId: spec.ownerAgentId,
          // NULL is the org shared shape. A user id here would make the
          // playbook personal to one person and invisible to everybody else.
          authorUserId: null,
          name: spec.name,
          description: spec.description,
          body: spec.body,
          domain: spec.domain,
          requiredScopes: spec.requiredScopes,
          autoAttach,
          enabled: true,
          createdByUserId: input.createdByUserId,
          createdByActorType: "user",
        })
        .onConflictDoUpdate({
          target: [skills.ownerAgentId, skills.name],
          set: {
            description: spec.description,
            body: spec.body,
            domain: spec.domain,
            requiredScopes: spec.requiredScopes,
            autoAttach,
            authorUserId: null,
            enabled: true,
            updatedAt: sql`now()`,
          },
        })
        .returning()
      if (!inserted) throw new Error(`skills seed: skill '${spec.name}' not returned`)
      await upsertSkillIndexRow(tx, {
        orgId: ctx.orgId,
        ownerAgentId: spec.ownerAgentId,
        skillId: inserted.id,
        skillName: inserted.name,
      })
      return inserted
    })
    byName[spec.name] = row.id
  }
  await repointSkillApprovals(ctx, byName)
  return byName
}

/**
 * A pending `kernel:update_skill` approval names the skill it edits by the
 * stable id `seedOrgSkills` inserts under. An org whose skill row predates
 * that id (adopted by the conflict target) keeps its own id: re-point the
 * still-unedited payloads at the real row.
 */
async function repointSkillApprovals(
  ctx: SeedContext,
  byName: Record<string, string>,
): Promise<void> {
  const moves = Object.entries(byName)
    .map(([name, id]) => ({ from: skillId(ctx, name), to: id }))
    .filter((m) => m.from !== m.to)
  if (moves.length === 0) return
  await withPrivilegedDb(ctx.orgId, "seed-skill-approvals", async (tx: PrivilegedDb) => {
    for (const m of moves) {
      await tx
        .update(approvalRequests)
        .set({
          toolParams: sql`jsonb_set(${approvalRequests.toolParams}, '{id}', to_jsonb(${m.to}::text))`,
          currentPayload: sql`jsonb_set(${approvalRequests.currentPayload}, '{id}', to_jsonb(${m.to}::text))`,
        })
        .where(
          and(
            eq(approvalRequests.orgId, ctx.orgId),
            eq(approvalRequests.toolName, "kernel:update_skill"),
            eq(approvalRequests.status, "pending"),
            sql`${approvalRequests.currentPayload} ->> 'id' = ${m.from}`,
            sql`${approvalRequests.currentPayload} = ${approvalRequests.toolParams}`,
          ),
        )
    }
  })
}

/**
 * Delete the skills and routines `createdByUserId` wrote whose names the
 * current spec no longer declares. Only rows stamped with that creator are
 * touched, so a skill or a routine somebody wrote themselves never is.
 * Returns the names removed.
 */
export async function pruneRetiredSkillsAndRoutines(
  ctx: SeedContext,
  input: { createdByUserId: string; skillNames: string[]; routineNames: string[] },
): Promise<string[]> {
  return withPrivilegedDb(ctx.orgId, "seed-agent-prune", async (tx) => {
    const goneSkills = await tx
      .delete(skills)
      .where(
        and(
          eq(skills.orgId, ctx.orgId),
          eq(skills.createdByUserId, input.createdByUserId),
          notInArray(skills.name, input.skillNames),
        ),
      )
      .returning({ name: skills.name })
    const goneRoutines = await tx
      .delete(routines)
      .where(
        and(
          eq(routines.orgId, ctx.orgId),
          eq(routines.createdByUserId, input.createdByUserId),
          notInArray(routines.name, input.routineNames),
        ),
      )
      .returning({ name: routines.name })
    return [...goneSkills.map((r) => r.name), ...goneRoutines.map((r) => r.name)]
  })
}
