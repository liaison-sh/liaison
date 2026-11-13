// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET/PUT /api/admin/liaison-team: who may see and change the two "share with
// the Liaison team" switches, and what each answer carries.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
const savedOperator = env.LIAISON_OPERATOR_ORG_ID
const setEndpoint = (v: string) => {
  ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = v
}
const setOperator = (v: string | undefined) => {
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = v
  resetOperatorOrgCache()
}

interface Body {
  data: {
    available: boolean
    canManage: boolean
    register: {
      enabled: boolean
      state: string
      lastError?: string
      instanceId?: string
      registeredAt?: string | null
    }
    forwardBugReports: { enabled: boolean }
    bugReportsTeamOnly: { enabled: boolean }
    outbox?: { pending: number }
  }
}

const FOREIGN_ORG = "00000000-0000-4000-8000-0000000bad01"
const FOREIGN_USER = "00000000-0000-4000-8000-0000000bad11"

/** An admin of a second org (a demo visitor's), without a second bootstrap. */
async function foreignAdmin(): Promise<minimal.Session> {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${FOREIGN_ORG}, 'Visitor', 'liaison-team-visitor')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${FOREIGN_USER}, ${FOREIGN_ORG}, 'visitor@test.com', 'Visitor')`
  const bearer = await signAccessToken(
    {
      userId: FOREIGN_USER,
      orgId: FOREIGN_ORG,
      name: "Visitor",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    },
    env.JWT_SECRET,
  )
  return { cookie: `access_token=${bearer}`, bearer, userId: FOREIGN_USER, orgId: FOREIGN_ORG }
}

const get = (s: minimal.Session) =>
  app.request("/api/admin/liaison-team", { headers: { Authorization: `Bearer ${s.bearer}` } })
const put = (s: minimal.Session, body: unknown) =>
  app.request("/api/admin/liaison-team", {
    method: "PUT",
    headers: { Authorization: `Bearer ${s.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  await acquireTestLock()
})
afterAll(async () => {
  setEndpoint(savedEndpoint)
  setOperator(savedOperator)
  _setEdition(null)
  DemoModeTestAccess.set(null)
  await releaseTestLock()
})
beforeEach(async () => {
  setEndpoint("http://127.0.0.1:9/hook")
  setOperator(undefined)
  _setEdition("self_hosted")
  DemoModeTestAccess.set(false)
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})
afterEach(async () => {
  await sql`DELETE FROM kernel.users WHERE id = ${FOREIGN_USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${FOREIGN_ORG}`
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})

describe("/api/admin/liaison-team", () => {
  it("a member without kernel:org:admin gets 403 on GET and PUT", async () => {
    const member = await minimal.session((await createTestOrg()).id)
    expect((await get(member)).status).toBe(403)
    expect((await put(member, { register: true })).status).toBe(403)
  })

  it("an admin sees both switches off to begin with, and the operator's extras", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const res = await get(admin)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Body
    expect(data.available).toBe(true)
    expect(data.canManage).toBe(true)
    expect(data.register).toMatchObject({ enabled: false, state: "off" })
    expect(data.forwardBugReports).toEqual({ enabled: false })
    expect(data.outbox).toBeDefined()
  })

  it("turning registration on registers, audits, and shows the server id to the operator", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const res = await put(admin, { register: true })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Body
    expect(data.register).toMatchObject({ enabled: true, state: "pending" })
    expect(data.register.instanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.outbox?.pending).toBe(1)
    const rows = await sql`
      SELECT actor_id, metadata FROM kernel.audit_log
       WHERE org_id = ${admin.orgId} AND action = 'liaison_team.updated'`
    expect(rows.length).toBe(1)
    expect(rows[0].actor_id).toBe(admin.userId)
    expect(rows[0].metadata).toMatchObject({ register: true })
  })

  it("a non-operator admin's GET has no instanceId, registeredAt or outbox", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const other = await foreignAdmin()
    DemoModeTestAccess.set(true)
    setOperator(operator.orgId)
    expect((await put(operator, { register: true })).status).toBe(200)
    const res = await get(other)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as Body
    expect(data.canManage).toBe(false)
    expect(data.register.enabled).toBe(true)
    expect(data.register).not.toHaveProperty("instanceId")
    expect(data.register).not.toHaveProperty("registeredAt")
    expect(data).not.toHaveProperty("outbox")
  })

  it("a non-operator org on a multi-tenant instance gets 403 on PUT and nothing changes", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const other = await foreignAdmin()
    DemoModeTestAccess.set(true)
    setOperator(operator.orgId)
    expect((await put(other, { register: true })).status).toBe(403)
    const { data } = (await (await get(operator)).json()) as Body
    expect(data.register.enabled).toBe(false)
  })

  it("forwardBugReports without registration is 400 REGISTRATION_REQUIRED", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const res = await put(admin, { forwardBugReports: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "REGISTRATION_REQUIRED",
    )
  })

  it("forwardBugReports on after registration is stored", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await put(admin, { register: true })
    const res = await put(admin, { forwardBugReports: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Body).data.forwardBugReports.enabled).toBe(true)
  })

  it("bugReportsTeamOnly is 400 FORWARDING_REQUIRED unless registration and forwarding are on", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const code = async (res: Response) =>
      ((await res.json()) as { error: { code: string } }).error.code
    let res = await put(admin, { bugReportsTeamOnly: true })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe("FORWARDING_REQUIRED")
    await put(admin, { register: true })
    res = await put(admin, { bugReportsTeamOnly: true })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe("FORWARDING_REQUIRED")
    expect((await put(admin, { forwardBugReports: true })).status).toBe(200)
    res = await put(admin, { bugReportsTeamOnly: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Body).data.bugReportsTeamOnly.enabled).toBe(true)
  })

  it("turning forwarding or registration off turns bugReportsTeamOnly off", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    await put(admin, { register: true })
    await put(admin, { forwardBugReports: true, bugReportsTeamOnly: true })
    let { data } = (await (await put(admin, { forwardBugReports: false })).json()) as Body
    expect(data.bugReportsTeamOnly.enabled).toBe(false)
    await put(admin, { forwardBugReports: true, bugReportsTeamOnly: true })
    ;({ data } = (await (await put(admin, { register: false })).json()) as Body)
    expect(data.bugReportsTeamOnly.enabled).toBe(false)
    expect(data.forwardBugReports.enabled).toBe(false)
  })

  it("a non-operator org on a multi-tenant instance cannot turn bugReportsTeamOnly on (403)", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const other = await foreignAdmin()
    DemoModeTestAccess.set(true)
    setOperator(operator.orgId)
    await put(operator, { register: true })
    await put(operator, { forwardBugReports: true })
    expect((await put(other, { bugReportsTeamOnly: true })).status).toBe(403)
    let { data } = (await (await get(operator)).json()) as Body
    expect(data.bugReportsTeamOnly.enabled).toBe(false)
    // The operator's own PUT stores it, and GET then returns it.
    const res = await put(operator, { bugReportsTeamOnly: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Body).data.bugReportsTeamOnly.enabled).toBe(true)
    ;({ data } = (await (await get(operator)).json()) as Body)
    expect(data.bugReportsTeamOnly.enabled).toBe(true)
  })

  it("with the endpoint disabled, GET says available:false and PUT on is refused (400)", async () => {
    setEndpoint("")
    const admin = await minimal.adminSession((await createTestOrg()).id)
    const { data } = (await (await get(admin)).json()) as Body
    expect(data.available).toBe(false)
    const res = await put(admin, { register: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "LIAISON_TEAM_UNAVAILABLE",
    )
  })

  it("an unknown field or a non-boolean is a 400", async () => {
    const admin = await minimal.adminSession((await createTestOrg()).id)
    expect((await put(admin, { register: "yes" })).status).toBe(400)
    expect((await put(admin, { instanceId: "x" })).status).toBe(400)
  })
})

