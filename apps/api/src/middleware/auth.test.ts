// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { sql } from "~/db"
import { authMiddleware, invalidateAuthCache } from "~/middleware/auth"
import { errorHandler } from "~/middleware/error-handler"
import { requireScope } from "~/middleware/require-scope"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { signAccessToken } from "~/modules/auth/jwt"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"
const ORG_ID = "00000000-0000-0000-0000-a00000000001"
const USER_ID = "00000000-0000-0000-0000-a00000000002"
const USER_123_ID = "00000000-0000-0000-0000-a00000000003"

const LIMITED_USER_ID = "00000000-0000-0000-0000-a00000000005"
const ROLE_ID = "00000000-0000-0000-0000-a00000000004"
const LIMITED_ROLE_ID = "00000000-0000-0000-0000-a00000000006"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'Auth Middleware Test Org', 'auth-mw-test')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${USER_ID}, ${ORG_ID}, 'auth-mw-user-1@test.com', 'Test User', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${USER_123_ID}, ${ORG_ID}, 'auth-mw-user-123@test.com', 'Test User 123', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
  // Create role with kernel:admin scope for requireScope tests
  await sql`INSERT INTO kernel.roles (id, org_id, name, description)
    VALUES (${ROLE_ID}, ${ORG_ID}, 'admin-mw-test', 'Test admin role')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
    VALUES (${ROLE_ID}, 'kernel')
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
    VALUES (${USER_ID}, ${ROLE_ID}, ${ORG_ID})
    ON CONFLICT DO NOTHING`
  // Limited user with only test:items:read
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${LIMITED_USER_ID}, ${ORG_ID}, 'auth-mw-limited@test.com', 'Limited User', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.roles (id, org_id, name, description)
    VALUES (${LIMITED_ROLE_ID}, ${ORG_ID}, 'limited-mw-test', 'Test limited role')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
    VALUES (${LIMITED_ROLE_ID}, 'test:items:read')
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
    VALUES (${LIMITED_USER_ID}, ${LIMITED_ROLE_ID}, ${ORG_ID})
    ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ROLE_ID}, ${LIMITED_ROLE_ID})`
  await sql`DELETE FROM kernel.roles WHERE id IN (${ROLE_ID}, ${LIMITED_ROLE_ID})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

function createTestApp() {
  const app = new Hono()
  app.onError(errorHandler)
  app.use("/protected/*", authMiddleware(TEST_SECRET))
  app.get("/protected/resource", (c) => {
    return c.json({ data: { userId: (c as any).get("userId") } })
  })
  app.get("/protected/admin", requireScope("kernel:admin"), (c) => {
    return c.json({ data: "admin" })
  })
  app.get("/public", (c) => c.json({ data: "public" }))
  return app
}

describe("auth middleware", () => {
  const app = createTestApp()

  it("allows access with valid token", async () => {
    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    const res = await app.request("/protected/resource", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.userId).toBe(USER_ID)
  })

  it("rejects request without token", async () => {
    const res = await app.request("/protected/resource")
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ error: { message: expect.any(String) } })
  })

  it("rejects expired token", async () => {
    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
      -1,
    )
    const res = await app.request("/protected/resource", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ error: { message: expect.any(String) } })
  })

  it("rejects malformed authorization header", async () => {
    const res = await app.request("/protected/resource", {
      headers: { Authorization: "NotBearer xyz" },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ error: { message: expect.any(String) } })
  })

  it("does not apply to public routes", async () => {
    const res = await app.request("/public")
    expect(res.status).toBe(200)
  })

  it("rejects an MCP connection token on the REST surface (token-class isolation)", async () => {
    // A valid, unexpired, correctly-signed token for an active user — but it
    // carries mcpConnectionId, so it is an MCP-class credential and must NOT
    // authenticate the general REST API (closes the post-revoke / leaked-MCP
    // -token REST-access divergence).
    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        mcpConnectionId: "conn-xyz",
      },
      TEST_SECRET,
    )
    const res = await app.request("/protected/resource", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })
})

