// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sub-agent definition CRUD — declarative role registry per (org, agentType).
//
// A sub-agent role has ONE of two owners, which decides where its scope ceiling
// is bounded:
//
//   1. PLUGIN-OWNED (`appName` = an installed app declaring `agent.spawn`): the
//      ceiling must be a subset of the owning app's `granted_scopes`. The app is
//      the source of truth for what the role may reach. `apps_installed` is
//      instance-wide (no org_id, PK on (name, version)) — we look up by `name`
//      via `apps_active_version` and read `granted_scopes`.
//
//   2. KERNEL/ORG-OWNED (`appName` omitted → defaults to "kernel"): a reusable,
//      admin-authored role that belongs to the ORG, not a plugin (e.g. a
//      "dealer-researcher"). It needs no `agent.spawn`-declaring plugin owner.
//      Its ceiling is self-contained — bounded by the CREATOR's own grantable
//      scopes (`creatorScopes`), exactly like a routine/skill ceiling
//      (`create_routine` caps `requiredScopes` at the creator's scopes). A
//      kernel-owned role can never declare a ceiling its author could not hold,
//      and `spawn_agent` further caps the effective set at `parent ∩ ceiling`,
//      so this never escalates.
//
// Glob support throughout: `mcp:jira:*` covers `mcp:jira:read`; `*` covers all.

import { and, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled, subAgentDefinitions } from "~/db/schema/kernel"
import type {
  NewSubAgentDefinition,
  SubAgentDefinition,
} from "~/db/schema/kernel/sub-agent-definitions"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"

/** Owner name stamped on a kernel/org-owned role (no plugin owner). */
export const KERNEL_OWNER = "kernel" as const

export class ScopeOutsideAppError extends Error {
  code = "E_SCOPE_OUTSIDE_APP" as const
  constructor(message: string) {
    super(message)
  }
}

/** Kernel/org-owned ceiling exceeds what the creator can grant. */
export class ScopeOutsideCreatorError extends Error {
  code = "E_SCOPE_OUTSIDE_CREATOR" as const
  constructor(message: string) {
    super(message)
  }
}

export class UnknownAppError extends Error {
  code = "E_UNKNOWN_APP" as const
  constructor(message: string) {
    super(message)
  }
}

/** `child` ⊆ `parent`. Thin alias over the canonical coverage predicate so the
 *  role-registry ceiling check agrees with the skills/routines and spawn paths
 *  on `*`, `:*`-glob, and bare-prefix grants. */
export function isScopeSubset(child: string[], parent: string[]): boolean {
  return isScopeCovered(child, parent)
}

async function loadActiveAppScopes(tx: PrivilegedDb, appName: string): Promise<string[] | null> {
  const [active] = await tx
    .select({ version: appsActiveVersion.version })
    .from(appsActiveVersion)
    .where(eq(appsActiveVersion.name, appName))
    .limit(1)
  if (!active) return null
  const [row] = await tx
    .select({ grantedScopes: appsInstalled.grantedScopes })
    .from(appsInstalled)
    .where(and(eq(appsInstalled.name, appName), eq(appsInstalled.version, active.version)))
    .limit(1)
  return row?.grantedScopes ?? null
}

export interface CreateSubAgentDefinitionInput {
  orgId: string
  /** Owning plugin app. Omit (or pass "kernel") for a kernel/org-owned role
   *  whose ceiling is bounded by the creator's scopes instead of an app's
   *  granted scopes. */
  appName?: string
  /** The creator's effective scopes — REQUIRED to author a kernel/org-owned
   *  role (the self-contained ceiling cap). Ignored for plugin-owned roles
   *  (those cap against the app's granted scopes). */
  creatorScopes?: string[]
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
  contextProfile?: "minimal" | "standard" | "full"
}

