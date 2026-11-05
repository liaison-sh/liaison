// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted session's refresh never widens it (migration 0114).
//
// The device flow mints a session whose first access token carries only the
// scopes the flow request declared. Before the ceiling was stored on the
// session row, refreshSession reloaded the user's FULL permissions, so the
// CLI's token silently became a full-rights token at its first refresh. These
// tests drive the real poll route (the only producer of restricted sessions)
// and then the real refresh, against a real database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { createSession, refreshSession } from "~/modules/auth/auth"
import { verifyAccessToken } from "~/modules/auth/jwt"

const ORG_ID = "00000000-0000-0000-0000-5c0000000001"
const USER_ID = "00000000-0000-0000-0000-5c0000000002"
const ROLE_ID = "00000000-0000-0000-0000-5c0000000003"
const EXTRA_ROLE_ID = "00000000-0000-0000-0000-5c0000000004"
const USER_SCOPES = ["kernel", "threads:read", "mail:read"]

async function scopesOf(accessToken: string): Promise<string[]> {
  const payload = await verifyAccessToken(accessToken, env.JWT_SECRET)
  return [...(payload.scopes ?? [])].sort()
}

/** An approved device-flow request declaring `scopes`, consumed by the real poll route. */
async function pollApproved(app: Hono, scopes: string | null) {
  const deviceCode = randomBytes(16).toString("hex")
  await sql`INSERT INTO kernel.device_flow_requests
      (org_id, device_code, user_code, client_id, state, user_id, scopes, expires_at)
    VALUES (${ORG_ID}, ${deviceCode}, ${randomBytes(4).toString("hex")}, 'test-ceiling',
      'approved', ${USER_ID}, ${scopes}, now() + interval '10 minutes')`
  const res = await app.request(`/api/auth/device-flow/poll/${deviceCode}?client_id=test-ceiling`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { accessToken: string; refreshToken: string } }
  expect(body.data.refreshToken).toBeDefined()
  return body.data
}

describe("session scope ceiling", () => {
  let app: Hono

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'Ceiling Org', 'ceiling-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${USER_ID}, ${ORG_ID}, 'ceiling@test.local', 'Ceiling User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [ROLE_ID, "ceiling-role"],
      [EXTRA_ROLE_ID, "ceiling-extra"],
    ]) {
      await sql`INSERT INTO kernel.roles (id, org_id, name, description)
        VALUES (${id}, ${ORG_ID}, ${name}, 'test') ON CONFLICT (id) DO NOTHING`
    }
    for (const scope of USER_SCOPES) {
      await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
        VALUES (${ROLE_ID}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER_ID}, ${ROLE_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    const { deviceFlow } = await import("~/modules/auth/device-flow-routes")
    app = new Hono()
    app.route("/api/auth/device-flow", deviceFlow)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.sessions WHERE user_id = ${USER_ID}`
    await sql`DELETE FROM kernel.device_flow_requests WHERE client_id = 'test-ceiling'`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ROLE_ID}, ${EXTRA_ROLE_ID})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("a device-flow session's refreshed token never exceeds its declared scopes", async () => {
    const first = await pollApproved(app, "threads:read")
    expect(await scopesOf(first.accessToken)).toEqual(["threads:read"])

    const refreshed = await refreshSession(first.refreshToken)
    expect(await scopesOf(refreshed.accessToken)).toEqual(["threads:read"])

    // The ceiling survives rotation: the successor session carries it too.
    const again = await refreshSession(refreshed.refreshToken)
    expect(await scopesOf(again.accessToken)).toEqual(["threads:read"])
  })

  it("a new role never leaks through the ceiling, and a revoked scope still shrinks the token", async () => {
    const first = await pollApproved(app, "threads:read mail:read")
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${EXTRA_ROLE_ID}, 'tickets') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER_ID}, ${EXTRA_ROLE_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE_ID} AND scope = 'mail:read'`
    try {
      const refreshed = await refreshSession(first.refreshToken)
      expect(await scopesOf(refreshed.accessToken)).toEqual(["threads:read"])
    } finally {
      await sql`DELETE FROM kernel.user_roles WHERE role_id = ${EXTRA_ROLE_ID}`
      await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
        VALUES (${ROLE_ID}, 'mail:read') ON CONFLICT DO NOTHING`
    }
  })

  it("an empty declared ceiling stays empty after refresh", async () => {
    const first = await pollApproved(app, " ")
    expect(await scopesOf(first.accessToken)).toEqual([])
    const refreshed = await refreshSession(first.refreshToken)
    expect(await scopesOf(refreshed.accessToken)).toEqual([])
  })

  it("a normal session (no ceiling) keeps the user's full scopes across refresh", async () => {
    const first = await createSession(USER_ID, ORG_ID)
    const [row] = await sql`SELECT scope_ceiling FROM kernel.sessions WHERE user_id = ${USER_ID}
      ORDER BY created_at DESC LIMIT 1`
    expect(row?.scope_ceiling).toBeNull()
    const refreshed = await refreshSession(first.refreshToken)
    expect(await scopesOf(refreshed.accessToken)).toEqual([...USER_SCOPES].sort())
  })

  it("a device flow without declared scopes behaves as before (no ceiling)", async () => {
    const first = await pollApproved(app, null)
    const refreshed = await refreshSession(first.refreshToken)
    expect(await scopesOf(refreshed.accessToken)).toEqual([...USER_SCOPES].sort())
  })
})
