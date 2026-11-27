// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A refund or a cancellation an agent stages is decided by the people in the
// Stripe billing role, not only by administrators. Registration seeds the app
// roles from the manifest, as it does for every org; a person holding only the
// reading tier decides none of them, and Full Member gains no approve scope.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { extendFullMemberRole, seedManifestRoles } from "~/modules/apps/runtime"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Roles = Record<string, { description?: string; extends?: string; scopes: string[] }>

const stripeRoles = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/stripe/app.manifest.json"),
      "utf8",
    ),
  ) as { roles: Roles }
).roles

let orgId = ""
let billing = ""
let reader = ""

const deciders = (scope: string, app: string) =>
  withPrivilegedDb(orgId, "money-role-approvers-test", (tx) =>
    eligibleApprovers(tx, orgId, scope, app),
  )

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await withSystemDb("money-role-approvers-seed", async (tx) => {
    await seedManifestRoles(tx, orgId, "stripe", stripeRoles)
    await extendFullMemberRole(tx, orgId, stripeRoles)
  })
  billing = (await minimal.person(orgId)).id
  reader = (await minimal.person(orgId)).id
  await minimal.assignRole(billing, "stripe.billing")
  await minimal.assignRole(reader, "stripe.member")
})

afterAll(async () => {
  await releaseTestLock()
})

describe("money cards reach the app role that requests them", () => {
  it("a Stripe billing person decides refund and cancellation cards; a Stripe reader does not", async () => {
    const ids = new Set(await deciders("stripe:approve", "stripe"))
    expect(ids.has(billing)).toBe(true)
    expect(ids.has(reader)).toBe(false)
  })

  it("Full Member gains no approve scope from the Stripe app", async () => {
    const rows = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
       WHERE r.org_id = ${orgId} AND r.name = 'Full Member'`
    expect(
      rows.map((r) => r.scope).filter((s) => s.startsWith("stripe:") && s.endsWith(":approve")),
    ).toEqual([])
  })
})
