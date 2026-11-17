// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The notice a client reads before signing in to the portal: written by the org,
// shown with the org's name, and a new text is a new version to read again.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createSession } from "~/modules/auth/auth"
import { readPortalSettings } from "~/modules/portal/access"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"

let w: DoorWorld
let adminToken: string

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  adminToken = (await createSession(w.admin.userId, w.orgId)).accessToken
})

afterAll(async () => {
  await dropDoorWorld(w)
  await releaseTestLock()
})

const put = (body: unknown, token = adminToken) =>
  app.request("/api/contacts/portal-settings", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

describe("the portal notice", () => {
  it("an admin writes it; the sign-in page shows it with the org's name; a new text is a new version", async () => {
    const text = "We keep a log of each sign-in and download for twelve months."
    const res = await put({ notice: text })
    expect(res.status).toBe(200)
    expect((await readPortalSettings(w.orgId)).noticeVersion).toBe(1)
    // The same text again is not a new version.
    await put({ notice: text })
    expect((await readPortalSettings(w.orgId)).noticeVersion).toBe(1)
    await put({ notice: `${text} Ask us to see yours.` })
    expect((await readPortalSettings(w.orgId)).noticeVersion).toBe(2)
    const branding = await app.request(`/api/portal/auth/branding/${w.orgSlug}`)
    expect(branding.status).toBe(200)
    const b = (await branding.json()) as { data: { name: string; notice: string } }
    expect(b.data.name).toBe(w.orgName)
    expect(b.data.notice).toBe(`${text} Ask us to see yours.`)
  })

  it("a member without the portal admin scope cannot change it", async () => {
    // They may write contacts, so only the portal scope refuses them.
    const role = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.roles", {
        id: role,
        org_id: w.orgId,
        name: `contacts-${role.slice(0, 8)}`,
      }),
    )
    for (const scope of ["kernel:contacts:read", "kernel:contacts:write"]) {
      await sql.unsafe(insertSql("kernel.role_scope_grants", { role_id: role, scope }))
    }
    await sql.unsafe(
      insertSql("kernel.user_roles", { user_id: w.member.userId, role_id: role, org_id: w.orgId }),
    )
    const token = (await createSession(w.member.userId, w.orgId)).accessToken
    const res = await put({ notice: "changed" }, token)
    expect(res.status).toBe(403)
  })
})
