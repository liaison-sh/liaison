// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { handleUsersSearch } from "~/modules/agent/tools/user-tools"

const orgId = "00000000-0000-0000-0000-0000000d5001"
const sofiaId = "00000000-0000-0000-0000-0000000d5002"
const liamId = "00000000-0000-0000-0000-0000000d5003"
const goneId = "00000000-0000-0000-0000-0000000d5004"

// A non-admin actor holding only kernel:users:read (the BASE grant) — proves a regular agent user can
// resolve colleagues, not just an admin. The users SELECT RLS is org-scoped, so this reads org users.
const actor: UserContext = {
  actorType: "user",
  userId: sofiaId,
  orgId,
  scopes: ["kernel:users:read"],
  dimensionGrants: {},
}

async function search(params: { query?: string; limit?: number }) {
  return withRlsContext(actor, (db) => handleUsersSearch(params, { db, userId: sofiaId, orgId }))
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'UsersSearchOrg', 'users-search-tools-org') ON CONFLICT DO NOTHING`
  await sql`
    INSERT INTO kernel.users (id, org_id, email, name, password_hash, status) VALUES
      (${sofiaId}, ${orgId}, 'sofia@users-search.test', 'Sofia Support', 'x', 'active'),
      (${liamId},  ${orgId}, 'liam@users-search.test',  'Liam Support',  'x', 'active'),
      (${goneId},  ${orgId}, 'gone@users-search.test',  'Gone Deactivated', 'x', 'deactivated')
    ON CONFLICT DO NOTHING`
}, 60_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

describe("users_search agent tool (BL-60 — resolve a teammate's UUID for tickets:assign)", () => {
  it("resolves a teammate by name → id/name/email", async () => {
    const res = (await search({ query: "Liam" })) as {
      items: Array<{ id: string; name: string; email: string }>
      totalCount: number
    }
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      id: liamId,
      name: "Liam Support",
      email: "liam@users-search.test",
    })
  })

  it("matches by email substring too", async () => {
    const res = (await search({ query: "sofia@users-search" })) as {
      items: Array<{ id: string }>
    }
    expect(res.items.map((u) => u.id)).toEqual([sofiaId])
  })

  it("excludes deactivated users and returns active org members when no query", async () => {
    const res = (await search({})) as { items: Array<{ id: string }> }
    const ids = res.items.map((u) => u.id)
    expect(ids).toContain(sofiaId)
    expect(ids).toContain(liamId)
    expect(ids).not.toContain(goneId) // deactivated is not a valid assignee
  })

  it("caps the limit at 50", async () => {
    const res = (await search({ limit: 999 })) as { items: unknown[] }
    expect(res.items.length).toBeLessThanOrEqual(50)
  })
})
