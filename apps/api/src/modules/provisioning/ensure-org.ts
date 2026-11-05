// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ensureOrg` — idempotent org create/update keyed by slug, for the
 * provisioning CLI (Task 4). Replicates the org-creation half of the test
 * factory's `createSecondOrgWithAdmin` as a REUSABLE, non-test primitive:
 * insert org + `seedDefaultRoles` + the admin role's `*` dimension grant +
 * credits — all inside ONE `withSystemDb` transaction — then warm the app
 * runtime with `ensureAppsForOrg` AFTER the tx commits.
 *
 * Handle: `withSystemDb` (org bootstrap is a cross-table, pre-actor write).
 *
 * Corrections honoured:
 *  - #10: `initOrgCredits(orgId, currency, initial, tx)` is passed the SAME tx
 *    (4th arg) so the credits row is written in-transaction — nesting a new
 *    `withPrivilegedDb` here would open a second pool handle and deadlock.
 *  - #10: `ensureAppsForOrg` opens its OWN `withSystemDb`, so it runs AFTER the
 *    create tx commits (never nested), matching the factory + bootstrap pattern.
 *  - Default credits EUR / '0' (NOT the bootstrap path's 20).
 *
 * A created org gets what the browser's first Register gives one, so an
 * instance provisioned only by `liaison config apply` (no Register click) is
 * complete: the `@base` system agent (in the create tx), then, once the apps
 * are registered, the Google login provider (a no-op without GOOGLE_OAUTH_*)
 * and the manifest-declared default saved views. All three are idempotent,
 * and the last two run on every call, so a re-run completes an older org.
 */
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations, roleDimensionGrants } from "~/db/schema/kernel"
import { initOrgCredits } from "~/modules/agent/credits/credit-service"
import { ensureBaseAgentTx } from "~/modules/agent/directory/base-agent"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureGoogleLoginProvider } from "~/modules/auth/google-login-provider"
import { seedDefaultRoles } from "~/modules/permissions/default-roles"
import { seedManifestDefaults } from "~/modules/saved-views/seed"

export interface EnsureOrgInput {
  slug: string
  name: string
  timezone?: string
  locale?: string
  credits?: { currency?: string; initial?: string }
}

export interface EnsureOrgResult {
  orgId: string
  created: boolean
}

const DEFAULT_CREDITS_CURRENCY = "EUR"
const DEFAULT_CREDITS_INITIAL = "0"

/**
 * Create (or update-in-place) an org identified by its unique `slug`. Returns
 * the org id and whether this call created it.
 */
export async function ensureOrg(input: EnsureOrgInput): Promise<EnsureOrgResult> {
  const { slug, name, timezone, locale, credits } = input

  const result = await withSystemDb("cli-ensure-org", async (tx) => {
    const [existing] = await tx
      .select({
        id: organizations.id,
        name: organizations.name,
        timezone: organizations.timezone,
        defaultLocale: organizations.defaultLocale,
      })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1)

    if (existing) {
      // Update only the fields that changed — leave `updated_at` untouched
      // when nothing differs so a no-op re-run is observably idempotent.
      const patch: { name?: string; timezone?: string; defaultLocale?: string } = {}
      if (name !== existing.name) patch.name = name
      if (timezone !== undefined && timezone !== existing.timezone) patch.timezone = timezone
      if (locale !== undefined && locale !== existing.defaultLocale) patch.defaultLocale = locale
      if (Object.keys(patch).length > 0) {
        await tx.update(organizations).set(patch).where(eq(organizations.id, existing.id))
      }
      return { orgId: existing.id, created: false }
    }

    const [org] = await tx
      .insert(organizations)
      .values({
        name,
        slug,
        ...(timezone !== undefined ? { timezone } : {}),
        ...(locale !== undefined ? { defaultLocale: locale } : {}),
      })
      .returning({ id: organizations.id })

    const adminRole = await seedDefaultRoles(tx, org.id)
    await tx
      .insert(roleDimensionGrants)
      .values({ roleId: adminRole.id, dimensionKey: "*", dimensionValues: ["*"] })

    // SAME tx (4th arg) — never a nested second handle (correction #10).
    await initOrgCredits(
      org.id,
      credits?.currency ?? DEFAULT_CREDITS_CURRENCY,
      credits?.initial ?? DEFAULT_CREDITS_INITIAL,
      tx,
    )

    // The org-wide `@base` system agent, as bootstrapRegister creates it.
    await ensureBaseAgentTx(tx, org.id)

    return { orgId: org.id, created: true }
  })

  // AFTER the tx commits — ensureAppsForOrg opens its own withSystemDb.
  await ensureAppsForOrg(result.orgId)

  // On every run, not only at creation: both are idempotent, and an org
  // created before they existed (or whose first run stopped part way) gets
  // them on the next apply.
  await ensureGoogleLoginProvider(result.orgId)
  // Needs the manifests ensureAppsForOrg just registered for this org.
  await withPrivilegedDb(result.orgId, "cli-ensure-org-saved-views", (tx) =>
    seedManifestDefaults(tx, result.orgId),
  )

  return result
}
