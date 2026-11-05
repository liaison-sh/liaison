// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { registerKernelBulkApp } from "~/modules/apps/kernel-bulk"
import { signAccessToken } from "~/modules/auth/jwt"
import { everyMemberScopeGrants } from "~/modules/permissions/permissions"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-00000000abc1"
const ADMIN = "00000000-0000-4000-8000-00000000abc2"
const TARGET_A = "00000000-0000-4000-8000-00000000abc3"
const TARGET_B = "00000000-0000-4000-8000-00000000abc4"

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`
}

let token: string

beforeAll(async () => {
  await acquireTestLock()
  // Clean any stray bulk + idempotency cache from previous runs
  await clearRedisPatterns([`bulk:${ORG}:*`, `app_idem:${ORG}:*`])
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Kernel Bulk Org', 'kernel-bulk-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${ADMIN}, ${ORG}, 'kb-admin@test.com', 'KB Admin', 'active')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${TARGET_A}, ${ORG}, 'kb-a@test.com', 'Target A', 'active')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${TARGET_B}, ${ORG}, 'kb-b@test.com', 'Target B', 'active')`
  // Deactivating someone needs every scope they hold (assertActorOutranksTarget), and every
  // active member holds the installed apps' every-member scopes (once the org is set up): so
  // does a real admin's token.
  await awaitOrgApps(ORG)
  const everyMember = await withPrivilegedDb(ORG, "kernel-bulk-test-scopes", (tx) =>
    everyMemberScopeGrants(tx, ADMIN, ORG),
  )
  token = await signAccessToken(
    {
      userId: ADMIN,
      orgId: ORG,
      name: "KB Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:users:admin", ...everyMember.map((g) => g.scope)],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  registerKernelBulkApp(ORG)
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG, "kernel"])
  manifestRegistry.delete([ORG, "kernel"])
  await clearRedisPatterns([`bulk:${ORG}:*`])
  await releaseTestLock()
})

describe("kernel-bulk runtime", () => {
  it("registers kernel.deactivateUsers manifest entry", () => {
    const manifest = manifestRegistry.get([ORG, "kernel"])
    expect(manifest?.bulk?.deactivateUsers).toBeTruthy()
    expect(manifest!.bulk!.deactivateUsers.underlyingTool).toBe("deactivateUser")
    expect(manifest!.bulk!.deactivateUsers.dispatchMode).toBe("perItem")
  })

  it("registers underlying kernel:deactivateUser tool", () => {
    const tool = toolRegistry.get([ORG, "kernel", "deactivateUser"])
    expect(tool).toBeTruthy()
    expect(tool!.requiredScopes).toEqual(["kernel:users:admin"])
  })

  it("registers bulkDeactivateUsers agent tool with bulkMeta", () => {
    const tool = toolRegistry.get([ORG, "kernel", "bulkDeactivateUsers"])
    expect(tool).toBeTruthy()
    expect((tool as any).bulkMeta).toEqual({ app: "kernel", action: "deactivateUsers" })
  })

  it("POST /api/apps/kernel/bulk/deactivateUsers deactivates each user", async () => {
    const res = await app.request("/api/apps/kernel/bulk/deactivateUsers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [TARGET_A, TARGET_B],
        params: {},
        idempotencyKey: uuid(100),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; succeeded: number; failed: number }
    }
    expect(body.data.total).toBe(2)
    expect(body.data.succeeded).toBe(2)
    expect(body.data.failed).toBe(0)
    const [a] = await sql`SELECT status FROM kernel.users WHERE id = ${TARGET_A}`
    const [b] = await sql`SELECT status FROM kernel.users WHERE id = ${TARGET_B}`
    expect(a.status).toBe("deactivated")
    expect(b.status).toBe("deactivated")
  })

  it("self-deactivation surfaces as per-item failure (no crash)", async () => {
    const res = await app.request("/api/apps/kernel/bulk/deactivateUsers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [ADMIN],
        params: {},
        idempotencyKey: uuid(200),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; succeeded: number; failed: number; errors: Array<{ code: string }> }
    }
    expect(body.data.failed).toBe(1)
    expect(body.data.succeeded).toBe(0)
  })
})
