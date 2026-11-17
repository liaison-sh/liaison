// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The notice a client reads before signing in to the portal: written by the org,
// shown with the org's name, and a new text is a new version to read again.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createPortalSession, createSession } from "~/modules/auth/auth"
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

  it("the sign-in page gives the notice's version, and the portal acknowledges only the version it showed", async () => {
    await put({ notice: "Each download is logged." })
    const b = (await (await app.request(`/api/portal/auth/branding/${w.orgSlug}`)).json()) as {
      data: { notice: string; noticeVersion: number }
    }
    const shown = (await readPortalSettings(w.orgId)).noticeVersion
    expect(b.data.noticeVersion).toBe(shown as number)
    const token = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
    const ack = (version: number) =>
      app.request("/api/portal/me/notice-ack", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      })
    // The org wrote a new text after the page was shown: the old version records nothing.
    await put({ notice: "Each download and sign-in is logged." })
    const stale = await ack(b.data.noticeVersion)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("NOTICE_CHANGED")
    const [before] = await sql<{ v: number | null }[]>`
      SELECT notice_version AS v FROM kernel.portal_people WHERE user_id = ${w.clientA.userId}`
    expect(before?.v ?? null).not.toBe(b.data.noticeVersion)
    const fresh = (await (await app.request(`/api/portal/auth/branding/${w.orgSlug}`)).json()) as {
      data: { noticeVersion: number }
    }
    expect((await ack(fresh.data.noticeVersion)).status).toBe(200)
    const [after] = await sql<{ v: number }[]>`
      SELECT notice_version AS v FROM kernel.portal_people WHERE user_id = ${w.clientA.userId}`
    expect(after?.v).toBe(fresh.data.noticeVersion)
  })
})

describe("the client access panel's reads", () => {
  const panel = (path: string, token = adminToken) =>
    app.request(`/api/contacts/companies/${w.companyA}/portal${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

  it("reads the second step's current setting after it changes", async () => {
    const r1 = (await (await panel("/sign-in")).json()) as { data: { required: boolean } }
    expect(r1.data.required).toBe(false)
    const set = await app.request(`/api/contacts/companies/${w.companyA}/portal/sign-in`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requireTotp: true }),
    })
    expect(set.status).toBe(200)
    const r2 = (await (await panel("/sign-in")).json()) as { data: { required: boolean } }
    expect(r2.data.required).toBe(true)
  })

  it("names the people who can read the access log, and only them", async () => {
    const res = await panel("/log/readers")
    expect(res.status).toBe(200)
    const out = (await res.json()) as { data: { readers: Array<{ userId: string; name: string }> } }
    const ids = out.data.readers.map((r) => r.userId)
    // The admin holds every scope; the plain member and the clients hold no log scope.
    expect(ids).toContain(w.admin.userId)
    expect(ids).not.toContain(w.member.userId)
    expect(ids).not.toContain(w.clientA.userId)
    expect(out.data.readers.every((r) => typeof r.name === "string" && r.name.length > 0)).toBe(
      true,
    )
  })

  it("a member without the portal admin scope reads neither", async () => {
    const token = (await createSession(w.member.userId, w.orgId)).accessToken
    expect((await panel("/sign-in", token)).status).toBe(403)
    expect((await panel("/log/readers", token)).status).toBe(403)
  })
})
