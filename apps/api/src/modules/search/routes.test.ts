// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { SearchDriftTestAccess } from "~/modules/search/drift"

const ORG = "550e8400-e29b-41d4-a716-446655440040"
const USER1 = "550e8400-e29b-41d4-a716-446655440041"
const ROLE_SEARCH = "550e8400-e29b-41d4-a716-44665544004a"
let token: string

// Phase 10 Task 8 replaced the DB-backed search with MeiliSearch. Route-level
// behaviour that requires a live Meili index (grouped results, mention payloads)
// is covered by service-level unit tests in `service.test.ts` (mocked Meili)
// and the Playwright E2E scenarios. The HTTP-level tests here exercise route
// plumbing — readiness gating, empty-query validation, and references — without
// needing the indexer to be running.
describe("search routes", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'SearchOrg', 'searchorg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'search@t.com', 'SearchUser') ON CONFLICT DO NOTHING`

    // Seed role with required scopes
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_SEARCH}, ${ORG}, 'search-member', 'Search test member') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_SEARCH}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_SEARCH}, 'kernel:threads:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_SEARCH}, 'kernel:threads:write') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER1}, ${ROLE_SEARCH}, ${ORG}) ON CONFLICT DO NOTHING`

    token = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )

    // Create threads for search
    await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ participantIds: [USER1], title: "Engineering Chat" }),
    })
    await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ participantIds: [USER1], title: "Marketing Review" }),
    })
  })

  it("GET /api/search returns 503 when search is not ready", async () => {
    SearchDriftTestAccess.resetSearchReady()
    const res = await app.request("/api/search?q=foo&limit=5", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe("SEARCH_UNAVAILABLE")
  })

  it("GET /api/search/page returns 503 when search is not ready", async () => {
    SearchDriftTestAccess.resetSearchReady()
    const res = await app.request("/api/search/page?q=foo&limit=10&offset=0", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
  })

  it("GET /api/mentions returns 503 when search is not ready", async () => {
    SearchDriftTestAccess.resetSearchReady()
    const res = await app.request("/api/mentions?q=foo&limit=5", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
  })

  it("GET /api/search/page rejects empty query", async () => {
    SearchDriftTestAccess.setSearchReady(true)
    const res = await app.request("/api/search/page?q=&limit=10&offset=0", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(400)
    SearchDriftTestAccess.resetSearchReady()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("GET /api/search rejects empty query", async () => {
    SearchDriftTestAccess.setSearchReady(true)
    const res = await app.request("/api/search?q=&limit=5", {
      headers: { Authorization: `Bearer ${token}` },
    })
    // Zod schema requires min(1) — should return 400
    expect(res.status).toBe(400)
    SearchDriftTestAccess.resetSearchReady()
  })

  it("GET /api/references returns backlinks", async () => {
    const res = await app.request("/api/references?app=tickets&entityType=ticket&entityId=t1", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })
})
