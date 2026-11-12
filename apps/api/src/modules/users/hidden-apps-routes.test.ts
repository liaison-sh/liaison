// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The apps a person hid from their sidebar (0293): their own PUT, an admin's
// GET/PUT on a member, and the full-replace preferences save leaving the list
// alone. Hiding is a display preference: no route here touches access.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Json = Record<string, any>

let orgId: string
let admin: minimal.Session
let member: minimal.Session
let otherOrgUserId: string

const headers = (s: minimal.Session) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${s.bearer}`,
})

async function call(s: minimal.Session, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: headers(s),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json().catch(() => ({}))) as Json
  return { status: res.status, json }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = await minimal.adminSession(orgId)
  member = await minimal.session(orgId)
  const other = await minimal.secondOrg()
  otherOrgUserId = other.adminUserId
})

afterAll(async () => {
  await releaseTestLock()
})

describe("PUT /api/user/preferences/hidden-apps (self)", () => {
  it("reads as an empty list for a person who never hid anything", async () => {
    const { status, json } = await call(member, "GET", "/api/user/preferences")
    expect(status).toBe(200)
    expect(json.data.hiddenSidebarApps).toEqual([])
  })

  it("stores the list and GET round-trips it", async () => {
    const put = await call(member, "PUT", "/api/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["sessions", "monitoring", "an-app-this-device-lacks"],
    })
    expect(put.status).toBe(200)
    expect(put.json.data.hiddenSidebarApps).toEqual([
      "sessions",
      "monitoring",
      "an-app-this-device-lacks",
    ])
    const get = await call(member, "GET", "/api/user/preferences")
    expect(get.json.data.hiddenSidebarApps).toEqual([
      "sessions",
      "monitoring",
      "an-app-this-device-lacks",
    ])
  })

  it("refuses duplicates, empty ids, non-arrays and more than 100 ids", async () => {
    const put = (body: unknown) => call(member, "PUT", "/api/user/preferences/hidden-apps", body)
    expect((await put({ hiddenSidebarApps: ["sessions", "sessions"] })).status).toBe(400)
    expect((await put({ hiddenSidebarApps: [""] })).status).toBe(400)
    expect((await put({ hiddenSidebarApps: "sessions" })).status).toBe(400)
    const many = Array.from({ length: 101 }, (_, i) => `app-${i}`)
    expect((await put({ hiddenSidebarApps: many })).status).toBe(400)
    expect((await put({ hiddenSidebarApps: many.slice(0, 100) })).status).toBe(200)
  })

  it("survives a full-replace PUT /api/user/preferences save", async () => {
    await call(member, "PUT", "/api/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["dashboards"],
    })
    const full = await call(member, "PUT", "/api/user/preferences", {
      digestCadence: "daily",
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
    })
    expect(full.status).toBe(200)
    expect(full.json.data.hiddenSidebarApps).toEqual(["dashboards"])
    const get = await call(member, "GET", "/api/user/preferences")
    expect(get.json.data.hiddenSidebarApps).toEqual(["dashboards"])
  })
})

describe("/api/admin/users/:id/hidden-apps", () => {
  it("lets an admin read and set a member's list, which the member then sees", async () => {
    const set = await call(admin, "PUT", `/api/admin/users/${member.userId}/hidden-apps`, {
      hiddenSidebarApps: ["sessions", "monitoring"],
    })
    expect(set.status).toBe(200)
    expect(set.json.data).toEqual({
      userId: member.userId,
      hiddenSidebarApps: ["sessions", "monitoring"],
    })

    const read = await call(admin, "GET", `/api/admin/users/${member.userId}/hidden-apps`)
    expect(read.status).toBe(200)
    expect(read.json.data.hiddenSidebarApps).toEqual(["sessions", "monitoring"])

    const own = await call(member, "GET", "/api/user/preferences")
    expect(own.json.data.hiddenSidebarApps).toEqual(["sessions", "monitoring"])

    // The member can show an app again: the admin's list is a starting point.
    const back = await call(member, "PUT", "/api/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["monitoring"],
    })
    expect(back.status).toBe(200)
    const reread = await call(admin, "GET", `/api/admin/users/${member.userId}/hidden-apps`)
    expect(reread.json.data.hiddenSidebarApps).toEqual(["monitoring"])
  })

  it("reads an empty list for a member who has no preferences row yet", async () => {
    const fresh = await minimal.session(orgId)
    const read = await call(admin, "GET", `/api/admin/users/${fresh.userId}/hidden-apps`)
    expect(read.status).toBe(200)
    expect(read.json.data.hiddenSidebarApps).toEqual([])
  })

  it("refuses a caller without kernel:users:admin (403)", async () => {
    const get = await call(member, "GET", `/api/admin/users/${admin.userId}/hidden-apps`)
    expect(get.status).toBe(403)
    const put = await call(member, "PUT", `/api/admin/users/${admin.userId}/hidden-apps`, {
      hiddenSidebarApps: ["sessions"],
    })
    expect(put.status).toBe(403)
  })

  it("answers 404 for a user of another organisation and writes nothing there", async () => {
    const get = await call(admin, "GET", `/api/admin/users/${otherOrgUserId}/hidden-apps`)
    expect(get.status).toBe(404)
    const put = await call(admin, "PUT", `/api/admin/users/${otherOrgUserId}/hidden-apps`, {
      hiddenSidebarApps: ["sessions"],
    })
    expect(put.status).toBe(404)
    const otherSession = await minimal.sessionOf({ id: otherOrgUserId, orgId: "" })
    const theirs = await call(otherSession, "GET", "/api/user/preferences")
    expect(theirs.json.data.hiddenSidebarApps).toEqual([])
  })

  it("validates the admin's list with the same rules", async () => {
    const bad = await call(admin, "PUT", `/api/admin/users/${member.userId}/hidden-apps`, {
      hiddenSidebarApps: ["sessions", "sessions"],
    })
    expect(bad.status).toBe(400)
  })
})
