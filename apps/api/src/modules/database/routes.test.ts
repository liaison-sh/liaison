// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/database/domain-access against the real database: admin only, the
// write validated (shape, and every role and person belonging to the org),
// only `settings.database.domainAccess` touched; and the bridge's production
// lookups (the org's rules, the caller's own roles) read what the route wrote.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { loadDomainAccessCaller, loadOrgDomainAccess } from "~/apps/database/domain-access-store"
import { withSystemDb } from "~/db/privileged"
import { organizations, roles, userRoles, users } from "~/db/schema/kernel"
import { errorHandler } from "~/middleware/error-handler"
import { databaseRoutes } from "~/modules/database/routes"
import { createScope } from "~/modules/permissions/types"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let OTHER_ORG = ""
let ADMIN = ""
let MEMBER = ""
let FINANCE_ROLE = ""
let FOREIGN_ROLE = ""

function makeApp(scopes: string[], userId = ADMIN) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("userId", userId)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/database", databaseRoutes)
  return app
}

function put(scopes: string[], body: unknown) {
  return makeApp(scopes).request("/api/database/domain-access", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  const a = await minimal.secondOrg()
  ORG = a.orgId
  ADMIN = a.adminUserId
  OTHER_ORG = (await minimal.secondOrg()).orgId
  await withSystemDb("test-domain-access-seed", async (db) => {
    const [finance] = await db
      .insert(roles)
      .values({ orgId: ORG, name: "finance", description: "finance" })
      .returning({ id: roles.id })
    FINANCE_ROLE = finance.id
    const [foreign] = await db
      .insert(roles)
      .values({ orgId: OTHER_ORG, name: "finance", description: "other org" })
      .returning({ id: roles.id })
    FOREIGN_ROLE = foreign.id
    const [member] = await db
      .insert(users)
      .values({
        orgId: ORG,
        email: `fin-${crypto.randomUUID()}@t.co`,
        name: "Fin",
        status: "active",
      })
      .returning({ id: users.id })
    MEMBER = member.id
    await db.insert(userRoles).values({ userId: MEMBER, roleId: FINANCE_ROLE, orgId: ORG })
    // A sibling key under `database` and one beside it: both must survive a write.
    await db
      .update(organizations)
      .set({
        settings: drizzleSql`COALESCE(settings, '{}'::jsonb) || '{"database":{"keep":1},"webFetchAllowlist":["a.example"]}'::jsonb`,
      })
      .where(eq(organizations.id, ORG))
  })
})

afterAll(async () => {
  await withSystemDb("test-domain-access-cleanup", async (db) => {
    for (const org of [ORG, OTHER_ORG]) {
      await db.delete(userRoles).where(eq(userRoles.orgId, org))
      await db.delete(users).where(eq(users.orgId, org))
      await db.delete(roles).where(eq(roles.orgId, org))
      await db.delete(organizations).where(eq(organizations.id, org))
    }
  }).catch(() => {})
  await releaseTestLock()
})

describe("GET/PUT /api/database/domain-access", () => {
  it("refuses a caller without kernel:apps:admin, on read and on write", async () => {
    const res = await makeApp(["database:reads:read", "database:query:read"]).request(
      "/api/database/domain-access",
    )
    expect(res.status).toBe(403)
    const write = await put(["database:*"], { domainAccess: {} })
    expect(write.status).toBe(403)
  })

  it("rejects a malformed body", async () => {
    for (const body of [
      { domainAccess: { revenue: { tier: "secret" } } },
      { domainAccess: { revenue: { tier: "confidential", roles: ["not-a-uuid"] } } },
      { domainAccess: { revenue: { tier: "internal", extra: true } } },
      { domainAccess: {}, other: 1 },
    ]) {
      const res = await put(["kernel:apps:admin"], body)
      expect(res.status).toBe(400)
    }
  })

  it("rejects a role or person of another org", async () => {
    const res = await put(["kernel:apps:admin"], {
      domainAccess: { revenue: { tier: "confidential", roles: [FOREIGN_ROLE] } },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain("domainAccess.revenue.roles")
    expect(await loadOrgDomainAccess(ORG)).toEqual({})
  })

  it("writes the map, keeps every sibling setting, and the bridge lookups read it", async () => {
    const domainAccess = {
      revenue: { tier: "confidential", roles: [FINANCE_ROLE] },
      customers: { tier: "restricted", users: [MEMBER] },
    }
    const res = await put(["kernel:apps:admin"], { domainAccess })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { domainAccess: unknown; roles: { id: string }[] } }
    expect(body.data.domainAccess).toEqual(domainAccess)
    expect(body.data.roles.map((r) => r.id)).toContain(FINANCE_ROLE)

    const [row] = await withSystemDb("test-domain-access-read", (db) =>
      db
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, ORG)),
    )
    const settings = row?.settings as Record<string, any>
    expect(settings.database.keep).toBe(1)
    expect(settings.webFetchAllowlist).toEqual(["a.example"])

    expect(await loadOrgDomainAccess(ORG)).toEqual(domainAccess as never)
    const caller = await loadDomainAccessCaller(ORG, MEMBER)
    expect(caller).toMatchObject({ kind: "person", userId: MEMBER })
    expect(caller.kind === "person" && caller.roleIds).toContain(FINANCE_ROLE)
    expect(await loadDomainAccessCaller(ORG, "system:knowledge:sync")).toEqual({ kind: "system" })
  })

  it("lists the connected catalog's domains with their reads and effective tier", async () => {
    const res = await makeApp(["kernel:apps:admin"]).request("/api/database/domain-access")
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: {
        adapter: string | null
        domains: { domain: string; reads: unknown[]; effectiveTier: string }[]
      }
    }
    expect(data.adapter).not.toBeNull()
    expect(data.domains.length).toBeGreaterThan(0)
    for (const d of data.domains) {
      expect(d.reads.length).toBeGreaterThan(0)
      expect(d.effectiveTier).toBe("internal")
    }
  })
})
