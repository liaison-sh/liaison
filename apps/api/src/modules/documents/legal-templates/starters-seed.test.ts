// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The starters reach an organisation's document templates: the missing ones
// are added in the organisation's own transaction, an organisation's own
// changes are kept, the corporate acts follow their feature, and another
// organisation sees none of them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { documentTemplates } from "~/db/schema/kernel"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { setOrgAppFeature } from "~/modules/apps/org-features"
import { seedManifestDefaults } from "~/modules/saved-views/seed"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { STARTER_RECORD_TYPE, seedLegalStarterTemplates } from "./starters"

let orgId = ""
let userId = ""
let otherOrgId = ""
let otherUserId = ""

const asAdmin = <T>(org: string, user: string, fn: Parameters<typeof withRlsContext<T>>[1]) =>
  withRlsContext<T>(
    { actorType: "user", userId: user, orgId: org, scopes: ["*"], dimensionGrants: {} },
    fn,
  )

async function starters(org: string, user: string) {
  return asAdmin(org, user, (tx) =>
    tx
      .select({ id: documentTemplates.id, name: documentTemplates.name })
      .from(documentTemplates)
      .where(eq(documentTemplates.recordType, STARTER_RECORD_TYPE)),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.orgAdmin(orgId)).id
  const second = await minimal.secondOrg()
  otherOrgId = second.orgId
  otherUserId = second.adminUserId
}, 180_000)

afterAll(async () => {
  for (const [org, user] of [
    [orgId, userId],
    [otherOrgId, otherUserId],
  ] as const) {
    if (!org) continue
    await asAdmin(org, user, (tx) =>
      tx
        .delete(documentTemplates)
        .where(
          and(
            eq(documentTemplates.orgId, org),
            eq(documentTemplates.recordType, STARTER_RECORD_TYPE),
          ),
        ),
    )
  }
  await releaseTestLock()
})

describe("seeding the starter templates", () => {
  it("adds the fourteen services starters with the corporate feature off, and nothing to another organisation", async () => {
    const added = await asAdmin(orgId, userId, (tx) =>
      seedLegalStarterTemplates(tx, orgId, { corporateTemplates: false }),
    )
    expect(added).toHaveLength(14)
    expect(await starters(orgId, userId)).toHaveLength(14)
    expect(await starters(otherOrgId, otherUserId)).toHaveLength(0)
  })

  it("runs again without duplicating, and keeps an organisation's archived starter archived", async () => {
    const [first] = await starters(orgId, userId)
    await asAdmin(orgId, userId, (tx) =>
      tx
        .update(documentTemplates)
        .set({ archivedAt: new Date() })
        .where(eq(documentTemplates.id, first?.id ?? "")),
    )
    const again = await asAdmin(orgId, userId, (tx) =>
      seedLegalStarterTemplates(tx, orgId, { corporateTemplates: false }),
    )
    expect(again).toEqual([])
    expect(await starters(orgId, userId)).toHaveLength(14)
  })

  it("adds the three corporate acts in both languages once the feature is on", async () => {
    const added = await asAdmin(orgId, userId, (tx) =>
      seedLegalStarterTemplates(tx, orgId, { corporateTemplates: true }),
    )
    expect(added).toHaveLength(6)
    expect(await starters(orgId, userId)).toHaveLength(20)
  })
})

describe("the kernel seeder brings the starters to an organisation using agreements", () => {
  it("the org's manifest defaults add the services starters, and switching corporate templates on adds the corporate acts", async () => {
    // The agreements app as the registry holds it once registered for the org: its features
    // and its declaration that it wants the legal starters.
    const registered = manifestRegistry.get([otherOrgId, "agreements"])
    if (!registered)
      manifestRegistry.set([otherOrgId, "agreements"], {
        name: "agreements",
        displayName: "Agreements",
        legalStarterTemplates: { corporateFeature: "corporateTemplates" },
        features: {
          corporateTemplates: {
            adminScope: "agreements:templates:write",
            labelKey: "agreements.features.corporateTemplates",
          },
        },
      } as never)
    try {
      await withPrivilegedDb(otherOrgId, "test-starters-seed", (tx) =>
        seedManifestDefaults(tx, otherOrgId),
      )
      expect(await starters(otherOrgId, otherUserId)).toHaveLength(14)
      await setOrgAppFeature({
        orgId: otherOrgId,
        app: "agreements",
        feature: "corporateTemplates",
        enabled: true,
        actor: { userId: otherUserId, scopes: ["*"] },
      })
      expect(await starters(otherOrgId, otherUserId)).toHaveLength(20)
      await setOrgAppFeature({
        orgId: otherOrgId,
        app: "agreements",
        feature: "corporateTemplates",
        enabled: false,
        actor: { userId: otherUserId, scopes: ["*"] },
      })
    } finally {
      if (!registered) manifestRegistry.delete([otherOrgId, "agreements"])
    }
  })
})
