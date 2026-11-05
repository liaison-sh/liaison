// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent fixtures of the browser tests, through the seed route
// (`POST /api/_test/seed`, apps/api/test-support/seed/agent.ts): the model
// pricing catalog, an org's credit balance, a person's scopes, their own
// agent's ceiling, an agent conversation, a delegate role and a routine's run
// history. Each is made by the product's own service in the server under test.
import type { WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed"

/** The model pricing catalog (as the server seeds it at boot) and the bootstrap USD to EUR rate. */
export async function seedModelPricing(env: WorkerEnv): Promise<void> {
  await seedFactory(env, undefined, "pricing.catalog", {})
}

/** Set the org's credit balance to exactly these amounts (default 50 included, 50 purchased). */
export async function seedCredits(
  env: WorkerEnv,
  orgId: string,
  opts: { included?: string; purchased?: string } = {},
): Promise<void> {
  await seedFactory(env, orgId, "credits.balance", opts)
}

/**
 * Pricing catalog plus a generous credit balance, so the agent loop's model
 * pre-check passes. Call BEFORE login. Credits are metered in the managed
 * edition only; a self-hosted stack keeps the row and ignores it.
 */
export async function seedModelPricingAndCredits(
  env: WorkerEnv,
  orgId: string,
  opts: { included?: string; purchased?: string } = {},
): Promise<void> {
  await seedModelPricing(env)
  await seedCredits(env, orgId, opts)
}

/** Give the person the scopes they do not hold yet, through a role (the role editor's services). */
export async function grantScopes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  scopes: string[],
): Promise<void> {
  await seedFactory(env, orgId, "roles.grantScopes", { userId, scopes, onlyMissing: true })
}

export interface RevokedScope {
  userId: string
  scope: string
  roleIds: string[]
  direct: boolean
}

/**
 * Take `scope` from the person through the role editor: off every role they
 * hold that grants it, and their direct grant. Pass the result to
 * `restoreScope` to give it back.
 */
export async function revokeScope(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  scope: string,
): Promise<RevokedScope> {
  const taken = await seedFactory<{ roleIds: string[]; direct: boolean }>(
    env,
    orgId,
    "roles.revokeScope",
    { userId, scope },
  )
  return { userId, scope, ...taken }
}

/** Give back what `revokeScope` took. */
export async function restoreScope(
  env: WorkerEnv,
  orgId: string,
  revoked: RevokedScope,
): Promise<void> {
  await seedFactory(env, orgId, "roles.restoreScope", { ...revoked })
}

/**
 * Recompute the person's own agent's scope ceiling from their current grants,
 * the recompute the product runs on every grant change.
 *
 * Why a scenario needs it: a routine runs at its agent's FULL ceiling, so the
 * product refuses to write one unless the author holds every scope in that
 * ceiling (`agentWriteRefusal` -> `ceiling_not_covered`). A seeded member whose
 * agent carries a ceiling wider than their own grants can author nothing
 * until it is recomputed.
 */
export async function alignOwnAgentCeiling(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<void> {
  await seedFactory(env, orgId, "agents.alignOwnCeiling", { userId })
}

/** A new agent conversation the person starts, they its only participant; its id. */
export async function seedAgentThread(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<string> {
  return (await seedFactory<{ id: string }>(env, orgId, "threads.agentChat", { userId })).id
}

export interface SubAgentDefInput {
  /** The owning app; omitted for a kernel-owned role. */
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
}

/** A delegate role through `createSubAgentDefinition` (its ceiling checked against the app's scopes). */
export function seedSubAgentDefinition(
  env: WorkerEnv,
  orgId: string,
  input: SubAgentDefInput,
): Promise<{ id: string; agentType: string }> {
  return seedFactory(env, orgId, "subAgents.definition", { ...input })
}

/** Three runs in a routine's history, with fixed times so a screenshot of the
 *  Runs tab is stable: a manual run, a failed one, and an older run recorded
 *  before start times and triggers were kept. The routine's own runs go. */
export async function seedRoutineRuns(
  env: WorkerEnv,
  orgId: string,
  routineName: string,
): Promise<void> {
  await seedFactory(env, orgId, "routines.runs", {
    routineName,
    runs: [
      {
        startedAt: "2026-10-16T08:00:00Z",
        durationMs: 12_000,
        status: "succeeded",
        trigger: "manual",
        turnsAdded: null,
      },
      {
        startedAt: "2026-10-15T08:00:00Z",
        durationMs: 65_000,
        status: "failed",
        trigger: "schedule",
        error: "The model provider timed out.",
        turnsAdded: null,
      },
      {
        startedAt: null,
        ranAt: "2026-10-14T08:00:09Z",
        durationMs: 9_000,
        status: "succeeded",
        trigger: null,
        turnsAdded: null,
      },
    ],
  })
}

/** Clear the routine's run history again. */
export async function dropRoutineRuns(
  env: WorkerEnv,
  orgId: string,
  routineName: string,
): Promise<void> {
  await seedFactory(env, orgId, "routines.runs", { routineName, runs: [] })
}
