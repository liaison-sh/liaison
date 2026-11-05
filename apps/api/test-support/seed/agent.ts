// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent-side factories for /api/_test/seed: the model pricing catalog and an
// org's credit balance, a person's scope taken away and given back, a personal
// agent's ceiling recomputed, an agent conversation, a delegate role and a
// routine's run history. Each goes through the product's own service (the
// boot pricing seed, the credit service, the role editor, the ceiling
// recompute, createThread, createSubAgentDefinition) or the seed engine.
import { BOOTSTRAP_ECB_RATE } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { userRoles } from "~/db/schema/kernel"
import { routineRuns } from "~/db/schema/kernel/routine-runs"
import { routines } from "~/db/schema/kernel/routines"
import { persistEcbRate } from "~/infra/jobs/sync-model-pricing"
import { seedModelPricing } from "~/infra/seed-model-pricing"
import { addCredits, checkBalance, initOrgCredits } from "~/modules/agent/credits/credit-service"
import { recomputePersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import {
  grantRoleScopes,
  grantUserScope,
  revokeScope,
  revokeUserScope,
} from "~/modules/permissions/roles"
import { createThread } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"
import { type RoutineRunSeed, seedRoutineRuns } from "~/seed/factories/agent/routine-runs"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { asAdmin } from "~/seed/factories/people/scoped-role"
import { orgAdmin } from "~/seed/tiers/minimal"

/**
 * The global model pricing catalog as the server seeds it at boot (a test
 * stack's reset empties it), and the bootstrap USD to EUR rate stored as the
 * current one, so no price conversion fetches the ECB.
 */
export async function seedPricingCatalog(): Promise<{ seeded: true }> {
  await seedModelPricing()
  await persistEcbRate(BOOTSTRAP_ECB_RATE.rate)
  return { seeded: true }
}

/**
 * Set the org's credit balance to exactly `included` and `purchased`, through
 * the credit service: a monthly reset sets the included allowance, a top up
 * (or a refund, for less) moves the purchased balance to the target. The
 * ledger records both, as it would for the real movements.
 */
export async function setCreditBalance(
  ctx: SeedContext,
  input: { included: string; purchased: string; key: string },
): Promise<{ included: string; purchased: string }> {
  const { orgId } = ctx
  const reset = { amount: input.included, type: "monthly_reset" as const }
  try {
    await addCredits(orgId, reset)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("No credit_balances row")) throw err
    await initOrgCredits(orgId, "EUR", input.included)
  }
  const now = await withPrivilegedDb(orgId, "seed-credit-balance-read", (tx) =>
    checkBalance(tx, orgId),
  )
  const delta = Number(input.purchased) - Number(now.purchased)
  if (Math.abs(delta) >= 1e-8) {
    await addCredits(orgId, {
      amount: delta.toFixed(8),
      type: delta > 0 ? "top_up" : "refund",
      description: "test seed balance",
      externalPaymentRef: `seed-${input.key}`,
    })
  }
  const after = await withPrivilegedDb(orgId, "seed-credit-balance-read", (tx) =>
    checkBalance(tx, orgId),
  )
  return { included: after.included, purchased: after.purchased }
}

/**
 * Take `scope` away from the person, as the org's admin through the role
 * editor: off every role they hold that grants it exactly (which takes it from
 * that role's other holders too, as the editor would) and their own direct
 * grant. Returns what `restoreScope` puts back.
 */
export async function revokePersonScope(
  ctx: SeedContext,
  input: { userId: string; scope: string },
): Promise<{ roleIds: string[]; direct: boolean }> {
  const admin = await orgAdmin(ctx.orgId)
  const result = await asAdmin(ctx.orgId, admin.id, async (tx, actor) => {
    const held = await tx
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, input.userId), eq(userRoles.orgId, ctx.orgId)))
    const roleIds: string[] = []
    for (const { roleId } of held) {
      const deleted = await revokeScope(tx, { roleId, scope: input.scope, ...actor })
      if (deleted) roleIds.push(roleId)
    }
    const direct = await revokeUserScope(tx, {
      userId: input.userId,
      scope: input.scope,
      ...actor,
    })
    return { roleIds, direct: direct !== null }
  })
  invalidateAuthCache(input.userId)
  return result
}

