// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which role names `users[].role` may name in one config run. Shared by the
 * pre-flight (before any write), the users plan and the users apply, so
 * `config apply`, its `--dry-run` and the apply itself always agree.
 *
 * A role is valid when it exists in the org, or when THIS run creates it:
 *  - a role declared in the same file's `roles` section (the roles section runs
 *    before users);
 *  - for an org this run creates, the roles its default app registration seeds
 *    (`<app>.<role>` per manifest role, and "Full Member"), as `org` registers
 *    those apps before users run;
 *  - the roles of an app the same file enables under `apps`, by their exact
 *    names: from the app's registered manifest (an in-tree or instance-installed
 *    app), or, for a catalog app this run installs, from the manifest inside its
 *    baked package, read before any write. Such an install runs in `apps`,
 *    after `users`, so the users on its roles are invited once every section
 *    applied (`usersProvisioner.applyLate`).
 *
 * A typo is therefore refused at plan time, before anything is written; a
 * catalog package whose manifest cannot be read is refused the same way.
 */
import { eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { type ProvisionContext, resolvePlanOrgId } from "~/cli/provisioners/types"
import { roles } from "~/db/schema/kernel"
import { catalogManifestRoles } from "~/modules/apps/catalog"
import { getDefaultApps } from "~/modules/apps/init"
import { rolesSeededByRegistration } from "~/modules/apps/runtime"
import { DEFAULT_ROLES } from "~/modules/permissions/default-roles"

export interface UserRoleExpectations {
  /** Role names that exist, or will exist before the users section applies. */
  known: Set<string>
  /** Role names the `apps` section creates by installing a catalog app. */
  later: Set<string>
}

/** The org's current role names (`orgId` must be set). */
export async function orgRoleNames(ctx: ProvisionContext, orgId: string): Promise<Set<string>> {
  const rows = await ctx.sys("cli-user-roles", (db) =>
    db.select({ name: roles.name }).from(roles).where(eq(roles.orgId, orgId)),
  )
  return new Set(rows.map((r) => r.name))
}

export async function expectUserRoles(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
): Promise<UserRoleExpectations> {
  const orgId = await resolvePlanOrgId(ctx, config.org.slug, "cli-preflight-org")
  const enabledApps = (config.apps ?? []).filter((a) => a.enable).map((a) => a.name)
  const known =
    orgId !== "" ? await orgRoleNames(ctx, orgId) : new Set(DEFAULT_ROLES.map((r) => r.name))

  // App manifests are read only when a role could come from one.
  const needManifests = orgId === "" || enabledApps.length > 0
  const descriptors = needManifests ? await getDefaultApps() : []
  const seeded = new Map(
    descriptors.map(
      (d) => [d.name, rolesSeededByRegistration(d.name, manifestRolesOf(d))] as const,
    ),
  )

  // A new org: `org` registers every default app before `users` runs.
  if (orgId === "") for (const names of seeded.values()) for (const n of names) known.add(n)

  for (const r of config.roles ?? []) known.add(r.name)

  const later = new Set<string>()
  for (const app of enabledApps) {
    const names = seeded.get(app) ?? catalogRolesOf(app)
    for (const n of names) if (!known.has(n)) later.add(n)
  }
  return { known, later }
}

/** The roles a catalog app's install seeds, read from its baked package. */
function catalogRolesOf(app: string): string[] {
  let declared: unknown
  try {
    declared = catalogManifestRoles(app)
  } catch (err) {
    throw new ConfigError(
      `apps: cannot read the roles of catalog app '${app}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return rolesSeededByRegistration(app, declared)
}

export function unknownRoleError(
  role: string,
  email: string,
  known: Iterable<string>,
): ConfigError {
  return new ConfigError(
    `users: unknown role '${role}' for '${email}' (valid roles: ${[...known].sort().join(", ")})`,
  )
}

/**
 * Refuse every `users[].role` that neither exists nor is created by this run,
 * with a `ConfigError` naming it and the valid roles. Read-only.
 */
export async function validateUserRoles(
  ctx: ProvisionContext,
  config: ProvisioningConfig,
): Promise<void> {
  const list = config.users
  if (!list || list.length === 0) return
  const { known, later } = await expectUserRoles(ctx, config)
  for (const u of list) {
    if (!known.has(u.role) && !later.has(u.role)) {
      throw unknownRoleError(u.role, u.email, [...known, ...later])
    }
  }
}

/** A registered app descriptor's manifest `roles`, when it declares any. */
function manifestRolesOf(desc: object): unknown {
  return "roles" in desc ? desc.roles : undefined
}
