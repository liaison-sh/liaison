// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent avatar colours (0221): every create path gives a new agent the slot
// its org's live agents use least, so an org's agents differ until all eight
// are taken; the colour reads back on the listing, the page read and the
// settings read; PATCH accepts a slot 0-7 from an admin and from the owner of
// a personal agent, and refuses anything else.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { leastUsedAvatarColor } from "~/modules/agent/directory/avatar-color"
import { ensureBaseAgent } from "~/modules/agent/directory/base-agent"
import { createPersonalAgent } from "~/modules/agent/directory/personal-agent"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("leastUsedAvatarColor", () => {
  it("picks an unused slot, the tie at random", () => {
    const usage = [0, 1, 2, 4, 5, 6].map((color) => ({ color, n: 1 }))
    expect(leastUsedAvatarColor(usage, () => 0)).toBe(3)
    expect(leastUsedAvatarColor(usage, () => 0.99)).toBe(7)
  })

  it("past eight, picks among the least used", () => {
    const usage = Array.from({ length: 8 }, (_, color) => ({ color, n: color === 5 ? 1 : 2 }))
    expect(leastUsedAvatarColor(usage, () => 0.5)).toBe(5)
  })

  it("ignores a slot outside the palette", () => {
    expect(leastUsedAvatarColor([{ color: 9, n: 3 }], () => 0)).toBe(0)
  })
})

describe("agent avatar colours", () => {
  let admin: minimal.Session
  let member: minimal.Session
  let memberAgentId: string

  const call = (bearer: string, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    })

  const liveColors = async (orgId: string): Promise<number[]> =>
    (
      await sql`SELECT avatar_color FROM kernel.agents
                 WHERE org_id = ${orgId} AND archived_at IS NULL ORDER BY created_at, id`
    ).map((r) => r.avatar_color as number)

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    admin = await minimal.session(org.id, { role: "admin" })
    member = await minimal.session(org.id, { role: "member" })
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("gives the built-in, personal and REST-created agents distinct colours until all eight are used", async () => {
    await ensureBaseAgent(admin.orgId)
    const personal = await withSystemDb("test-personal-agent", (tx) =>
      createPersonalAgent(tx, {
        orgId: member.orgId,
        userId: member.userId,
        email: `member-${member.userId.slice(0, 8)}@example.com`,
        firstName: "Morgan",
      }),
    )
    memberAgentId = personal.id
    const before = await liveColors(admin.orgId)
    expect(before.every((c) => Number.isInteger(c))).toBe(true)
    expect(new Set(before).size).toBe(before.length)

    for (let i = before.length; i < 8; i++) {
      const res = await call(admin.bearer, "/api/agents", {
        method: "POST",
        body: JSON.stringify({ handle: `@colour-${i}`, displayName: `Colour ${i}` }),
      })
      expect(res.status).toBe(201)
      const { data } = (await res.json()) as { data: { avatarColor: number } }
      expect(data.avatarColor).toBeGreaterThanOrEqual(0)
    }
    const eight = await liveColors(admin.orgId)
    expect(eight.length).toBe(8)
    expect([...eight].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    // The ninth repeats one slot, and only one.
    const ninth = await call(admin.bearer, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ handle: "@colour-ninth", displayName: "Ninth" }),
    })
    expect(ninth.status).toBe(201)
    const nine = await liveColors(admin.orgId)
    const counts = new Map<number, number>()
    for (const c of nine) counts.set(c, (counts.get(c) ?? 0) + 1)
    expect(Math.max(...counts.values())).toBe(2)
  })

  it("serializes the colour on the listing, the page read and the settings read", async () => {
    const [row] = await sql`SELECT id, avatar_color FROM kernel.agents
                             WHERE org_id = ${admin.orgId} AND handle = '@colour-ninth'`
    const listing = (await (await call(admin.bearer, "/api/agents")).json()) as {
      data: { id: string; avatarColor: number | null }[]
    }
    expect(listing.data.find((a) => a.id === row.id)?.avatarColor).toBe(row.avatar_color)
    const page = (await (await call(admin.bearer, `/api/agents/${row.id}`)).json()) as {
      data: { avatarColor: number | null }
    }
    expect(page.data.avatarColor).toBe(row.avatar_color)
    const settings = (await (
      await call(admin.bearer, `/api/agents/${row.id}/settings`)
    ).json()) as {
      data: { avatarColor: number | null }
    }
    expect(settings.data.avatarColor).toBe(row.avatar_color)
  })

  it("accepts a slot 0-7 on update and refuses anything else", async () => {
    const [row] = await sql`SELECT id FROM kernel.agents
                             WHERE org_id = ${admin.orgId} AND handle = '@colour-ninth'`
    const patch = (bearer: string, id: string, avatarColor: unknown) =>
      call(bearer, `/api/agents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ avatarColor }),
      })
    for (const bad of [-1, 8, 2.5, "3", null, true]) {
      const res = await patch(admin.bearer, row.id, bad)
      expect(res.status).toBe(400)
    }
    const ok = await patch(admin.bearer, row.id, 7)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { data: { avatarColor: number } }).data.avatarColor).toBe(7)
    const [stored] = await sql`SELECT avatar_color FROM kernel.agents WHERE id = ${row.id}`
    expect(stored.avatar_color).toBe(7)

    // A member may not recolour a role agent, and may recolour their own.
    expect((await patch(member.bearer, row.id, 1)).status).toBe(403)
    const own = await patch(member.bearer, memberAgentId, 4)
    expect(own.status).toBe(200)
    const [mine] = await sql`SELECT avatar_color FROM kernel.agents WHERE id = ${memberAgentId}`
    expect(mine.avatar_color).toBe(4)
  })
})
