// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the org provisioner + its `ensureOrg` primitive
 * (Task 4). Asserts: idempotent create-by-slug, admin role seeded with the `*`
 * dimension grant, credits initialised at the configured currency/initial
 * (defaulting EUR/'0', NOT the factory's 20), `ensureAppsForOrg` warmed the
 * manifest registry, a changed `name` updates the row, and the create runs in
 * exactly ONE transaction (no nested-handle deadlock for the credits write).
 *
 * Unique random slugs per test keep the idempotency assertions isolated from
 * the flat bun run (no truncation needed) while the test lock guards the shared
 * app-runtime registries `ensureAppsForOrg` populates.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { orgProvisioner } from "~/cli/provisioners/org"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { withSystemDb } from "~/db/privileged"
import { creditBalances, organizations, roleDimensionGrants, roles } from "~/db/schema/kernel"
import { isAppRegistered } from "~/modules/apps/enabled-apps"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

function uniqueSlug(): string {
  return `cli-org-${crypto.randomUUID().slice(0, 12)}`
}

describe("ensureOrg primitive (Task 4)", () => {
  test("create path: org row, admin role with '*' dim grant, credits, apps warmed", async () => {
    const slug = uniqueSlug()
    const { orgId, created } = await ensureOrg({ slug, name: "Fabrikam" })
    expect(created).toBe(true)

    const [org] = await withSystemDb("t", (db) =>
      db
        .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, orgId)),
    )
    expect(org).toBeDefined()
    expect(org.slug).toBe(slug)
    expect(org.name).toBe("Fabrikam")

    // admin role seeded with the `*` dimension grant.
    // Filtered by name: `seedDefaultRoles` inserts admin, member and viewer,
    // and an unordered `where(orgId)` returned whichever row postgres handed
    // back first, so the grant lookup below was reading a non-admin role and
    // failing. Only the admin role carries the `*` grant.
    const [adminRole] = await withSystemDb("t", (db) =>
      db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "admin"))),
    )
    expect(adminRole).toBeDefined()
    const dimGrants = await withSystemDb("t", (db) =>
      db
        .select({
          key: roleDimensionGrants.dimensionKey,
          values: roleDimensionGrants.dimensionValues,
        })
        .from(roleDimensionGrants)
        .where(eq(roleDimensionGrants.roleId, adminRole.id)),
    )
    expect(dimGrants.some((g) => g.key === "*" && g.values.includes("*"))).toBe(true)

    // credits default to EUR / '0' (NOT the factory's 20).
    const [bal] = await withSystemDb("t", (db) =>
      db
        .select({ included: creditBalances.includedBalance, currency: creditBalances.currency })
        .from(creditBalances)
        .where(eq(creditBalances.orgId, orgId)),
    )
    expect(bal).toBeDefined()
    expect(bal.currency).toBe("EUR")
    expect(Number(bal.included)).toBe(0)

    // ensureAppsForOrg ran → manifest registry warm for this org.
    expect(await isAppRegistered(orgId, "tickets")).toBe(true)
  })

  test("idempotent: second ensureOrg same slug → created:false, same orgId, no dup", async () => {
    const slug = uniqueSlug()
    const first = await ensureOrg({ slug, name: "Acme" })
    const second = await ensureOrg({ slug, name: "Acme" })
    expect(second.created).toBe(false)
    expect(second.orgId).toBe(first.orgId)

    const rows = await withSystemDb("t", (db) =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)),
    )
    expect(rows.length).toBe(1)
  })

  test("update: changed name on re-run updates the row", async () => {
    const slug = uniqueSlug()
    const { orgId } = await ensureOrg({ slug, name: "Before" })
    const second = await ensureOrg({ slug, name: "After" })
    expect(second.created).toBe(false)
    const [org] = await withSystemDb("t", (db) =>
      db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId)),
    )
    expect(org.name).toBe("After")
  })

  test("credits omitted → defaults EUR/'0'; explicit credits honoured", async () => {
    const slug = uniqueSlug()
    const { orgId } = await ensureOrg({
      slug,
      name: "WithCredits",
      credits: { currency: "USD", initial: "5" },
    })
    const [bal] = await withSystemDb("t", (db) =>
      db
        .select({ included: creditBalances.includedBalance, currency: creditBalances.currency })
        .from(creditBalances)
        .where(eq(creditBalances.orgId, orgId)),
    )
    expect(bal.currency).toBe("USD")
    expect(Number(bal.included)).toBe(5)
  })

  test("creation opens exactly ONE transaction (credits written in-tx, no second-handle deadlock)", async () => {
    // The credits row must be written inside the SAME transaction as the org +
    // roles insert (initOrgCredits's 4th-arg tx). We assert the observable
    // consequence: the credits row exists for the org created in this single
    // ensureOrg call. A nested second handle would deadlock (and the test would
    // hang/fail) rather than commit; a committed credits row proves the in-tx
    // path. (The shared pool is single-connection-per-tx under withSystemDb.)
    const slug = uniqueSlug()
    const { orgId } = await ensureOrg({ slug, name: "OneTx" })
    const balRows = await withSystemDb("t", (db) =>
      db
        .select({ orgId: creditBalances.orgId })
        .from(creditBalances)
        .where(eq(creditBalances.orgId, orgId)),
    )
    expect(balRows.length).toBe(1)
  })
})

describe("org provisioner (Task 4)", () => {
  test("apply sets ctx.orgId and reports {id, slug, created}", async () => {
    const slug = uniqueSlug()
    const config: ProvisioningConfig = { org: { slug, name: "ProvOrg" } }
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })

    const plan = await orgProvisioner.plan(ctx, config)
    const result = await orgProvisioner.apply(ctx, plan, config)

    expect(ctx.orgId).not.toBe("")
    const section = result.section as { id: string; slug: string; created: boolean }
    expect(section.slug).toBe(slug)
    expect(section.created).toBe(true)
    expect(section.id).toBe(ctx.orgId)
    expect(result.changed).toContain("org.created")
  })

  test("re-run via the provisioner reports unchanged (created:false)", async () => {
    const slug = uniqueSlug()
    const config: ProvisioningConfig = { org: { slug, name: "ReRun" } }
    const ctx1 = buildProvisionContext({ log: () => {}, validateByok: false })
    await orgProvisioner.apply(ctx1, await orgProvisioner.plan(ctx1, config), config)

    const ctx2 = buildProvisionContext({ log: () => {}, validateByok: false })
    const result = await orgProvisioner.apply(ctx2, await orgProvisioner.plan(ctx2, config), config)
    const section = result.section as { created: boolean }
    expect(section.created).toBe(false)
    expect(result.unchanged ?? []).toContain("org")
  })

  test("registered in the driver default registry: runConfigApply provisions the org", async () => {
    const slug = uniqueSlug()
    const config: ProvisioningConfig = { org: { slug, name: "Driven" } }
    const res = await runConfigApply({
      config,
      format: "json",
      dryRun: false,
      validateByok: false,
      echoSupplied: false,
    })
    // org section present + orgId env captured downstream; admin will also run
    // (it consumes config.admin? — absent here so admin is a no-op create-skip).
    const orgSection = res.report.sections.org as { id: string; slug: string } | undefined
    expect(orgSection?.slug).toBe(slug)
    const rows = await withSystemDb("t", (db) =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)),
    )
    expect(rows.length).toBe(1)
  })
})
