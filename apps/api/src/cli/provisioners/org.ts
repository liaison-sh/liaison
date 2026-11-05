// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Org provisioner (Task 4). Runs FIRST in the canonical order: it ensures the
 * org exists and sets `ctx.orgId` so every downstream provisioner's DB seam
 * scopes to the right org.
 *
 * `plan` is read-only — it looks up the org by slug and records the intended
 * action (create vs update vs skip) for `--dry-run`. `apply` calls the
 * idempotent `ensureOrg` primitive, sets `ctx.orgId`, and contributes the
 * `{ id, slug, created }` report section.
 */
import { eq, sql } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { organizations } from "~/db/schema/kernel"
import { bumpOrgPermissionVersions } from "~/modules/auth/admin-second-factor"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { ensureOrg } from "~/modules/provisioning/ensure-org"

interface OrgSection {
  id: string
  slug: string
  created: boolean
}

export const orgProvisioner: Provisioner<ProvisioningConfig> = {
  key: "org",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const { slug, name } = config.org
    // Read-only existence check via the system seam (no org context yet).
    const [existing] = await ctx.sys("cli-plan-org", (db) =>
      db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1),
    )
    if (!existing) return { actions: [`create org '${slug}' (${name})`] }
    if (existing.name !== name) {
      return { actions: [`update org '${slug}': name '${existing.name}' → '${name}'`] }
    }
    return { actions: [`org '${slug}' already up to date`] }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const { slug, name, timezone, defaultLocale, credits } = config.org
    const { orgId, created } = await ensureOrg({
      slug,
      name,
      timezone,
      locale: defaultLocale,
      credits,
    })
    // Make the org available to every downstream provisioner's DB seam.
    ctx.orgId = orgId
    ctx.log(
      created ? `org '${slug}' created (${orgId})` : `org '${slug}' already exists (${orgId})`,
    )

    const changed: string[] = created ? ["org.created"] : []
    const unchanged: string[] = created ? [] : ["org"]
    const want = config.org.requireAdminSecondFactor
    if (want !== undefined) {
      const bumped = await ctx.priv("cli-org-admin-2fa", async (tx) => {
        const [row] = await tx
          .select({
            on: sql<boolean>`COALESCE((${organizations.settings}->>'requireAdminSecondFactor')::boolean, false)`,
          })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .for("update")
        if ((row?.on === true) === want) return null
        await tx
          .update(organizations)
          .set({
            settings: sql`COALESCE(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify({ requireAdminSecondFactor: want })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId))
        return want ? await bumpOrgPermissionVersions(tx, orgId) : []
      })
      if (bumped === null) {
        unchanged.push("org.requireAdminSecondFactor")
      } else {
        for (const id of bumped) invalidateAuthCache(id)
        changed.push("org.requireAdminSecondFactor")
        ctx.log(
          `org '${slug}': administrators ${want ? "now need" : "no longer need"} two-step verification`,
        )
      }
    }

    const section: OrgSection = { id: orgId, slug, created }
    return {
      section,
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
    }
  },
}
