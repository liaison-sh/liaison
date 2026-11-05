// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_A = "00000000-0000-0000-0000-0000005c0001"
const ORG_B = "00000000-0000-0000-0000-0000005c0002"
const USER_A = "00000000-0000-0000-0000-0000005c0011" // requester in orgA
const USER_A2 = "00000000-0000-0000-0000-0000005c0012" // other non-admin in orgA
const ADMIN_A = "00000000-0000-0000-0000-0000005c0013" // scope-requests admin in orgA
const USER_B = "00000000-0000-0000-0000-0000005c0021" // user in orgB

describe("scope_requests RLS", () => {
  let reqId: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG_A}, 'ScopeReqOrgA', 'scope-req-org-a'),
      (${ORG_B}, 'ScopeReqOrgB', 'scope-req-org-b') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${USER_A}, ${ORG_A}, 'sr-a@test.com', 'SR User A', 'x'),
      (${USER_A2}, ${ORG_A}, 'sr-a2@test.com', 'SR User A2', 'x'),
      (${ADMIN_A}, ${ORG_A}, 'sr-admin-a@test.com', 'SR Admin A', 'x'),
      (${USER_B}, ${ORG_B}, 'sr-b@test.com', 'SR User B', 'x') ON CONFLICT DO NOTHING`

    // Insert a request in orgA as userA (self-targeted, satisfies INSERT policy).
    reqId = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG_A,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      async (tx) => {
        const rows = await tx.execute(
          drizzleSql`INSERT INTO kernel.scope_requests
            (org_id, requested_by, requested_by_type, target_user_id, requested_scopes, status)
            VALUES (${ORG_A}::uuid, ${USER_A}::uuid, 'user', ${USER_A}::uuid,
              ARRAY['kernel:contacts:write'], 'pending')
            RETURNING id`,
        )
        return (rows[0] as { id: string }).id
      },
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_requests WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
    await releaseTestLock()
  })

  it("a scope_request is invisible across orgs and to non-admin non-owners", async () => {
    // Cross-org read → 0 rows.
    const fromB = await withRlsContext(
      { actorType: "user", userId: USER_B, orgId: ORG_B, scopes: ["*"], dimensionGrants: {} },
      (tx) =>
        tx.execute(drizzleSql`SELECT id FROM kernel.scope_requests WHERE id = ${reqId}::uuid`),
    )
    expect(fromB).toHaveLength(0)

    // Same-org, different non-admin user (not requester, not target) → 0 rows.
    const otherInA = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A2,
        orgId: ORG_A,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (tx) =>
        tx.execute(drizzleSql`SELECT id FROM kernel.scope_requests WHERE id = ${reqId}::uuid`),
    )
    expect(otherInA).toHaveLength(0)

    // Same-org scope_requests admin → 1 row.
    const adminInA = await withRlsContext(
      {
        actorType: "user",
        userId: ADMIN_A,
        orgId: ORG_A,
        scopes: ["kernel:scope_requests:admin"],
        dimensionGrants: {},
      },
      (tx) =>
        tx.execute(drizzleSql`SELECT id FROM kernel.scope_requests WHERE id = ${reqId}::uuid`),
    )
    expect(adminInA).toHaveLength(1)

    // The requester themselves → 1 row.
    const requesterInA = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG_A,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (tx) =>
        tx.execute(drizzleSql`SELECT id FROM kernel.scope_requests WHERE id = ${reqId}::uuid`),
    )
    expect(requesterInA).toHaveLength(1)

    // A `kernel:scope_requests:*` wildcard holder satisfies the admin scope (per
    // hasScope's trailing-wildcard rule) and the RLS SELECT policy enumerates it
    // too (M2 reconcile) → 1 row. Without the RLS wildcard arm this would be 0.
    const wildcardInA = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A2,
        orgId: ORG_A,
        scopes: ["kernel:scope_requests:*"],
        dimensionGrants: {},
      },
      (tx) =>
        tx.execute(drizzleSql`SELECT id FROM kernel.scope_requests WHERE id = ${reqId}::uuid`),
    )
    expect(wildcardInA).toHaveLength(1)
  })

  it("INSERT for someone else (requested_by != current user) is blocked by RLS", async () => {
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A2,
          orgId: ORG_A,
          scopes: ["kernel:threads:read"],
          dimensionGrants: {},
        },
        (tx) =>
          tx.execute(
            drizzleSql`INSERT INTO kernel.scope_requests
              (org_id, requested_by, requested_by_type, target_user_id, requested_scopes)
              VALUES (${ORG_A}::uuid, ${USER_A}::uuid, 'user', ${USER_A}::uuid,
                ARRAY['kernel:contacts:write'])`,
          ),
      ),
    ).rejects.toThrow()
  })

  it("INSERT targeting another user (target_user_id != current) is blocked by RLS", async () => {
    // Pins the second INSERT-policy conjunct: requested_by = self is not enough,
    // target_user_id must also equal the current user (requests are self-targeted).
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG_A,
          scopes: ["kernel:threads:read"],
          dimensionGrants: {},
        },
        (tx) =>
          tx.execute(
            drizzleSql`INSERT INTO kernel.scope_requests
              (org_id, requested_by, requested_by_type, target_user_id, requested_scopes)
              VALUES (${ORG_A}::uuid, ${USER_A}::uuid, 'user', ${USER_A2}::uuid,
                ARRAY['kernel:contacts:write'])`,
          ),
      ),
    ).rejects.toThrow()
  })
})
