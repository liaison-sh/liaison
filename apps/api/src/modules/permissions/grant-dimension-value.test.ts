// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #7: the grant_dimension_value backend (grantUserDimension) behind the new gated kernel
// agent tool. Proves: granting a value for a DECLARED dimension (tickets:team) persists + is
// escalation-guarded; an UNDECLARED dimension (e.g. 'territory' — which has no runtime
// create_dimension path, only the admin dimension-catalog) is REJECTED so the agent learns to
// route the DEFINITION to Settings rather than fabricating one; the wildcard '*' is bootstrap-only.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { grantUserDimension } from "~/modules/permissions/roles"
import type { PermissionMutationContext } from "~/modules/permissions/types"

const ADMIN_SCOPES = ["*"] as PermissionMutationContext["actorScopes"]

let orgId: string
let adminId: string
let targetId: string

beforeAll(async () => {
  const slug = `gdim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("gdim-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'GDim Test', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const a = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`admin-${slug}@x.test`}, 'Admin', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    adminId = (a.rows ?? a)[0].id
    const t = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`rep-${slug}@x.test`}, 'US Rep', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    targetId = (t.rows ?? t)[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

// Founder-equivalent actor: holds * (so the user_dimension_grants RLS insert passes) and an
// empty dimensionGrants map (so the escalation guard, which only fires when the actor HAS a
// non-wildcard grant for the dimension, is skipped — the bootstrap admin can grant freely).
// The granting admin holds every dimension value (the admin wildcard): a
// dimension the actor holds no grant on is an empty grant, never unrestricted.
const ADMIN_DIMENSIONS = { "*": ["*"] }

function admin() {
  return {
    actorType: "user" as const,
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
}

describe("grant_dimension_value backend — grantUserDimension (BL-169 #7)", () => {
  it("grants a value for a DECLARED dimension (tickets:team) and persists it", async () => {
    const grant = (await withRlsContext(admin(), (tx) =>
      grantUserDimension(tx, {
        orgId,
        userId: targetId,
        dimension: "tickets:team",
        values: ["support-eu"],
        actorId: adminId,
        actorScopes: ADMIN_SCOPES,
        actorDimensionGrants: ADMIN_DIMENSIONS,
      }),
    )) as { dimensionValues?: string[] } | null
    expect(grant).toBeTruthy()
    expect(grant?.dimensionValues).toEqual(["support-eu"])
  })

  it("REJECTS an undeclared dimension ('territory' is not in the catalog → must be defined in Settings)", async () => {
    await expect(
      withRlsContext(admin(), (tx) =>
        grantUserDimension(tx, {
          orgId,
          userId: targetId,
          dimension: "territory",
          values: ["US"],
          actorId: adminId,
          actorScopes: ADMIN_SCOPES,
          actorDimensionGrants: ADMIN_DIMENSIONS,
        }),
      ),
    ).rejects.toThrow()
  })

  it("rejects the wildcard dimension '*' (bootstrap-only, never via the agent grant)", async () => {
    await expect(
      withRlsContext(admin(), (tx) =>
        grantUserDimension(tx, {
          orgId,
          userId: targetId,
          dimension: "*",
          values: ["US"],
          actorId: adminId,
          actorScopes: ADMIN_SCOPES,
          actorDimensionGrants: ADMIN_DIMENSIONS,
        }),
      ),
    ).rejects.toThrow()
  })

  it("returns null for a target user not in the org", async () => {
    const r = await withRlsContext(admin(), (tx) =>
      grantUserDimension(tx, {
        orgId,
        userId: "00000000-0000-0000-0000-000000000000",
        dimension: "tickets:team",
        values: ["support-us"],
        actorId: adminId,
        actorScopes: ADMIN_SCOPES,
        actorDimensionGrants: ADMIN_DIMENSIONS,
      }),
    )
    expect(r).toBeNull()
  })
})
