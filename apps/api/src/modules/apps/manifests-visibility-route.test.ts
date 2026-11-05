// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-user surface visibility on GET /api/apps/manifests.
 *
 * The frontend bootstrap registers an app — and thus its activity-bar icon,
 * settings section, and tab types — solely from this endpoint's response. So
 * filtering it by the requesting user's scopes is what hides an app a user has
 * no access to (no icon, no nav, UI bundle never shipped). Rules under test:
 * - an app that declares scopes is hidden from a user who holds none of them;
 * - granting the user one of the app's scopes reveals it;
 * - a `*` (admin) holder sees the app;
 * - an app that declares NO scopes stays visible to everyone (fail-open).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** Mint a fresh access token reflecting the user's current effective scopes. */
async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("vis-mint", (db) =>
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
  if (!row) throw new Error(`mintToken: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "vis-perms", (tx) =>
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

async function manifestAppNames(token: string): Promise<string[]> {
  const res = await app.request("/api/apps/manifests", {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { data: Array<{ name: string }> }
  return json.data.map((a) => a.name)
}

describe("GET /api/apps/manifests — per-user surface visibility", () => {
  let orgId: string
  let adminId: string
  let memberId: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    adminId = (await minimal.person(orgId, { role: "admin" })).id
    memberId = (await minimal.person(orgId, { role: "member" })).id

    // A scoped app (gated on `widgets:items:read`) and a no-scope app.
    manifestRegistry.set([orgId, "widgets"], {
      name: "widgets",
      roles: { user: { scopes: ["widgets:items:read"] } },
      views: {},
      uiBundleUrl: null,
    })
    manifestRegistry.set([orgId, "freebie"], { name: "freebie", views: {}, uiBundleUrl: null })
    invalidateScopeCatalog(orgId)
  })

  afterAll(async () => {
    manifestRegistry.delete([orgId, "widgets"])
    manifestRegistry.delete([orgId, "freebie"])
    invalidateScopeCatalog(orgId)
    await releaseTestLock()
  })

  test("a member holding none of the app's scopes does NOT see it", async () => {
    const names = await manifestAppNames(await mintToken(memberId))
    expect(names).not.toContain("widgets")
  })

  test("an app that declares no scopes is visible to everyone (fail-open)", async () => {
    const names = await manifestAppNames(await mintToken(memberId))
    expect(names).toContain("freebie")
  })

  test("granting one of the app's scopes reveals it to the member", async () => {
    await minimal.grantScope(memberId, "widgets:items:read")
    const names = await manifestAppNames(await mintToken(memberId))
    expect(names).toContain("widgets")
  })

  test("an admin (`*` scope) sees the scoped app", async () => {
    const names = await manifestAppNames(await mintToken(adminId))
    expect(names).toContain("widgets")
  })
})