describe("auth middleware — logger enrichment", () => {
  it("enriches pino logger with userId and orgId after auth", async () => {
    let capturedBindings: Record<string, unknown> = {}

    const testApp = new Hono()
    // Simulate a pino-like logger on every request
    testApp.use(async (c, next) => {
      const mockLogger = {
        child(bindings: Record<string, unknown>) {
          const childLogger = {
            ...mockLogger,
            _bindings: { ...bindings },
            bindings() {
              return this._bindings
            },
          }
          return childLogger
        },
        _bindings: {} as Record<string, unknown>,
        bindings() {
          return this._bindings
        },
      }
      ;(c as any).set("logger", mockLogger)
      await next()
    })
    testApp.use(authMiddleware(TEST_SECRET))
    testApp.get("/test", (c) => {
      const logger = (c as any).get("logger")
      if (logger?.bindings) {
        capturedBindings = logger.bindings()
      }
      return c.json({ ok: true })
    })

    const token = await signAccessToken(
      {
        userId: USER_123_ID,
        orgId: ORG_ID,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    await testApp.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(capturedBindings.userId).toBe(USER_123_ID)
    expect(capturedBindings.orgId).toBe(ORG_ID)
  })

  it("does not crash when no logger is set on context", async () => {
    const testApp = new Hono()
    // No logger middleware — logger is undefined
    testApp.use(authMiddleware(TEST_SECRET))
    testApp.get("/test", (c) => c.json({ ok: true }))

    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    const res = await testApp.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe("requireScope middleware", () => {
  const app = createTestApp()

  it("allows access with matching scope", async () => {
    const token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      TEST_SECRET,
    )
    const res = await app.request("/protected/admin", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("rejects access without matching scope", async () => {
    const token = await signAccessToken(
      {
        userId: LIMITED_USER_ID,
        orgId: ORG_ID,
        name: "Limited User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["test:items:read"],
      },
      TEST_SECRET,
    )
    const res = await app.request("/protected/admin", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ error: { message: expect.any(String) } })
  })
})

describe("auth middleware — permissionVersion staleness", () => {
  const app = createTestApp()

  it("rejects token when permissionVersion is stale", async () => {
    // Token with permissionVersion=1
    const token = await signAccessToken(
      { userId: USER_ID, orgId: ORG_ID, name: "Test User", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )

    // Bump permissionVersion in DB to 2
    await sql`UPDATE kernel.users SET permission_version = 2 WHERE id = ${USER_ID}`

    // Clear auth cache so the next request hits DB
    invalidateAuthCache()

    const res = await app.request("/protected/resource", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)

    // Restore for other tests
    await sql`UPDATE kernel.users SET permission_version = 1 WHERE id = ${USER_ID}`
    invalidateAuthCache()
  })
})

// An org whose deletion has started (organizations.deleting_at, modules/org/purge/)
// answers every request 410 ORG_DELETED, even with a valid token of a live user.
describe("auth middleware: an org being deleted", () => {
  const DELETING_ORG = "00000000-0000-0000-0000-a0000000d011"
  const DELETING_USER = "00000000-0000-0000-0000-a0000000d012"
  const app = createTestApp()

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${DELETING_ORG}, 'Deleting Org', 'auth-mw-deleting')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${DELETING_USER}, ${DELETING_ORG}, 'auth-mw-deleting@test.com', 'Deleting User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE org_id = ${DELETING_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${DELETING_ORG}`
    forgetOrgApps(DELETING_ORG)
  })

  async function request(): Promise<Response> {
    const token = await signAccessToken(
      {
        userId: DELETING_USER,
        orgId: DELETING_ORG,
        name: "Deleting User",
        authVersion: 1,
        permissionVersion: 1,
      },
      TEST_SECRET,
    )
    return app.request("/protected/resource", { headers: { Authorization: `Bearer ${token}` } })
  }

  it("serves the org while it is live, then answers 410 ORG_DELETED once deleting_at is set", async () => {
    forgetOrgApps(DELETING_ORG)
    expect((await request()).status).toBe(200)
    await sql`UPDATE kernel.organizations SET deleting_at = now() WHERE id = ${DELETING_ORG}`
    // The deletion publishes the org-apps invalidation; this process drops its entry.
    forgetOrgApps(DELETING_ORG)
    const res = await request()
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: { code?: string } }
    expect(body.error.code).toBe("ORG_DELETED")
  })
})