export async function createSubAgentDefinition(
  input: CreateSubAgentDefinitionInput,
): Promise<SubAgentDefinition> {
  const appName = input.appName ?? KERNEL_OWNER
  const isKernelOwned = appName === KERNEL_OWNER

  return withPrivilegedDb(input.orgId, "subagent-def-create", async (tx) => {
    if (isKernelOwned) {
      // Kernel/org-owned role — no plugin owner. The ceiling is self-contained:
      // bounded by the creator's own grantable scopes (the same rule
      // `create_routine` applies to a routine's required scopes). This requires
      // the caller to pass `creatorScopes` — a kernel-owned role authored with
      // an unknown creator scope set would be a silent privilege hole, so we
      // FAIL LOUDLY rather than skip the cap.
      const creatorScopes = input.creatorScopes
      if (!creatorScopes) {
        throw new ScopeOutsideCreatorError(
          "Kernel/org-owned sub-agent roles require `creatorScopes` to bound the scope ceiling",
        )
      }
      if (!isScopeSubset(input.scopeCeiling, creatorScopes)) {
        throw new ScopeOutsideCreatorError(
          `Scope ceiling [${input.scopeCeiling.join(", ")}] exceeds the creator's grantable scopes [${creatorScopes.join(", ")}]`,
        )
      }
    } else {
      const appScopes = await loadActiveAppScopes(tx, appName)
      if (appScopes === null) {
        throw new UnknownAppError(`Unknown or unactivated app: ${appName}`)
      }
      if (!isScopeSubset(input.scopeCeiling, appScopes)) {
        throw new ScopeOutsideAppError(
          `Scope ceiling [${input.scopeCeiling.join(", ")}] is not a subset of granted scopes for "${appName}" [${appScopes.join(", ")}]`,
        )
      }
    }

    const row: NewSubAgentDefinition = {
      orgId: input.orgId,
      appName,
      agentType: input.agentType,
      whenToUse: input.whenToUse,
      scopeCeiling: input.scopeCeiling,
      toolAllowlist: input.toolAllowlist ?? null,
      toolDenylist: input.toolDenylist ?? null,
      skills: input.skills ?? [],
      mcpServers: input.mcpServers ?? [],
      systemPrompt: input.systemPrompt,
      defaultMaxSteps: input.defaultMaxSteps ?? null,
      defaultTimeoutMs: input.defaultTimeoutMs ?? null,
      defaultSchemaRetryBudget: input.defaultSchemaRetryBudget ?? null,
      contextProfile: input.contextProfile ?? "standard",
    }
    // Idempotent on (orgId, agentType): re-registering the same slug UPDATES
    // the role's fields in place (the documented `subagent_create` contract),
    // rather than throwing on the unique index.
    const [upserted] = await tx
      .insert(subAgentDefinitions)
      .values(row)
      .onConflictDoUpdate({
        target: [subAgentDefinitions.orgId, subAgentDefinitions.agentType],
        set: {
          appName: row.appName,
          whenToUse: row.whenToUse,
          scopeCeiling: row.scopeCeiling,
          toolAllowlist: row.toolAllowlist,
          toolDenylist: row.toolDenylist,
          skills: row.skills,
          mcpServers: row.mcpServers,
          systemPrompt: row.systemPrompt,
          defaultMaxSteps: row.defaultMaxSteps,
          defaultTimeoutMs: row.defaultTimeoutMs,
          defaultSchemaRetryBudget: row.defaultSchemaRetryBudget,
          contextProfile: row.contextProfile,
          updatedAt: new Date(),
        },
      })
      .returning()
    return upserted
  })
}

export async function loadSubAgentDefinition(
  orgId: string,
  agentType: string,
): Promise<SubAgentDefinition | null> {
  return withPrivilegedDb(orgId, "subagent-def-load", async (tx) => {
    const [row] = await tx
      .select()
      .from(subAgentDefinitions)
      .where(
        and(eq(subAgentDefinitions.orgId, orgId), eq(subAgentDefinitions.agentType, agentType)),
      )
      .limit(1)
    return row ?? null
  })
}

export async function listSubAgentDefinitions(
  orgId: string,
  filter: { appName?: string } = {},
): Promise<SubAgentDefinition[]> {
  return withPrivilegedDb(orgId, "subagent-def-list", async (tx) => {
    const where = filter.appName
      ? and(eq(subAgentDefinitions.orgId, orgId), eq(subAgentDefinitions.appName, filter.appName))
      : eq(subAgentDefinitions.orgId, orgId)
    return tx.select().from(subAgentDefinitions).where(where)
  })
}

export async function deleteSubAgentDefinition(orgId: string, agentType: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "subagent-def-delete", async (tx) => {
    const deleted = await tx
      .delete(subAgentDefinitions)
      .where(
        and(eq(subAgentDefinitions.orgId, orgId), eq(subAgentDefinitions.agentType, agentType)),
      )
      .returning({ id: subAgentDefinitions.id })
    return deleted.length > 0
  })
}
