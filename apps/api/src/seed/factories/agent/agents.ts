// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent factory: an org's agents as the product creates them. The base
// agent and each person's personal agent through the directory's own calls,
// and a shared role agent written the way `POST /api/agents` writes it.
//
// Privileged: `kernel.agents` is privileged-write by design (its RLS policies
// grant SELECT only), so the product writes agents over the privileged
// connection too.
import { and, eq, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { pickAgentAvatarColor } from "~/modules/agent/directory/avatar-color"
import { ensureBaseAgent } from "~/modules/agent/directory/base-agent"
import { assertNoAdminScopesInRoleCeiling } from "~/modules/agent/directory/ceiling-guard"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { unknownScopes } from "~/modules/permissions/scope-registry"

export interface SeededAgent {
  agentId: string
  handle: string
  displayName: string
  kind: "role" | "personal" | "system"
  ownerKey?: string
}

/** The org's base (system) agent. */
export async function seedBaseAgent(orgId: string): Promise<SeededAgent> {
  const base = await ensureBaseAgent(orgId)
  return { agentId: base.id, handle: base.handle, displayName: base.displayName, kind: "system" }
}

/** A person's personal agent, created on first call and adopted after. */
export async function seedPersonalAgent(
  orgId: string,
  userId: string,
  fallbackHandle: string,
): Promise<{ agentId: string; handle: string; displayName: string }> {
  const agentId = await withSystemDb("seed-personal-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  const [row] = await withSystemDb("seed-personal-agent-read", (tx) =>
    tx
      .select({ handle: agents.handle, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  )
  return {
    agentId,
    handle: row?.handle ?? fallbackHandle,
    displayName: row?.displayName ?? "Liaison",
  }
}

/** Pin one agent to a model. Its write time is the database's clock. */
export async function pinAgentModel(agentId: string, modelPreference: string): Promise<void> {
  await withSystemDb("seed-agent-model-pin", (tx) =>
    tx.update(agents).set({ modelPreference, updatedAt: sql`now()` }).where(eq(agents.id, agentId)),
  )
}

export interface RoleAgentSpec {
  handle: string
  displayName: string
  purpose: string
  systemPrompt: string
  /** The scopes the agent may hold; any no app or the kernel declares is dropped. */
  scopes: readonly string[]
  toolAllowlist: string[] | null
  modelPreference: string | null
}

/**
 * Create a shared role agent, or rewrite the one already answering under its
 * handle. Same columns and `(orgId, handle)` conflict target as
 * `POST /api/agents`, so a re-seed adopts the row instead of duplicating it.
 *
 * UPDATE on conflict, not DO NOTHING: re-running the seed has to reset what an
 * agent SAYS (prompt, purpose, ceiling, model), not only how many rows exist.
 * The colour is picked on insert only, so a re-seed keeps the one it wears.
 */
export async function upsertRoleAgent(orgId: string, spec: RoleAgentSpec): Promise<SeededAgent> {
  // A ceiling may only name scopes an installed app or the kernel declares
  // (`assertNoAdminScopesInRoleCeiling` refuses the rest): the undeclared ones
  // are dropped here. Apps are installed first, so the registry is populated.
  const scopeCeiling = spec.scopes.filter((scope) => unknownScopes([scope]).length === 0)
  assertNoAdminScopesInRoleCeiling("role", scopeCeiling)
  const { modelPreference } = spec
  const row = await withSystemDb("seed-role-agent", async (tx) => {
    const [inserted] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "role",
        handle: spec.handle,
        displayName: spec.displayName,
        purpose: spec.purpose,
        systemPrompt: spec.systemPrompt,
        scopeCeiling,
        toolAllowlist: spec.toolAllowlist,
        modelPreference,
        avatarColor: await pickAgentAvatarColor(tx, orgId),
      })
      .onConflictDoUpdate({
        target: [agents.orgId, agents.handle],
        set: {
          displayName: spec.displayName,
          purpose: spec.purpose,
          systemPrompt: spec.systemPrompt,
          scopeCeiling,
          toolAllowlist: spec.toolAllowlist,
          modelPreference,
          updatedAt: sql`now()`,
        },
      })
      .returning()
    if (inserted) return inserted
    const [existing] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, spec.handle)))
      .limit(1)
    return existing
  })
  if (!row) throw new Error(`seed: role agent ${spec.handle} neither inserted nor found`)
  return { agentId: row.id, handle: row.handle, displayName: row.displayName, kind: "role" }
}
