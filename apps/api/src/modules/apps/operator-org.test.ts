// SPDX-License-Identifier: FSL-1.1-ALv2
// Installs, upgrades, removals and interface approvals change what runs for every
// org on the instance, so on a multi-tenant instance (demo mode, managed edition)
// only the instance operator's org may make them, while every other `/api/apps/*`
// route keeps serving every org. A single-org self-host is not restricted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import {
  canManageInstanceApps,
  resetOperatorOrgCache,
  resolveOperatorOrgId,
} from "~/modules/apps/operator-org"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const OPERATOR = "00000000-0000-4000-8000-0000000aad01"
const TENANT = "00000000-0000-4000-8000-0000000aad02"
const OP_USER = "00000000-0000-4000-8000-0000000aad11"
const TENANT_USER = "00000000-0000-4000-8000-0000000aad12"

let saved: string | undefined
const setOperator = (v: string | undefined) => {
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = v
  resetOperatorOrgCache()
}

function bearer(userId: string, orgId: string, scopes: string[] = ["*"]) {
  return signAccessToken(
    {
      userId,
      orgId,
      name: "Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: { "*": ["*"] },
    },
    env.JWT_SECRET,
  )
}

async function call(
  path: string,
  userId: string,
  orgId: string,
  init: RequestInit = {},
  scopes?: string[],
) {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${await bearer(userId, orgId, scopes)}`,
      "Content-Type": "application/json",
    },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  saved = env.LIAISON_OPERATOR_ORG_ID
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
    (${OPERATOR}, 'Operator', 'op-org-test'), (${TENANT}, 'Tenant', 'tenant-org-test')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES
    (${OP_USER}, ${OPERATOR}, 'op-admin@test.com', 'Op'), (${TENANT_USER}, ${TENANT}, 'tenant-admin@test.com', 'Tenant')`
})
afterAll(async () => {
  _setEdition(null)
  DemoModeTestAccess.set(null)
  setOperator(saved)
  await sql`DELETE FROM kernel.users WHERE id IN (${OP_USER}, ${TENANT_USER})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${OPERATOR}, ${TENANT})`
  await releaseTestLock()
})

const MUTATING_ROUTES: Array<[string, string]> = [
  ["DELETE", "/api/apps/some-app"],
  ["POST", "/api/apps/some-app/ui-approval"],
  ["POST", "/api/apps/some-app/upgrade/apply"],
  ["POST", "/api/apps/some-app/upgrade/preview"],
  ["POST", "/api/apps/catalog/some-app/install"],
  ["POST", "/api/apps/install"],
  ["POST", "/api/apps/preflight"],
  ["POST", "/api/apps/some-app/rollback"],
]

describe("instance-wide app management on a single-org self-host", () => {
  it("lets any admin with the app admin scope through, whatever LIAISON_OPERATOR_ORG_ID says", async () => {
    _setEdition("self_hosted")
    DemoModeTestAccess.set(false)
    for (const operator of [OPERATOR, undefined]) {
      setOperator(operator)
      for (const [method, path] of MUTATING_ROUTES) {
        const res = await call(path, TENANT_USER, TENANT, { method, body: "{}" })
        expect([method, path, res.status === 403]).toEqual([method, path, false])
      }
    }
  })
})

describe("instance-wide app management on a multi-tenant instance", () => {
  it("refuses another org's admin on every route that changes the installs, in demo mode and on managed", async () => {
    setOperator(OPERATOR)
    for (const [edition, demo] of [
      ["managed", false],
      ["self_hosted", true],
    ] as const) {
      _setEdition(edition)
      DemoModeTestAccess.set(demo)
      for (const [method, path] of MUTATING_ROUTES) {
        const res = await call(path, TENANT_USER, TENANT, { method, body: "{}" })
        expect([edition, method, path, res.status]).toEqual([edition, method, path, 403])
      }
    }
    _setEdition("managed")
    DemoModeTestAccess.set(false)
  })

  it("lets the operator org through the gate", async () => {
    _setEdition("managed")
    setOperator(OPERATOR)
    const res = await call("/api/apps/no-such-app/ui-approval", OP_USER, OPERATOR, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    })
    expect(res.status).toBe(404)
  })

  it("does not stand in front of the other /api/apps routes", async () => {
    setOperator(OPERATOR)
    const res = await call("/api/apps/manifests", TENANT_USER, TENANT)
    expect(res.status).not.toBe(403)
  })

  it("without the setting, the operator is the instance's first org (demo mode)", async () => {
    _setEdition("self_hosted")
    DemoModeTestAccess.set(true)
    setOperator(undefined)
    const first = await resolveOperatorOrgId()
    const [row] = await sql`SELECT id FROM kernel.organizations ORDER BY created_at, id LIMIT 1`
    expect(first).toBe(row.id as string)
    const res = await call("/api/apps/some-app", TENANT_USER, TENANT, { method: "DELETE" })
    expect(res.status).toBe(403)
  })

  it("a fresh lookup skips a cached first org that was deleted since", async () => {
    _setEdition("self_hosted")
    setOperator(undefined)
    const GONE = "00000000-0000-4000-8000-0000000aad03"
    await sql`INSERT INTO kernel.organizations (id, name, slug, created_at)
      VALUES (${GONE}, 'Gone Org', 'gone-org-aad03', '2000-01-01') ON CONFLICT (id) DO NOTHING`
    try {
      expect(await resolveOperatorOrgId()).toBe(GONE)
    } finally {
      await sql`DELETE FROM kernel.organizations WHERE id = ${GONE}`
    }
    expect(await resolveOperatorOrgId()).toBe(GONE)
    expect(await resolveOperatorOrgId({ fresh: true })).not.toBe(GONE)
  })
})

