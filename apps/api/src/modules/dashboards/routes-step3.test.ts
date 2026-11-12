// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 3 over HTTP: a person's edit by operations (saved at once, no approval), the version
// list and one version, a duplicate, and a stale version refused.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let owner = ""
let other = ""

async function req(userId: string, method: string, path: string, body?: unknown) {
  const token = await minimal.token(userId)
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboard Step3 Routes Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
  await minimal.grantScope(owner, "kernel:dashboards:share")
  await minimal.grantScope(owner, "kernel:dashboards:write")
  await minimal.grantScope(other, "kernel:dashboards:write")
})

afterAll(async () => {
  await releaseTestLock()
})

describe("POST /api/dashboards/:id/edit, versions, duplicate", () => {
  it("a person's edit saves at once and answers the dashboard", async () => {
    const created = await req(owner, "POST", "/api/dashboards", {
      title: "Board",
      visibility: "org",
      spec: {
        v: 1,
        blocks: [
          { id: "a", type: "text", title: "A", text: "first" },
          { id: "b", type: "text", title: "B", text: "second" },
        ],
      },
    })
    expect(created.status).toBe(201)
    const id = created.body.data.id as string
    const edited = await req(owner, "POST", `/api/dashboards/${id}/edit`, {
      ifVersion: 1,
      operations: [
        { op: "moveBlock", blockId: "b", position: 0 },
        { op: "resizeBlock", blockId: "a", height: 2 },
      ],
    })
    expect(edited.status).toBe(200)
    expect(edited.body.data.version).toBe(2)
    expect(edited.body.data.spec.blocks.map((b: { id: string }) => b.id)).toEqual(["b", "a"])
    expect(edited.body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // Written against version 1, on nothing version 2 changed: saved on top of it.
    const stale = await req(owner, "POST", `/api/dashboards/${id}/edit`, {
      ifVersion: 1,
      operations: [{ op: "setTitle", title: "Late" }],
    })
    expect(stale.status).toBe(200)
    expect(stale.body.data).toMatchObject({ version: 3, title: "Late" })
    expect(stale.body.data.spec.blocks.map((b: { id: string }) => b.id)).toEqual(["b", "a"])
    // On a block version 2 changed: refused.
    const conflict = await req(owner, "POST", `/api/dashboards/${id}/edit`, {
      ifVersion: 1,
      operations: [{ op: "resizeBlock", blockId: "a", width: 2 }],
    })
    expect(conflict.status).toBe(409)
    const bad = await req(owner, "POST", `/api/dashboards/${id}/edit`, {
      ifVersion: 3,
      operations: [{ op: "removeBlock", blockId: "nope" }],
    })
    expect(bad.status).toBe(422)

    const versions = await req(other, "GET", `/api/dashboards/${id}/versions`)
    expect(versions.status).toBe(200)
    expect(versions.body.data.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1])
    const one = await req(other, "GET", `/api/dashboards/${id}/versions/1`)
    expect(one.body.data.spec.blocks[0].id).toBe("a")
    expect((await req(other, "GET", `/api/dashboards/${id}/versions/7`)).status).toBe(404)

    const copy = await req(other, "POST", `/api/dashboards/${id}/duplicate`, { title: "My board" })
    expect(copy.status).toBe(201)
    expect(copy.body.data).toMatchObject({
      title: "My board",
      visibility: "personal",
      ownerUserId: other,
    })
  })
})
