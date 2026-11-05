// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Admin provisioner (Task 5). Runs right after `org` in the canonical order:
 * it ensures the owner admin user (create-only — never resets the password) and
 * populates `ctx.actor` so every downstream provisioner runs its RLS work as the
 * admin (`ctx.actor.scopes = ['*']`, backed by the admin role's `*` dimension
 * grant seeded by `ensureOrg`).
 *
 * The section is optional (a deploy may target an already-bootstrapped org).
 * Without it, the CLI acts as the org's earliest active admin, so the sections
 * that record who made a change (credentials, adapters, installs) have a person
 * to name; an org with no active admin leaves `ctx.actor` empty.
 *
 * Headless first boot: on a fresh instance, `org` + `admin` here do what the
 * browser's first Register does (org, default roles, `@base`, the owner with
 * the admin role and a personal agent), so no browser step is needed. Without
 * `password` the owner signs in passwordless. This is not a backdoor: the CLI
 * runs in process inside the app container with the database credentials, so
 * only whoever already operates the instance can run it.
 *
 * Handle: `withSystemDb` via the `ensureUser` primitive (direct user insert).
 */
import { and, asc, eq } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { roles, userRoles, users } from "~/db/schema/kernel"
import { ensureUser } from "~/modules/provisioning/ensure-user"

interface AdminSection {
  id: string
  email: string
  created: boolean
}

export const adminProvisioner: Provisioner<ProvisioningConfig> = {
  key: "admin",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const admin = config.admin
    if (!admin) return { actions: [] }
    const email = admin.email.toLowerCase()
    // The driver runs the whole plan phase BEFORE any apply, so `ctx.orgId` is
    // unset here (the org provisioner sets it in its apply). Without an org we
    // cannot do an existence check — report the generic intent; `apply`'s
    // `ensureUser` is idempotent and never resets the password regardless.
    if (ctx.orgId === "") return { actions: [`ensure admin '${email}'`] }
    const [existing] = await ctx.sys("cli-plan-admin", (db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, ctx.orgId), eq(users.email, email)))
        .limit(1),
    )
    return {
      actions: existing
        ? [`admin '${email}' already exists (password left unchanged)`]
        : [`create admin '${email}'`],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const admin = config.admin
    if (!admin) {
      // The tool path brings its own actor; the CLI acts as an existing admin.
      if (ctx.toolPath || ctx.actor.userId !== "" || ctx.orgId === "") return {}
      const [existing] = await ctx.sys("cli-apply-existing-admin", (db) =>
        db
          .select({ id: users.id, email: users.email })
          .from(users)
          .innerJoin(userRoles, eq(userRoles.userId, users.id))
          .innerJoin(roles, eq(roles.id, userRoles.roleId))
          .where(
            and(
              eq(users.orgId, ctx.orgId),
              eq(roles.orgId, ctx.orgId),
              eq(users.status, "active"),
              eq(roles.name, "admin"),
            ),
          )
          .orderBy(asc(users.createdAt), asc(users.id))
          .limit(1),
      )
      if (!existing) {
        ctx.log(
          "no admin section and no active admin in the org: changes are recorded without a person",
        )
        return {}
      }
      ctx.actor.userId = existing.id
      ctx.actor.scopes = ["*"]
      ctx.log(`no admin section: acting as the org's admin '${existing.email}' (${existing.id})`)
      return {}
    }

    const { userId, created } = await ensureUser({
      orgId: ctx.orgId,
      email: admin.email,
      name: admin.name,
      password: admin.password,
      role: "admin",
      allowPasswordless: true,
    })

    // The admin is the actor for every downstream RLS-bound provisioner.
    ctx.actor.userId = userId
    ctx.actor.scopes = ["*"]

    const email = admin.email.toLowerCase()
    ctx.log(
      created
        ? `admin '${email}' created (${userId})`
        : `admin '${email}' already exists (${userId})`,
    )

    const section: AdminSection = { id: userId, email, created }
    return {
      section,
      ...(created ? { changed: ["admin.created"] } : { unchanged: ["admin"] }),
    }
  },
}