describe("the managed edition (LIAISON_EDITION=managed)", () => {
  const savedEdition = env.LIAISON_EDITION
  const setEditionEnv = (v: "managed" | "self_hosted" | undefined) => {
    ;(env as { LIAISON_EDITION?: string }).LIAISON_EDITION = v
  }
  beforeEach(() => {
    _setEdition(null)
    DemoModeTestAccess.set(false)
    setEditionEnv("managed")
  })
  afterEach(() => {
    setEditionEnv(savedEdition)
    _setEdition(null)
  })

  it("the operator is LIAISON_OPERATOR_ORG_ID, never the instance's first org", async () => {
    setOperator(undefined)
    expect(await resolveOperatorOrgId()).toBeNull()
    expect(await resolveOperatorOrgId({ fresh: true })).toBeNull()
    setOperator(OPERATOR)
    expect(await resolveOperatorOrgId()).toBe(OPERATOR)
  })

  it("without the setting, no org may change the installs, not even the first one", async () => {
    setOperator(undefined)
    const [first] = await sql`SELECT id FROM kernel.organizations ORDER BY created_at, id LIMIT 1`
    expect(await canManageInstanceApps(first?.id as string)).toBe(false)
  })

  it("a tenant admin gets 403 on install, upgrade and remove", async () => {
    setOperator(OPERATOR)
    for (const [method, path] of MUTATING_ROUTES) {
      const res = await call(path, TENANT_USER, TENANT, { method, body: "{}" })
      expect([method, path, res.status]).toEqual([method, path, 403])
    }
  })

  it("the operator org passes the gate", async () => {
    setOperator(OPERATOR)
    const res = await call("/api/apps/no-such-app/rollback", OP_USER, OPERATOR, { method: "POST" })
    expect(res.status).toBe(404)
  })
})

describe("POST /api/apps/:name/rollback: instance operator only (S9, A10)", () => {
  it("refuses a workspace member without the app admin scope, even on a single-org self-host", async () => {
    _setEdition("self_hosted")
    DemoModeTestAccess.set(false)
    setOperator(OPERATOR)
    const res = await call("/api/apps/some-app/rollback", OP_USER, OPERATOR, { method: "POST" }, [
      "tickets:read",
    ])
    expect(res.status).toBe(403)
  })

  it("refuses another org's admin on a multi-tenant instance", async () => {
    _setEdition("managed")
    setOperator(OPERATOR)
    const res = await call("/api/apps/some-app/rollback", TENANT_USER, TENANT, { method: "POST" })
    expect(res.status).toBe(403)
  })

  it("lets the operator through, and says when the app is not installed", async () => {
    _setEdition("managed")
    setOperator(OPERATOR)
    const res = await call("/api/apps/no-such-app/rollback", OP_USER, OPERATOR, { method: "POST" })
    expect(res.status).toBe(404)
  })
})

describe("GET /api/apps/install-permission: what Settings > Apps offers", () => {
  const permission = async (userId: string, orgId: string) => {
    const res = await call("/api/apps/install-permission", userId, orgId)
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { canManageInstalls: boolean } }).data.canManageInstalls
  }

  it("says no to another org's admin on a multi-tenant instance, yes to the operator", async () => {
    setOperator(OPERATOR)
    _setEdition("self_hosted")
    DemoModeTestAccess.set(true)
    expect(await permission(TENANT_USER, TENANT)).toBe(false)
    expect(await permission(OP_USER, OPERATOR)).toBe(true)
    DemoModeTestAccess.set(false)
  })

  it("says yes to any app admin on a single-org self-host", async () => {
    setOperator(OPERATOR)
    _setEdition("self_hosted")
    DemoModeTestAccess.set(false)
    expect(await permission(TENANT_USER, TENANT)).toBe(true)
  })
})