describe("/api/admin/liaison-team in the managed edition (LIAISON_EDITION=managed)", () => {
  const savedEdition = env.LIAISON_EDITION
  const setEditionEnv = (v: "managed" | "self_hosted" | undefined) => {
    ;(env as { LIAISON_EDITION?: string }).LIAISON_EDITION = v
  }
  beforeEach(() => {
    _setEdition(null)
    setEditionEnv("managed")
  })
  afterEach(() => {
    setEditionEnv(savedEdition)
  })

  it("sharing reads as forced on, with nothing stored and nothing queued", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    setOperator(operator.orgId)
    const { data } = (await (await get(operator)).json()) as Body
    expect(data.register.enabled).toBe(true)
    expect(data.forwardBugReports.enabled).toBe(true)
    const queued = await sql`SELECT type FROM kernel.control_plane_outbox`
    expect(queued.length).toBe(0)
  })

  it("a tenant admin gets 403 on PUT", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const tenant = await foreignAdmin()
    setOperator(operator.orgId)
    expect((await put(tenant, { register: false })).status).toBe(403)
  })

  it("the operator cannot turn it off either (403), and nothing is queued", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    setOperator(operator.orgId)
    const res = await put(operator, { register: false })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MANAGED_EDITION")
    expect((await put(operator, { register: true })).status).toBe(403)
    const queued = await sql`SELECT type FROM kernel.control_plane_outbox`
    expect(queued.length).toBe(0)
  })
})

describe("/api/admin/liaison-team app performance", () => {
  it("the operator shares app performance once registered, and reads exactly what is sent", async () => {
    const operator = await minimal.adminSession((await createTestOrg()).id)
    const on = await put(operator, { register: true, sharePerformance: true })
    expect(on.status).toBe(200)
    expect(
      ((await on.json()) as { data: { sharePerformance: { enabled: boolean } } }).data
        .sharePerformance,
    ).toEqual({ enabled: true })
    const preview = await app.request("/api/admin/liaison-team/performance", {
      headers: { Authorization: `Bearer ${operator.bearer}` },
    })
    expect(preview.status).toBe(200)
    const body = (await preview.json()) as {
      data: { message: string; data: { windows: Record<string, { windowS: number }> } }
    }
    expect(body.data.message).toBe("performance")
    expect(body.data.data.windows["24h"]?.windowS).toBe(86_400)
    const other = await foreignAdmin()
    DemoModeTestAccess.set(true)
    setOperator(operator.orgId)
    const denied = await app.request("/api/admin/liaison-team/performance", {
      headers: { Authorization: `Bearer ${other.bearer}` },
    })
    expect(denied.status).toBe(403)
  })
})
