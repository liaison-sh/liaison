// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Roles provisioner. Provisions `roles[]` — a named role and the exact set of
 * scopes it should grant — so a deployment config can declare custom roles
 * (e.g. an `ops` role that omits `pennylane:*` / `ads:*`) declaratively,
 * and `users[]` can then invite teammates onto them by name.
 *
 * Runs AFTER `admin` (needs `ctx.orgId` + the admin actor, whose `*` scope lets
 * it grant any app scope without registration ordering constraints) and BEFORE
 * `users` (so an invite's role name resolves). See CANONICAL_ORDER in
 * `cli/config/apply.ts`.
 *
 * Desired-state semantics: each declared role is reconciled to exactly its
 * `scopes` set — missing scopes are granted, extra scopes are revoked. Roles
 * NOT named in the config are never touched (the org's seeded defaults
 * `admin`/`member`/`viewer` stay intact unless the config redeclares them).
 *
 * Idempotent: a second apply with the same config grants/revokes nothing and
 * reports every role as unchanged. Authorization rides the admin RLS context
 * (`ctx.rls`); `grantScope`/`revokeScope` enforce the scope-escalation guard
 * (the actor must hold any scope it grants) — the provisioning admin holds `*`.
 */
import { eq, inArray } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import type { PrivilegedDb } from "~/db"
import { roleScopeGrants, roles as rolesTable } from "~/db/schema/kernel"
import {
  createRole,
  getRoleDetail,
  grantRoleScopes,
  revokeScope,
} from "~/modules/permissions/roles"
import { createScope, type PermissionMutationContext } from "~/modules/permissions/types"

/** Per-role report entry. */
interface RoleResult {
  name: string
  created: boolean
  granted: string[]
  revoked: string[]
}

interface RolesSection {
  roles: RoleResult[]
}

export const rolesProvisioner: Provisioner<ProvisioningConfig> = {
  key: "roles",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const list = config.roles
    if (!list || list.length === 0) return { actions: [] }
    if (ctx.toolPath) return planRolesAgainstStore(ctx.priv, ctx.orgId, list)

    // The driver runs every plan before any apply, so `ctx.orgId` is usually
    // unset here — defer the real diff to apply (idempotent). When the org IS
    // known (a test pre-sets ctx.orgId) compute the create-vs-update intent.
    const existing =
      ctx.orgId === ""
        ? null
        : new Set(
            (
              await ctx.priv("cli-plan-roles", (tx) =>
                tx
                  .select({ name: rolesTable.name })
                  .from(rolesTable)
                  .where(eq(rolesTable.orgId, ctx.orgId)),
              )
            ).map((r) => r.name),
          )

    const actions: string[] = []
    for (const r of list) {
      const verb = existing?.has(r.name) ? "reconcile" : "ensure"
      actions.push(`${verb} role '${r.name}' (${r.scopes.length} scope(s))`)
    }
    return { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const list = config.roles
    if (!list || list.length === 0) return {}

    const mutation: PermissionMutationContext = {
      actorId: ctx.actor.userId,
      actorScopes: ctx.actor.scopes.map(createScope),
      actorDimensionGrants: ctx.actor.dimensionGrants,
      orgId: ctx.orgId,
    }

    const results: RoleResult[] = []
    const changed: string[] = []
    const unchanged: string[] = []

    for (const r of list) {
      const desired = new Set(r.scopes)

      // Reconcile within one RLS transaction per role.
      const result = await ctx.rls(async (tx) => {
        const existingRole = (
          await tx
            .select({ id: rolesTable.id, name: rolesTable.name })
            .from(rolesTable)
            .where(eq(rolesTable.orgId, ctx.orgId))
        ).find((row) => row.name === r.name)

        let roleId: string
        let created = false
        if (existingRole) {
          roleId = existingRole.id
        } else {
          const role = await createRole(tx, {
            orgId: ctx.orgId,
            name: r.name,
            description: r.description,
            actorId: ctx.actor.userId,
          })
          roleId = role.id
          created = true
        }

        const detail = await getRoleDetail(tx, { orgId: ctx.orgId, roleId })
        const current = new Set((detail?.scopes ?? []).map((s) => s.scope))

        // One batch, one event: per-scope grants queued an event each.
        const missing = [...desired].filter((scope) => !current.has(scope))
        const granted =
          missing.length > 0
            ? ((await grantRoleScopes(tx, { roleId, scopes: missing, ...mutation }))?.added ?? [])
            : []

        const revoked: string[] = []
        for (const scope of current) {
          if (desired.has(scope)) continue
          await revokeScope(tx, { roleId, scope, ...mutation })
          revoked.push(scope)
        }

        return { created, granted, revoked }
      })

      ctx.log(
        result.created
          ? `role '${r.name}' created (${result.granted.length} scope(s))`
          : result.granted.length === 0 && result.revoked.length === 0
            ? `role '${r.name}' already up to date`
            : `role '${r.name}' reconciled (+${result.granted.length} / -${result.revoked.length})`,
      )

      results.push({ name: r.name, ...result })
      if (result.created || result.granted.length > 0 || result.revoked.length > 0) {
        changed.push(`roles.${r.name}`)
      } else {
        unchanged.push(`roles.${r.name}`)
      }
    }

    const section: RolesSection = { roles: results }
    return {
      section,
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
    }
  },
}

type RoleEntry = NonNullable<ProvisioningConfig["roles"]>[number]

/** The stored scope set of every role of the org, by role name. */
export async function storedRoleScopes(
  priv: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>,
  orgId: string,
): Promise<Map<string, { id: string; description: string | null; scopes: Set<string> }>> {
  return priv("config-plan-roles", async (tx) => {
    const rows = await tx
      .select({ id: rolesTable.id, name: rolesTable.name, description: rolesTable.description })
      .from(rolesTable)
      .where(eq(rolesTable.orgId, orgId))
    const grants =
      rows.length === 0
        ? []
        : await tx
            .select({ roleId: roleScopeGrants.roleId, scope: roleScopeGrants.scope })
            .from(roleScopeGrants)
            .where(
              inArray(
                roleScopeGrants.roleId,
                rows.map((r) => r.id),
              ),
            )
    const out = new Map<string, { id: string; description: string | null; scopes: Set<string> }>()
    for (const r of rows) {
      if (out.has(r.name)) continue
      out.set(r.name, { id: r.id, description: r.description ?? null, scopes: new Set() })
    }
    const byId = new Map(rows.map((r) => [r.id, r.name] as const))
    for (const g of grants) {
      const name = byId.get(g.roleId)
      if (name) out.get(name)?.scopes.add(g.scope)
    }
    return out
  })
}

/** Tool-path plan: each role's create / scope diff / no-op against the stored rows. */
async function planRolesAgainstStore(
  priv: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>,
  orgId: string,
  list: RoleEntry[],
): Promise<ProvisionPlan> {
  const stored = await storedRoleScopes(priv, orgId)
  const actions: string[] = []
  let changes = 0
  for (const r of list) {
    const current = stored.get(r.name)
    const desired = new Set(r.scopes)
    if (!current) {
      changes++
      actions.push(
        `create role '${r.name}'${desired.size > 0 ? `: grant ${[...desired].sort().join(", ")}` : ""}`,
      )
      continue
    }
    const grant = [...desired].filter((s) => !current.scopes.has(s)).sort()
    const revoke = [...current.scopes].filter((s) => !desired.has(s)).sort()
    if (grant.length === 0 && revoke.length === 0) {
      actions.push(`role '${r.name}' unchanged`)
      continue
    }
    changes++
    const parts = [
      ...(grant.length > 0 ? [`grant ${grant.join(", ")}`] : []),
      ...(revoke.length > 0 ? [`revoke ${revoke.join(", ")}`] : []),
    ]
    actions.push(`update role '${r.name}': ${parts.join("; ")}`)
  }
  return { actions, changes }
}
