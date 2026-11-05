// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].domainAccess` on the `database` app entry of `liaison config apply`:
 * who may run each catalog domain's curated reads
 * (`organizations.settings.database.domainAccess`, rules in
 * apps/database/domain-access.ts).
 *
 * Roles are named and people given by email; apply resolves them to ids and
 * fails loudly on an unknown one. The section REPLACES the stored map (the
 * config is the desired state, as in the settings page's save); an entry that
 * omits `domainAccess` leaves the stored map untouched. The same validation as
 * PUT /api/database/domain-access runs on the resolved map before the write.
 */
import { type DatabaseDomainAccess, databaseDomainAccessSchema } from "@liaison/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import {
  assertDomainAccessReferences,
  DomainAccessReferenceError,
  readOrgDomainAccess,
  writeOrgDomainAccess,
} from "~/apps/database/domain-access-store"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { resolvePlanOrgId } from "~/cli/provisioners/types"
import { expectUserRoles } from "~/cli/provisioners/user-roles"
import { roles, users } from "~/db/schema/kernel"
import { canonicalJson } from "~/modules/apps/app-config"

type DomainAccessConfig = NonNullable<
  NonNullable<ProvisioningConfig["apps"]>[number]["domainAccess"]
>

const SECTION = "apps.database.domainAccess"

/** Role names and emails the config names. */
function referenced(map: DomainAccessConfig): { roles: Set<string>; emails: Set<string> } {
  const out = { roles: new Set<string>(), emails: new Set<string>() }
  for (const rule of Object.values(map)) {
    for (const r of rule.roles ?? []) out.roles.add(r)
    for (const e of rule.users ?? []) out.emails.add(e.toLowerCase())
  }
  return out
}

/**
 * Plan: every named role exists or is created by this run, every email is a
 * person of the org or one this run adds. Read-only; a `ConfigError` names the
 * first unknown reference.
 */
export async function planDatabaseDomainAccess(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
  map: DomainAccessConfig,
): Promise<string[]> {
  const refs = referenced(map)
  if (refs.roles.size > 0) {
    const { known, later } = await expectUserRoles(ctx, config)
    for (const role of refs.roles) {
      if (!known.has(role) && !later.has(role)) {
        throw new ConfigError(
          `${SECTION}: unknown role '${role}' (valid roles: ${[...known, ...later].sort().join(", ")})`,
        )
      }
    }
  }
  if (refs.emails.size > 0) {
    const orgId =
      ctx.orgId || (await resolvePlanOrgId(ctx, config.org.slug, "cli-plan-domain-access-org"))
    const known = new Set<string>()
    for (const u of config.users ?? []) known.add(u.email.toLowerCase())
    if (config.admin?.email) known.add(config.admin.email.toLowerCase())
    if (orgId) {
      const rows = await ctx.sys("cli-plan-domain-access-users", (db) =>
        db
          .select({ email: users.email })
          .from(users)
          .where(
            and(eq(users.orgId, orgId), inArray(sql`lower(${users.email})`, [...refs.emails])),
          ),
      )
      for (const r of rows) known.add(r.email.toLowerCase())
    }
    for (const email of refs.emails) {
      if (!known.has(email)) {
        throw new ConfigError(`${SECTION}: no person '${email}' in this organization or in users`)
      }
    }
  }
  return [`set app 'database' domainAccess: ${Object.keys(map).join(", ") || "(none)"}`]
}

/** Resolve role names and emails to the org's ids; throws on an unknown one. */
export async function resolveDatabaseDomainAccess(
  ctx: ProvisionContext,
  map: DomainAccessConfig,
): Promise<DatabaseDomainAccess> {
  const refs = referenced(map)
  const roleRows = refs.roles.size
    ? await ctx.priv("cli-domain-access-roles", (tx) =>
        tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(and(eq(roles.orgId, ctx.orgId), inArray(roles.name, [...refs.roles]))),
      )
    : []
  const userRows = refs.emails.size
    ? await ctx.priv("cli-domain-access-users", (tx) =>
        tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(
            and(eq(users.orgId, ctx.orgId), inArray(sql`lower(${users.email})`, [...refs.emails])),
          ),
      )
    : []
  const roleId = new Map(roleRows.map((r) => [r.name, r.id] as const))
  const userId = new Map(userRows.map((u) => [u.email.toLowerCase(), u.id] as const))
  const out: DatabaseDomainAccess = {}
  for (const [domain, rule] of Object.entries(map)) {
    const resolved: DatabaseDomainAccess[string] = { tier: rule.tier }
    if (rule.roles) {
      resolved.roles = rule.roles.map((name) => {
        const id = roleId.get(name)
        if (!id) throw new ConfigError(`${SECTION}.${domain}.roles: unknown role '${name}'`)
        return id
      })
    }
    if (rule.users) {
      resolved.users = rule.users.map((email) => {
        const id = userId.get(email.toLowerCase())
        if (!id) throw new ConfigError(`${SECTION}.${domain}.users: no person '${email}'`)
        return id
      })
    }
    out[domain] = resolved
  }
  const parsed = databaseDomainAccessSchema.safeParse(out)
  if (!parsed.success) {
    throw new ConfigError(
      `${SECTION}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    )
  }
  return parsed.data
}

function normalized(map: DatabaseDomainAccess): string {
  const sorted: Record<string, unknown> = {}
  for (const domain of Object.keys(map).sort()) {
    const rule = map[domain]
    if (!rule) continue
    sorted[domain] = {
      tier: rule.tier,
      ...(rule.roles ? { roles: [...rule.roles].sort() } : {}),
      ...(rule.users ? { users: [...rule.users].sort() } : {}),
    }
  }
  return canonicalJson(sorted)
}

/** Apply: resolve, validate, write when it differs from the stored map. */
export async function applyDatabaseDomainAccess(
  ctx: ProvisionContext,
  map: DomainAccessConfig,
): Promise<{ changed: string[]; unchanged: string[] }> {
  const wanted = await resolveDatabaseDomainAccess(ctx, map)
  return ctx.priv("cli-domain-access-write", async (tx) => {
    try {
      await assertDomainAccessReferences(tx, ctx.orgId, wanted)
    } catch (err) {
      if (err instanceof DomainAccessReferenceError)
        throw new ConfigError(`apps.database.${err.message}`)
      throw err
    }
    const stored = await readOrgDomainAccess(tx, ctx.orgId)
    if (normalized(stored) === normalized(wanted)) {
      ctx.log("database domainAccess unchanged")
      return { changed: [], unchanged: [SECTION] }
    }
    await writeOrgDomainAccess(tx, ctx.orgId, wanted)
    ctx.log(`database domainAccess set: ${Object.keys(wanted).join(", ") || "(none)"}`)
    return { changed: [SECTION], unchanged: [] }
  })
}
