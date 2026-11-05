// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agents provisioner: `agents[]` declares the org's ROLE agents (a support
 * agent, a sales agent...), the same rows Settings > Agents > New agent writes.
 * Personal agents come with each user and `@base` with the org, so neither is
 * declared here.
 *
 * Idempotent by handle. A missing handle is created; an existing role agent
 * converges to the declared display name, purpose, system prompt and ceiling.
 * A handle already taken by a personal or system agent is a config error.
 *
 * The ceiling is the common agent base (what every non personal agent needs
 * to search tools, read threads and knowledge, and keep memory) plus the
 * declared `scopes`. It is checked like the API checks a role agent's ceiling:
 * single well formed scopes, no organization-administration scope, and only
 * scopes the kernel, an app of this build or an app installed on this
 * instance (`apps_installed.granted_scopes` of the active versions) declares.
 * It stays a cap: on every turn it is intersected with the acting human's own
 * grants.
 *
 * `model` optionally pins the agent's model (`agents.model_preference`),
 * checked against the model catalog; without it the agent uses auto mode.
 *
 * Every created or changed agent writes an audit row (`agent.created` /
 * `agent.updated`, actor: the system, `via: liaison config apply`).
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type {
  ProvisionContext,
  Provisioner,
  ProvisionPlan,
  ProvisionResult,
} from "~/cli/provisioners/types"
import { agents, modelPricing } from "~/db/schema/kernel"
import { getOrgKernelSettings } from "~/lib/settings"
import { findAddedModel, parseModelKey } from "~/modules/agent/credits/model-keys"
import { pickAgentAvatarColor } from "~/modules/agent/directory/avatar-color"
import { assertNoAdminScopesInRoleCeiling } from "~/modules/agent/directory/ceiling-guard"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"
import { installedAppScopes } from "~/modules/agent/directory/installed-scopes"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope } from "~/modules/permissions/permissions"

/** The same handle grammar as the agent create route. */
const HANDLE_RE = /^@[a-z0-9][a-z0-9_-]{0,30}$/

interface AgentResult {
  handle: string
  id: string
  created: boolean
  updated: boolean
}

interface AgentsSection {
  agents: AgentResult[]
}

export function normalizeAgentHandle(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower : `@${lower}`
}

/** Common base first, then the declared scopes, without duplicates. */
export function composeRoleAgentCeiling(scopes: readonly string[] = []): string[] {
  return [...new Set([...COMMON_AGENT_BASE_SCOPES, ...scopes])]
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((s) => set.has(s))
}

type AgentEntry = NonNullable<ProvisioningConfig["agents"]>[number]

interface DesiredRoleAgent {
  displayName: string
  purpose: string | null
  systemPrompt: string
  scopeCeiling: string[]
  modelPreference: string | null
}

/**
 * A person configuring an agent through a tool can only hand it scopes they
 * hold themselves (the agent's ceiling is a cap on what it may ever do for
 * anyone). The common base every agent carries is not theirs to grant or
 * withhold, so only the declared scopes are checked.
 */
function assertActorHoldsAgentScopes(
  actorScopes: string[],
  handle: string,
  scopes: readonly string[],
): void {
  const missing = scopes.filter((s) => !hasScope(s, actorScopes))
  if (missing.length > 0) {
    throw new ConfigError(
      `agents: '${handle}': you cannot give an agent scopes you do not hold (${missing.join(", ")})`,
    )
  }
}

/** The fields of a stored role agent that differ from the desired row. */
function changedAgentFields(
  existing: typeof agents.$inferSelect,
  desired: DesiredRoleAgent,
): string[] {
  const out: string[] = []
  if (existing.displayName !== desired.displayName) out.push("displayName")
  if ((existing.purpose ?? null) !== desired.purpose) out.push("purpose")
  if (existing.systemPrompt !== desired.systemPrompt) out.push("systemPrompt")
  if ((existing.modelPreference ?? null) !== desired.modelPreference) out.push("model")
  if (!sameScopes(existing.scopeCeiling ?? [], desired.scopeCeiling)) out.push("scopes")
  return out
}

