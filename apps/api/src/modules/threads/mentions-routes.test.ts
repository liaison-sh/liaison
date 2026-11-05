// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { IMPORT_PLACEHOLDER_EMAIL_DOMAIN } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { SearchDriftTestAccess } from "~/modules/search/drift"

const ORG = "550e8400-e29b-41d4-a716-446655440050"
const USER1 = "550e8400-e29b-41d4-a716-446655440051"
const ROLE_ID = "550e8400-e29b-41d4-a716-44665544005a"
let _token: string

describe("mentions routes", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'MentionOrg', 'mentionorg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'mention@t.com', 'MentionUser') ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ID}, ${ORG}, 'mention-member', 'Mention test member') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER1}, ${ROLE_ID}, ${ORG}) ON CONFLICT DO NOTHING`

    _token = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "MentionUser",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("GET /api/mentions without auth returns 401", async () => {
    const res = await app.request("/api/mentions?q=test&limit=5")
    expect(res.status).toBe(401)
  })
})

// A ticket assignee menu must offer every active teammate to a member who can
// assign tickets, without a wildcard and whether or not the search index
// answers. It used to read the people search (`/api/mentions?type=user`),
// which is 503 while the index is not ready and clamped to ten rows; the
// menu then showed nothing but "Assign to me".
describe("GET /api/mentions/members (assignee directory)", () => {
  const ORG2 = "550e8400-e29b-41d4-a716-446655440060"
  const CALLER = "550e8400-e29b-41d4-a716-446655440061"
  const teammates = Array.from({ length: 12 }, (_, i) => ({
    id: `550e8400-e29b-41d4-a716-4466554401${String(i).padStart(2, "0")}`,
    name: `Teammate ${String.fromCharCode(65 + i)}`,
    email: `teammate${i}@members.test`,
  }))
  const GONE = "550e8400-e29b-41d4-a716-446655440190"
  const PLACEHOLDER = "550e8400-e29b-41d4-a716-446655440191"
  // The reporter's effective scopes: ticket work, conversations, the user
  // directory, contacts. No wildcard.
  const SCOPES = [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:tickets:reply",
    "tickets:tickets:close",
    "kernel:threads:read",
    "kernel:threads:write",
    "kernel:users:read",
    "kernel:contacts:read",
  ]
  let token: string

  async function tokenFor(scopes: string[]): Promise<string> {
    return signAccessToken(
      { userId: CALLER, orgId: ORG2, name: "Caller", authVersion: 1, permissionVersion: 1, scopes },
      env.JWT_SECRET,
    )
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG2}, 'MembersOrg', 'membersorg-dir') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CALLER}, ${ORG2}, 'caller@members.test', 'Caller') ON CONFLICT DO NOTHING`
    for (const t of teammates) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${t.id}, ${ORG2}, ${t.email}, ${t.name}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${GONE}, ${ORG2}, 'gone@members.test', 'Gone Member', 'deactivated') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${PLACEHOLDER}, ${ORG2}, ${`slack-u1@${IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`}, 'Imported Author') ON CONFLICT DO NOTHING`
    token = await tokenFor(SCOPES)
  })

  afterAll(async () => {
    SearchDriftTestAccess.resetSearchReady()
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG2}`
  })

  it("lists every active teammate from the database while the search index is not ready", async () => {
    SearchDriftTestAccess.setSearchReady(false)
    const res = await app.request("/api/mentions/members?limit=50", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { id: string; name: string }[]
      meta: { total: number }
    }
    const ids = body.data.map((m) => m.id)
    // 12 teammates + the caller, over the people search's old ten-row ceiling.
    expect(ids).toHaveLength(13)
    for (const t of teammates) expect(ids).toContain(t.id)
    expect(ids).not.toContain(GONE)
    expect(ids).not.toContain(PLACEHOLDER)
    expect(body.meta.total).toBe(13)
    expect(body.data[0]?.name).toBe("Caller")
  })

  it("filters by name or email", async () => {
    const res = await app.request("/api/mentions/members?q=teammate11", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual([teammates[11]!.id])
  })

  it("answers a caller who can only assign tickets, and refuses one who can do neither", async () => {
    const ticketsOnly = await tokenFor(["kernel:threads:read", "tickets:tickets:write"])
    const ok = await app.request("/api/mentions/members", {
      headers: { Authorization: `Bearer ${ticketsOnly}` },
    })
    expect(ok.status).toBe(200)
    const readOnly = await tokenFor(["kernel:threads:read", "tickets:tickets:read"])
    const denied = await app.request("/api/mentions/members", {
      headers: { Authorization: `Bearer ${readOnly}` },
    })
    expect(denied.status).toBe(403)
  })

  it("answers a caller who can only write project tasks (the task assignee chip)", async () => {
    const tasksOnly = await tokenFor(["kernel:threads:read", "projects:tasks:write"])
    const ok = await app.request("/api/mentions/members?q=teammate11", {
      headers: { Authorization: `Bearer ${tasksOnly}` },
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual([teammates[11]!.id])
    const readOnly = await tokenFor(["kernel:threads:read", "projects:tasks:read"])
    const denied = await app.request("/api/mentions/members", {
      headers: { Authorization: `Bearer ${readOnly}` },
    })
    expect(denied.status).toBe(403)
  })
})
