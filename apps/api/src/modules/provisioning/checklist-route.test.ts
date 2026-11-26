// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/first-run/checklist: the setup card's checklist as it is now, read
// from rows on every request. A step done after the card was posted (a
// knowledge page, an invitation) reads done on the next request.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { invitations, roles } from "~/db/schema/kernel"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let adminId: string
let adminToken: string

async function checklist(token: string) {
  const res = await app.request("/api/first-run/checklist", {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as {
    data?: {
      items: Array<{ key: string; done: boolean; optional: boolean }>
      next: string | null
      asOf: string
    }
  }
  return { status: res.status, data: body.data }
}

describe("GET /api/first-run/checklist", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    // The workspace's only person: the team step is open until someone is invited.
    const admin = await minimal.orgAdmin(orgId)
    adminId = admin.id
    adminToken = await minimal.token(adminId)
  }, 180_000)

  afterAll(releaseTestLock)

  test("needs a session", async () => {
    const res = await app.request("/api/first-run/checklist")
    expect(res.status).toBe(401)
  })

  test("keys and booleans only, and an invitation sent since reads done on the next read", async () => {
    const before = await checklist(adminToken)
    expect(before.status).toBe(200)
    const keys = before.data?.items.map((i) => i.key) ?? []
    expect(keys).toContain("team")
    for (const item of before.data?.items ?? []) {
      expect(Object.keys(item).sort()).toEqual(["done", "key", "optional"])
    }
    expect(before.data?.items.find((i) => i.key === "team")?.done).toBe(false)

    await withSystemDb("test-checklist-invite", async (db) => {
      const [role] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "member")))
        .limit(1)
      if (!role) throw new Error("no member role")
      await db.insert(invitations).values({
        orgId,
        email: `invitee-${crypto.randomUUID()}@t.co`,
        roleId: role.id,
        tokenHash: crypto.randomUUID(),
        invitedBy: adminId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    })
    const after = await checklist(adminToken)
    expect(after.data?.items.find((i) => i.key === "team")?.done).toBe(true)
    expect(Date.parse(after.data?.asOf ?? "")).toBeGreaterThan(0)
  })
})