/** The row an entry converges to, after the ceiling and model checks. */
async function desiredRoleAgent(
  ctx: ProvisionContext,
  a: AgentEntry,
  installed: Awaited<ReturnType<typeof installedAppScopes>>,
): Promise<DesiredRoleAgent> {
  const handle = normalizeAgentHandle(a.handle)
  if (ctx.toolPath) assertActorHoldsAgentScopes(ctx.actor.scopes, handle, a.scopes ?? [])
  const scopeCeiling = composeRoleAgentCeiling(a.scopes)
  try {
    assertNoAdminScopesInRoleCeiling("role", scopeCeiling, installed)
  } catch (err) {
    throw new ConfigError(
      `agents: '${handle}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const modelPreference = a.model ?? null
  if (modelPreference !== null) {
    // A native catalogue id, or a model key the org added (an OpenRouter
    // model, a model of its own server) in `ai.models.added` (A13).
    const parsed = parseModelKey(modelPreference)
    const known =
      parsed?.kind === "native"
        ? (
            await ctx.priv("cli-agents-model", (tx) =>
              tx
                .select({ id: modelPricing.modelId })
                .from(modelPricing)
                .where(eq(modelPricing.modelId, modelPreference))
                .limit(1),
            )
          )[0]
        : parsed
          ? findAddedModel(
              (
                await ctx.priv("cli-agents-added-models", (tx) =>
                  getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
                )
              ).ai?.models ?? {},
              modelPreference,
            )
          : undefined
    if (!known) {
      throw new ConfigError(
        `agents: '${handle}': model '${modelPreference}' is not in the model catalog`,
      )
    }
  }
  const desired = {
    displayName: a.displayName,
    purpose: a.purpose ?? null,
    systemPrompt: a.systemPrompt ?? "",
    scopeCeiling,
    modelPreference,
  }
  return desired
}

export const agentsProvisioner: Provisioner<ProvisioningConfig> = {
  key: "agents",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const list = config.agents ?? []
    const seen = new Set<string>()
    for (const a of list) {
      const handle = normalizeAgentHandle(a.handle)
      if (!HANDLE_RE.test(handle)) {
        throw new ConfigError(
          `agents: handle '${a.handle}' must be letters, digits, dashes and underscores (at most 31)`,
        )
      }
      if (seen.has(handle)) throw new ConfigError(`agents: handle '${handle}' is declared twice`)
      seen.add(handle)
    }
    if (!ctx.toolPath || list.length === 0) {
      return { actions: list.map((a) => `ensure role agent '${normalizeAgentHandle(a.handle)}'`) }
    }
    // Tool path: diff each entry against the stored agent.
    const installed = await ctx.priv("config-plan-agents-installed-scopes", installedAppScopes)
    const actions: string[] = []
    let changes = 0
    for (const a of list) {
      const handle = normalizeAgentHandle(a.handle)
      const desired = await desiredRoleAgent(ctx, a, installed)
      const [existing] = await ctx.priv("config-plan-agents-read", (tx) =>
        tx
          .select()
          .from(agents)
          .where(and(eq(agents.orgId, ctx.orgId), eq(agents.handle, handle)))
          .limit(1),
      )
      if (!existing) {
        changes++
        actions.push(`create role agent '${handle}'`)
        continue
      }
      if (existing.kind !== "role") {
        throw new ConfigError(
          `agents: handle '${handle}' is already taken by a ${existing.kind} agent; pick another handle`,
        )
      }
      const fields = changedAgentFields(existing, desired)
      if (fields.length === 0) {
        actions.push(`role agent '${handle}' unchanged`)
      } else {
        changes++
        actions.push(`update role agent '${handle}': ${fields.join(", ")}`)
      }
    }
    return { actions, changes }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const list = config.agents ?? []
    if (list.length === 0) return {}

    const results: AgentResult[] = []
    const changed: string[] = []
    const unchanged: string[] = []
    const installed = await ctx.priv("cli-agents-installed-scopes", installedAppScopes)

    for (const a of list) {
      const handle = normalizeAgentHandle(a.handle)
      const desired = await desiredRoleAgent(ctx, a, installed)

      const result = await ctx.priv("cli-ensure-role-agent", async (tx) => {
        const [existing] = await tx
          .select()
          .from(agents)
          .where(and(eq(agents.orgId, ctx.orgId), eq(agents.handle, handle)))
          .limit(1)

        if (!existing) {
          const [row] = await tx
            .insert(agents)
            .values({
              orgId: ctx.orgId,
              kind: "role",
              handle,
              ...desired,
              avatarColor: await pickAgentAvatarColor(tx, ctx.orgId),
            })
            .returning({ id: agents.id })
          if (!row) throw new Error(`agents: insert of '${handle}' returned no row`)
          await writeAuditLog(tx, {
            orgId: ctx.orgId,
            actorId: null,
            actorType: "system",
            app: "kernel",
            entityType: "agent",
            entityId: row.id,
            action: "agent.created",
            changes: { handle, ...desired },
            metadata: { via: "liaison config apply" },
          })
          return { id: row.id, created: true, updated: false }
        }

        if (existing.kind !== "role") {
          throw new ConfigError(
            `agents: handle '${handle}' is already taken by a ${existing.kind} agent; pick another handle`,
          )
        }
        const before = {
          displayName: existing.displayName,
          purpose: existing.purpose ?? null,
          systemPrompt: existing.systemPrompt,
          scopeCeiling: existing.scopeCeiling ?? [],
          modelPreference: existing.modelPreference ?? null,
        }
        const differs = changedAgentFields(existing, desired).length > 0
        if (differs) {
          await tx.update(agents).set(desired).where(eq(agents.id, existing.id))
          await writeAuditLog(tx, {
            orgId: ctx.orgId,
            actorId: null,
            actorType: "system",
            app: "kernel",
            entityType: "agent",
            entityId: existing.id,
            action: "agent.updated",
            changes: { before, after: desired },
            metadata: { via: "liaison config apply" },
          })
        }
        return { id: existing.id, created: false, updated: differs }
      })

      results.push({ handle, ...result })
      if (result.created) {
        ctx.log(`agents: role agent '${handle}' created (${result.id})`)
        changed.push(`agents.${handle}.created`)
      } else if (result.updated) {
        ctx.log(`agents: role agent '${handle}' updated`)
        changed.push(`agents.${handle}.updated`)
      } else {
        ctx.log(`agents: role agent '${handle}' already up to date`)
        unchanged.push(`agents.${handle}`)
      }
    }

    const section: AgentsSection = { agents: results }
    return {
      section,
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
    }
  },
}
