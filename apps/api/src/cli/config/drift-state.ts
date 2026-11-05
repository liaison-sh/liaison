// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The DB side of `config apply` drift safety (`drift.ts` holds the logic):
 *
 *  - `readServerConfig`: the org's current values, in the config file's shape,
 *    for the sections the given config names (roles by name, people by email,
 *    agents by handle, never a secret);
 *  - `loadAppliedRecords` / `saveAppliedRecords`: the last-applied record,
 *    `kernel.config_applied_fields` (migration 0243), one row per org and path
 *    holding a hash of the value, never the value.
 *
 * Everything goes through the provisioning context's privileged seam, scoped
 * to `ctx.orgId`.
 */

import { ORG_CAP_KINDS } from "@liaison/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import { readOrgDomainAccess } from "~/apps/database/domain-access-store"
import type { AppliedRecord } from "~/cli/config/drift"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { configAppliedFields, organizations, roles, users } from "~/db/schema/kernel"
import { isRecord } from "~/lib/guards"
import { readOrgAppNamespace, settingAtPath } from "~/lib/settings"
import { readAppConfig } from "~/modules/apps/app-config"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { readOrgCaps } from "~/modules/org/caps"
import {
  exportAgents,
  exportEmail,
  exportIssuerProfiles,
  exportRoles,
  exportSetup,
} from "~/modules/provisioning/config-export"

/** The org's current values for every section `config` names, config-shaped. */
export async function readServerConfig(
  ctx: ProvisionContext,
  config: unknown,
): Promise<Record<string, unknown>> {
  const orgId = ctx.orgId
  const out: Record<string, unknown> = {}
  if (!isRecord(config)) return out
  const priv = ctx.priv

  if (config.org !== undefined) {
    const [row] = await priv("config-drift-org", (tx) =>
      tx
        .select({
          name: organizations.name,
          timezone: organizations.timezone,
          defaultLocale: organizations.defaultLocale,
          twoFactor: sql<boolean>`COALESCE((${organizations.settings}->>'requireAdminSecondFactor')::boolean, false)`,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    )
    if (row) {
      out.org = {
        name: row.name,
        ...(row.timezone ? { timezone: row.timezone } : {}),
        ...(row.defaultLocale ? { defaultLocale: row.defaultLocale } : {}),
        requireAdminSecondFactor: row.twoFactor === true,
      }
    }
  }
  if (config.limits !== undefined) {
    const caps = await readOrgCaps(orgId)
    out.limits = Object.fromEntries(ORG_CAP_KINDS.map((k) => [k, caps[k] ?? null]))
  }
  if (config.email !== undefined) out.email = await exportEmail(priv, orgId)
  if (config.setup !== undefined) out.setup = await exportSetup(priv, orgId)
  if (config.roles !== undefined) out.roles = await exportRoles(priv, orgId)
  if (config.agents !== undefined) out.agents = await exportAgents(priv, orgId)
  if (isRecord(config.invoicing) && config.invoicing.issuerProfiles !== undefined) {
    out.invoicing = { issuerProfiles: await exportIssuerProfiles(priv, orgId) }
  }
  if (Array.isArray(config.apps)) {
    const enabled = new Set(await getEnabledApps(orgId))
    const apps: Array<Record<string, unknown>> = []
    for (const a of config.apps) {
      if (!isRecord(a) || typeof a.name !== "string") continue
      const name = a.name
      const state = enabled.has(name) ? (await getOrgAppState(orgId, name))?.status : undefined
      const entry: Record<string, unknown> = {
        name,
        enable: enabled.has(name) && state !== "disabled",
      }
      if (isRecord(a.config)) {
        const stored = await priv("config-drift-app-config", (tx) => readAppConfig(tx, orgId, name))
        entry.config = Object.fromEntries(
          Object.keys(a.config).map((k) => [k, stored[k] ?? null] as const),
        )
      }
      if (isRecord(a.settings)) {
        const ns = await priv("config-drift-app-settings", (tx) =>
          readOrgAppNamespace(tx, orgId, name),
        )
        entry.settings = Object.fromEntries(
          Object.keys(a.settings).map((p) => [p, settingAtPath(ns, p.split(".")) ?? null] as const),
        )
      }
      if (a.domainAccess !== undefined) entry.domainAccess = await readDomainAccessConfig(ctx)
      apps.push(entry)
    }
    out.apps = apps
  }
  return out
}

/** The stored domain access map with role ids as names and people as emails. */
async function readDomainAccessConfig(ctx: ProvisionContext): Promise<Record<string, unknown>> {
  return ctx.priv("config-drift-domain-access", async (tx) => {
    const stored = await readOrgDomainAccess(tx, ctx.orgId)
    const roleIds = new Set<string>()
    const userIds = new Set<string>()
    for (const rule of Object.values(stored)) {
      for (const id of rule?.roles ?? []) roleIds.add(id)
      for (const id of rule?.users ?? []) userIds.add(id)
    }
    const roleRows = roleIds.size
      ? await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(and(eq(roles.orgId, ctx.orgId), inArray(roles.id, [...roleIds])))
      : []
    const userRows = userIds.size
      ? await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.orgId, ctx.orgId), inArray(users.id, [...userIds])))
      : []
    const roleName = new Map(roleRows.map((r) => [r.id, r.name] as const))
    const userEmail = new Map(userRows.map((u) => [u.id, u.email.toLowerCase()] as const))
    const out: Record<string, unknown> = {}
    for (const [domain, rule] of Object.entries(stored)) {
      if (!rule) continue
      out[domain] = {
        tier: rule.tier,
        ...(rule.roles ? { roles: rule.roles.map((id) => roleName.get(id) ?? id) } : {}),
        ...(rule.users ? { users: rule.users.map((id) => userEmail.get(id) ?? id) } : {}),
      }
    }
    return out
  })
}

export async function loadAppliedRecords(
  ctx: ProvisionContext,
): Promise<Map<string, AppliedRecord>> {
  const rows = await ctx.priv("config-drift-records-read", (tx) =>
    tx
      .select({
        path: configAppliedFields.path,
        hash: configAppliedFields.valueHash,
        appliedAt: configAppliedFields.appliedAt,
        appliedBy: configAppliedFields.appliedBy,
      })
      .from(configAppliedFields)
      .where(eq(configAppliedFields.orgId, ctx.orgId)),
  )
  return new Map(
    rows.map((r) => [r.path, { hash: r.hash, appliedAt: r.appliedAt, appliedBy: r.appliedBy }]),
  )
}

export async function saveAppliedRecords(
  ctx: ProvisionContext,
  rows: Array<{ path: string; hash: string }>,
  appliedBy: string,
): Promise<void> {
  // One row per path: Postgres refuses an upsert that touches a row twice.
  const byPath = new Map(rows.map((r) => [r.path, r]))
  if (byPath.size === 0) return
  const now = new Date()
  await ctx.priv("config-drift-records-write", (tx) =>
    tx
      .insert(configAppliedFields)
      .values(
        [...byPath.values()].map((r) => ({
          orgId: ctx.orgId,
          path: r.path,
          valueHash: r.hash,
          appliedAt: now,
          appliedBy,
        })),
      )
      .onConflictDoUpdate({
        target: [configAppliedFields.orgId, configAppliedFields.path],
        set: {
          valueHash: sql`excluded.value_hash`,
          appliedAt: sql`excluded.applied_at`,
          appliedBy: sql`excluded.applied_by`,
        },
      }),
  )
}