/** Give back what `revokePersonScope` took: the scope on those roles, and the direct grant. */
export async function restorePersonScope(
  ctx: SeedContext,
  input: { userId: string; scope: string; roleIds: string[]; direct: boolean },
): Promise<{ restored: true }> {
  const admin = await orgAdmin(ctx.orgId)
  await asAdmin(ctx.orgId, admin.id, async (tx, actor) => {
    for (const roleId of input.roleIds) {
      await grantRoleScopes(tx, { roleId, scopes: [input.scope], ...actor })
    }
    if (input.direct) {
      await grantUserScope(tx, { userId: input.userId, scope: input.scope, ...actor })
    }
  })
  invalidateAuthCache(input.userId)
  return { restored: true }
}

/**
 * Recompute the person's own agent's ceiling from their current grants, the
 * recompute every grant change runs (as the org's admin).
 */
export async function alignOwnAgentCeiling(
  ctx: SeedContext,
  userId: string,
): Promise<{ aligned: true }> {
  const admin = await orgAdmin(ctx.orgId)
  await asAdmin(ctx.orgId, admin.id, (tx) =>
    recomputePersonalAgentCeiling(tx, { userId, orgId: ctx.orgId }),
  )
  return { aligned: true }
}

/** A new agent conversation (`agent_chat`) the person starts, with them as its only participant. */
export async function seedAgentChat(ctx: SeedContext, userId: string): Promise<{ id: string }> {
  const actor = await actorFor(ctx, userId)
  const created = await asUser(actor, (tx) =>
    createThread(
      tx as never,
      {
        orgId: ctx.orgId,
        userId,
        participantIds: [userId],
        type: "agent_chat",
        forceCreate: true,
      } as never,
    ),
  )
  return { id: (created as { id: string }).id }
}

/**
 * A delegate role through `createSubAgentDefinition` (upsert on the org and
 * agent type). An app-owned role is capped by the app's scopes; a kernel one
 * by the org admin's.
 */
export async function seedSubAgentDefinition(
  ctx: SeedContext,
  input: {
    appName?: string
    agentType: string
    whenToUse: string
    scopeCeiling: string[]
    toolAllowlist?: string[]
    toolDenylist?: string[]
    skills?: string[]
    mcpServers?: string[]
    systemPrompt: string
    defaultMaxSteps?: number
    defaultTimeoutMs?: number
    defaultSchemaRetryBudget?: number
  },
): Promise<{ id: string; agentType: string }> {
  const admin = await orgAdmin(ctx.orgId)
  const creatorScopes = (await actorFor(ctx, admin.id)).scopes
  const def = await createSubAgentDefinition({ orgId: ctx.orgId, creatorScopes, ...input })
  return { id: def.id, agentType: def.agentType }
}

/**
 * The routine's run history, made exactly these runs (the seed engine's run
 * factory): the runs the world recorded for it are dropped first, as a
 * screenshot of its Runs tab needs. Runs are history, which only the routine
 * worker writes as it ticks.
 */
export async function replaceRoutineRuns(
  ctx: SeedContext,
  input: {
    routineName: string
    key: string
    runs: Array<Omit<RoutineRunSeed, "key" | "routineId">>
  },
): Promise<{ routineId: string; runIds: string[] }> {
  const routineId = await withPrivilegedDb(ctx.orgId, "seed-routine-runs-replace", async (tx) => {
    const [row] = await tx
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.orgId, ctx.orgId), eq(routines.name, input.routineName)))
      .limit(1)
    if (!row) throw new Error(`routine ${input.routineName} not found`)
    await tx
      .delete(routineRuns)
      .where(and(eq(routineRuns.orgId, ctx.orgId), eq(routineRuns.routineId, row.id)))
    return row.id
  })
  const runIds = await seedRoutineRuns(
    ctx,
    input.runs.map((r, i) => ({ ...r, routineId, key: `${input.key}-${i}` })),
  )
  return { routineId, runIds }
}
