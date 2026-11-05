// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org setting "administrators need a second factor", end to end through the
// real app: default off; the admin who turns it on must have one; turning it on
// retires every token minted before; an admin without a second factor then gets
// a session that holds nothing and can only enroll; once enrolled, the next
// session is whole again. Members are never affected. Config-as-code sets it too.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { orgProvisioner } from "~/cli/provisioners/org"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { withSystemDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { changePassword, createSession } from "~/modules/auth/auth"
import { verifyAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PASSWORD = "Passw0rd!"
let orgId: string
let ownerId: string
let adminId: string
let memberId: string

const req = (method: string, token: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

async function token(userId: string, ceiling?: string[]) {
  return (await createSession(userId, orgId, ceiling)).accessToken
}

async function claims(t: string) {
  return verifyAccessToken(t, env.JWT_SECRET)
}

/** Enroll TOTP through the real setup + confirm routes. */
async function enroll(t: string): Promise<{ setup: number; confirm: number }> {
  const setup = await app.request(
    "/api/auth/totp/setup",
    req("POST", t, { currentPassword: PASSWORD }),
  )
  if (setup.status !== 200) return { setup: setup.status, confirm: 0 }
  const secret = ((await setup.json()) as { data: { secret: string } }).data.secret
  const { generateCurrentCode } = await import("~/modules/auth/totp")
  const confirm = await app.request(
    "/api/auth/totp/confirm",
    req("POST", t, { code: generateCurrentCode(secret) }),
  )
  return { setup: 200, confirm: confirm.status }
}

async function setRequire(t: string, on: boolean) {
  return app.request("/api/org", req("PATCH", t, { settings: { requireAdminSecondFactor: on } }))
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg({ password: PASSWORD })).id
  // The bootstrap admin of the org.
  const [owner] = await withSystemDb("t", (db) =>
    db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1),
  )
  ownerId = owner.id
  adminId = (await minimal.person(orgId, { role: "admin" })).id
  memberId = (await minimal.person(orgId)).id
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("required second factor for administrators", () => {
  it("is off by default: an admin without a second factor gets a whole session", async () => {
    const c = await claims(await token(adminId))
    expect(c.scopes).toContain("*")
    expect(c.secondFactorRequired).toBeUndefined()
    expect(c.restricted).toBeUndefined()
  })

  it("cannot be turned on by an admin who has no second factor", async () => {
    const res = await setRequire(await token(ownerId), true)
    expect(res.status).toBe(409)
  })

  it("turned on: earlier tokens stop working, an unenrolled admin can only enroll, members are unaffected", async () => {
    const ownerToken = await token(ownerId)
    expect(await enroll(ownerToken)).toEqual({ setup: 200, confirm: 200 })
    const adminBefore = await token(adminId)
    const memberBefore = await token(memberId)

    const on = await setRequire(await token(ownerId), true)
    expect(on.status).toBe(200)

    // Tokens minted before the change no longer authenticate.
    expect((await app.request("/api/org", req("GET", adminBefore))).status).toBe(401)
    expect((await app.request("/api/org", req("GET", memberBefore))).status).toBe(401)

    // The unenrolled admin's new session holds nothing and is marked.
    const gated = await token(adminId)
    const g = await claims(gated)
    expect(g.scopes).toEqual([])
    expect(g.roles).toEqual([])
    expect(g.dimensionGrants).toEqual({})
    expect(g.restricted).toBe(true)
    expect(g.secondFactorRequired).toBe(true)

    // No admin action, no credential mint.
    expect((await setRequire(gated, false)).status).toBe(403)
    const wsTicket = await app.request("/api/auth/ws-ticket", req("POST", gated))
    expect(wsTicket.status).toBe(403)

    // Members keep their session.
    const m = await claims(await token(memberId))
    expect(m.scopes?.length ?? 0).toBeGreaterThan(0)
    expect(m.secondFactorRequired).toBeUndefined()

    // The enrolled owner keeps theirs.
    expect((await claims(await token(ownerId))).scopes).toContain("*")

    // The gated admin enrolls, and the next session is whole again.
    expect(await enroll(gated)).toEqual({ setup: 200, confirm: 200 })
    const after = await claims(await token(adminId))
    expect(after.scopes).toContain("*")
    expect(after.secondFactorRequired).toBeUndefined()
  })

  it("a device-flow (ceiling) session of an unenrolled admin holds nothing and cannot enroll", async () => {
    const other = (await minimal.person(orgId, { role: "admin" })).id
    const t = (await createSession(other, orgId, ["kernel:threads:read"])).accessToken
    const c = await claims(t)
    expect(c.scopes).toEqual([])
    expect(c.restricted).toBe(true)
    expect(c.secondFactorRequired).toBeUndefined()
    expect((await enroll(t)).setup).toBe(403)
  })

  it("a password change of an unenrolled admin mints the enrollment-only session", async () => {
    const other = (await minimal.person(orgId, { role: "admin" })).id
    const { accessToken } = await changePassword(other, PASSWORD, "N3wPassw0rd!x")
    const c = await claims(accessToken)
    expect(c.scopes).toEqual([])
    expect(c.secondFactorRequired).toBe(true)
  })
})

describe("config-as-code: org.requireAdminSecondFactor", () => {
  it("sets and clears the setting idempotently", async () => {
    const [org] = await withSystemDb("t", (db) =>
      db
        .select({ slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId)),
    )
    const run = async (want: boolean) => {
      const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
      const config: ProvisioningConfig = {
        org: { slug: org.slug, name: org.name, requireAdminSecondFactor: want },
      }
      return orgProvisioner.apply(ctx, { actions: [] }, config)
    }
    const read = async () => {
      const [row] = await withSystemDb("t", (db) =>
        db
          .select({ s: organizations.settings })
          .from(organizations)
          .where(eq(organizations.id, orgId)),
      )
      return (row.s as Record<string, unknown>).requireAdminSecondFactor
    }

    const off = await run(false)
    expect(off.changed).toContain("org.requireAdminSecondFactor")
    expect(await read()).toBe(false)
    const again = await run(false)
    expect(again.unchanged).toContain("org.requireAdminSecondFactor")
    const on = await run(true)
    expect(on.changed).toContain("org.requireAdminSecondFactor")
    expect(await read()).toBe(true)
  })
})
