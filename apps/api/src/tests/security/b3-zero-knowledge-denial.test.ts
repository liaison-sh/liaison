// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedExternalApiMockOver10Rows } from "~/tests/security/seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function tokenFor(userId: string): Promise<string> {
  const [row] = await withSystemDb("b3-mint", async (db) =>
    db
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`tokenFor: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "b3-perms", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

describe("B3 — zero-knowledge denial: filtered-to-zero responses carry no info about underlying rows", () => {
  test("two users with no test:market grant get byte-identical filtered responses", async () => {
    // userB: in org B with `test:external:read` scope and zero `test:market` grants.
    const { mockProvider, userB, tokenB } = await seedExternalApiMockOver10Rows(0)

    // userC: a second member in the same org B with the same scope and no grants.
    // Same org → same underlying mock → response must be byte-identical to userB.
    const userC = await minimal.person(userB.orgId)
    await minimal.grantScope(userC.id, "test:external:read")
    const tokenC = await tokenFor(userC.id)

    const app = await buildTestApp()
    const requestFor = async (token: string) =>
      app.request(mockProvider.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ params: { query: "" } }),
      })

    const r1 = await requestFor(tokenB)
    const r2 = await requestFor(tokenC)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = (await r1.json()) as { data: unknown; meta?: { total?: number } }
    const b2 = (await r2.json()) as { data: unknown; meta?: { total?: number } }

    // (1) Data portion is identical.
    expect(b1.data).toEqual(b2.data)
    expect(Array.isArray(b1.data) ? b1.data.length : -1).toBe(0)

    // (2) No count metadata leaks the underlying provider count.
    if (b1.meta?.total !== undefined || b2.meta?.total !== undefined) {
      expect(b1.meta?.total ?? 0).toBe(0)
      expect(b2.meta?.total ?? 0).toBe(0)
    }

    // (3) Stronger check: byte-identity after canonicalising (strip any
    //     server-stamped timestamp/request-id fields the envelope may emit).
    const canonical = (o: { data: unknown; meta?: { total?: number } }) =>
      JSON.stringify({
        data: o.data,
        meta: o.meta?.total !== undefined ? { total: o.meta.total } : undefined,
      })
    expect(canonical(b1)).toBe(canonical(b2))
  })
})
