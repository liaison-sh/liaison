// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { clearRedisPatterns } from "~/tests/route-test-setup"

async function clearRedis() {
  await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
}

const ORG = "550e8400-e29b-41d4-a716-446655440030"
const USER1 = "550e8400-e29b-41d4-a716-446655440031"
const USER2 = "550e8400-e29b-41d4-a716-446655440032"
const NO_SCOPE_USER = "550e8400-e29b-41d4-a716-446655440034"
const READ_ONLY_USER = "550e8400-e29b-41d4-a716-446655440035"
const ROLE_ADMIN = "550e8400-e29b-41d4-a716-44665544003a"
const ROLE_MEMBER = "550e8400-e29b-41d4-a716-44665544003b"
const ROLE_READER = "550e8400-e29b-41d4-a716-44665544003c"

// Second org for cross-org isolation tests
const ORG_B = "550e8400-e29b-41d4-a716-446655440060"
const USER_B = "550e8400-e29b-41d4-a716-446655440061"
const ROLE_B = "550e8400-e29b-41d4-a716-446655440062"

let token1: string
let _token2: string
let noScopeToken: string
let tokenB: string

describe("thread routes", () => {
  beforeAll(async () => {
    await clearRedis()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'ThreadOrg', 'threadorg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'tr1@t.com', 'TR1') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'tr2@t.com', 'TR2') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${"550e8400-e29b-41d4-a716-446655440033"}, ${ORG}, 'tr3@t.com', 'TR3') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${NO_SCOPE_USER}, ${ORG}, 'tr-noscope@t.com', 'NoScope') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${READ_ONLY_USER}, ${ORG}, 'tr-readonly@t.com', 'ReadOnly') ON CONFLICT DO NOTHING`

    // Seed roles and scopes
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_ADMIN}, ${ORG}, 'thread-admin', 'Thread admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ADMIN}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ADMIN}, 'kernel:threads:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ADMIN}, 'kernel:threads:write') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ADMIN}, 'kernel:threads:admin') ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_MEMBER}, ${ORG}, 'thread-member', 'Thread member') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_MEMBER}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_MEMBER}, 'kernel:threads:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_MEMBER}, 'kernel:threads:write') ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_READER}, ${ORG}, 'thread-reader', 'Thread reader') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_READER}, 'kernel:threads:read') ON CONFLICT DO NOTHING`

    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER1}, ${ROLE_ADMIN}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER2}, ${ROLE_MEMBER}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${READ_ONLY_USER}, ${ROLE_READER}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${"550e8400-e29b-41d4-a716-446655440033"}, ${ROLE_MEMBER}, ${ORG}) ON CONFLICT DO NOTHING`
    // NO_SCOPE_USER intentionally has no roles

    token1 = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
    _token2 = await signAccessToken(
      {
        userId: USER2,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
    noScopeToken = await signAccessToken(
      {
        userId: NO_SCOPE_USER,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      env.JWT_SECRET,
    )

    // --- Second org for cross-org isolation tests ---
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'OrgB', 'orgb') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_B}, ${ORG_B}, 'userb@t.com', 'UserB') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE_B}, ${ORG_B}, 'orgb-admin', 'Org B admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_B}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_B}, 'kernel:threads:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_B}, 'kernel:threads:write') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER_B}, ${ROLE_B}, ${ORG_B}) ON CONFLICT DO NOTHING`
    tokenB = await signAccessToken(
      {
        userId: USER_B,
        orgId: ORG_B,
        name: "User B",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await clearRedis()
    await sql`DELETE FROM kernel.message_reactions WHERE message_id IN (SELECT id FROM kernel.messages WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`

    // Clean up org B
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.thread_references WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG_B})`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG_B})`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG_B})`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_B})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
  })

  it("POST /api/threads creates a thread", async () => {
    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({
        participantIds: [USER2],
        title: "Route Test",
        forceCreate: true,
        initialMessage: { content: "Hello from route!" },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.handle).toBe("route-test")
    expect(body.data.title).toBe("Route Test")
  })

  // A thread's `createdFrom` names its entity in every notification and opens
  // on it, so a creator may anchor a thread only on an entity they may see:
  // otherwise any member could put a private contact's or a secret task's name
  // on a colleague's lock screen.
  describe("POST /api/threads createdFrom", () => {
    const post = (createdFrom: unknown) =>
      app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
        body: JSON.stringify({ participantIds: [USER2], forceCreate: true, createdFrom }),
      })

    it("refuses an entity the creator may not see", async () => {
      const [c] = await sql<{ id: string }[]>`
        INSERT INTO kernel.contacts (org_id, handle, name, owner_user_id, org_access)
        VALUES (${ORG}, 'route-private-contact', 'Private Supplier', ${USER2}, 'none') RETURNING id`
      const res = await post({ app: "kernel", entityType: "contact", entityId: c.id })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe("created_from_not_visible")
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.threads
        WHERE org_id = ${ORG} AND created_from->>'entityId' = ${c.id}`
      expect(n).toBe(0)
    })

    it("refuses an entity that does not exist", async () => {
      const res = await post({
        app: "projects",
        entityType: "task",
        entityId: "550e8400-e29b-41d4-a716-4466554400ff",
      })
      expect(res.status).toBe(403)
    })

    it("accepts an entity the creator may see", async () => {
      const [c] = await sql<{ id: string }[]>`
        INSERT INTO kernel.contacts (org_id, handle, name, owner_user_id, org_access)
        VALUES (${ORG}, 'route-own-contact', 'Own Supplier', ${USER1}, 'none') RETURNING id`
      const res = await post({ app: "kernel", entityType: "contact", entityId: c.id })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { createdFrom: unknown } }
      expect(body.data.createdFrom).toEqual({
        app: "kernel",
        entityType: "contact",
        entityId: c.id,
      })
    })
  })

  // A channel is created by one member and joined by the rest: nobody else has
  // to be named up front. Before, the schema demanded a participant, so the
  // channel dialog could not exist without a people picker in front of it.
  it("POST /api/threads creates a channel with nobody but its creator in it", async () => {
    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [], title: "Solo Channel", discoverable: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.title).toBe("Solo Channel")
    expect(body.data.discoverable).toBe(true)
    const seats = await sql`
      SELECT user_id FROM kernel.thread_participants WHERE thread_id = ${body.data.id}`
    expect(seats.map((s: any) => s.user_id)).toEqual([USER1])
  })

  it("POST /api/threads refuses an untitled room with nobody in it", async () => {
    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [] }),
    })
    expect(res.status).toBe(400)
  })

  it("GET /api/threads lists threads", async () => {
    const res = await app.request("/api/threads?limit=10", {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("GET /api/threads/:id returns thread detail", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Detail", forceCreate: true }),
    })
    const { data: created } = (await createRes.json()) as any
    const res = await app.request(`/api/threads/${created.id}`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.title).toBe("Detail")
  })

  it("returns 403 without threads:read scope", async () => {
    const res = await app.request("/api/threads?limit=10", {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    })
    expect(res.status).toBe(403)
  })

  it("POST /api/threads/:id/messages sends a message", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2] }),
    })
    const { data: thread } = (await createRes.json()) as any

    const res = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ content: "Test message" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.content).toBe("Test message")
  })

  it("POST /api/threads/:id/messages/:id/reactions adds reaction", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "React" } }),
    })
    const { data: thread } = (await createRes.json()) as any

    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any
    const msgId = msgs[0].id

    const res = await app.request(`/api/threads/${thread.id}/messages/${msgId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ emoji: "👍" }),
    })
    expect(res.status).toBe(200)
  })

  // S17 / A14: one emoji rule on both routes. Plain text is refused, a
  // skin-toned ZWJ sequence past the old 8-unit cap is accepted.
  it("reactions accept only an emoji, on POST and on DELETE", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "React S17" } }),
    })
    const { data: thread } = (await createRes.json()) as any
    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any
    const base = `/api/threads/${thread.id}/messages/${msgs[0].id}/reactions`
    const post = (emoji: string) =>
      app.request(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
        body: JSON.stringify({ emoji }),
      })
    const del = (emoji: string) =>
      app.request(`${base}/${encodeURIComponent(emoji)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token1}` },
      })

    expect((await post("abc")).status).toBe(400)
    expect((await del("abc")).status).toBe(400)
    const couple = "🧑🏽‍🤝‍🧑🏿"
    expect((await post(couple)).status).toBe(200)
    expect((await del(couple)).status).toBe(200)
  })

  // A reaction stored before the strict rule ("❤" without FE0F, plain text)
  // must stay removable: DELETE accepts any value of at most 32 units that
  // exists on the message. A value that exists nowhere stays refused.
  it("DELETE removes a legacy non-emoji reaction already stored on the message", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "Legacy" } }),
    })
    const { data: thread } = (await createRes.json()) as any
    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any
    const msgId = msgs[0].id
    for (const legacy of ["❤", "ok"]) {
      await sql`INSERT INTO kernel.message_reactions (message_id, user_id, org_id, emoji)
        VALUES (${msgId}, ${USER1}, ${ORG}, ${legacy})`
    }
    const del = (emoji: string) =>
      app.request(
        `/api/threads/${thread.id}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token1}` } },
      )

    expect((await del("❤")).status).toBe(200)
    expect((await del("ok")).status).toBe(200)
    const left = await sql`SELECT emoji FROM kernel.message_reactions WHERE message_id = ${msgId}`
    expect(left.length).toBe(0)
    // Not stored on this message: refused, exactly as before.
    expect((await del("nope")).status).toBe(400)
    expect((await del("x".repeat(33))).status).toBe(400)
    // POST keeps the strict rule.
    const post = await app.request(`/api/threads/${thread.id}/messages/${msgId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ emoji: "ok" }),
    })
    expect(post.status).toBe(400)
  })

  it("returns 403 for POST without threads:write scope", async () => {
    const readOnlyToken = await signAccessToken(
      {
        userId: READ_ONLY_USER,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readOnlyToken}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Should Fail", forceCreate: true }),
    })
    expect(res.status).toBe(403)
  })

  it("returns 404 when non-participant accesses thread detail", async () => {
    // Create a thread where USER1 and USER2 are participants
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Private", forceCreate: true }),
    })
    const { data: thread } = (await createRes.json()) as any

    // Create a third user who is not a participant
    const USER3 = "550e8400-e29b-41d4-a716-446655440033"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER3}, ${ORG}, 'tr3@t.com', 'TR3') ON CONFLICT DO NOTHING`
    const token3 = await signAccessToken(
      {
        userId: USER3,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )

    const res = await app.request(`/api/threads/${thread.id}`, {
      headers: { Authorization: `Bearer ${token3}` },
    })
    expect(res.status).toBe(404)
  })

  it("PATCH /api/threads/:id/messages/:msgId edits a message", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "Original" } }),
    })
    const { data: thread } = (await createRes.json()) as any

    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any
    const msgId = msgs[0].id

    const res = await app.request(`/api/threads/${thread.id}/messages/${msgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ content: "Edited content" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.content).toBe("Edited content")
    expect(body.data.editedAt).not.toBeNull()
  })

  it("DELETE /api/threads/:id/messages/:msgId soft-deletes a message", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "Delete me" } }),
    })
    const { data: thread } = (await createRes.json()) as any

    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any
    const msgId = msgs[0].id

    const res = await app.request(`/api/threads/${thread.id}/messages/${msgId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.deletedAt).not.toBeNull()
  })

  it("returns 404 for non-participant sending a message", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Closed Thread", forceCreate: true }),
    })
    const { data: thread } = (await createRes.json()) as any

    const USER3 = "550e8400-e29b-41d4-a716-446655440033"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER3}, ${ORG}, 'tr3@t.com', 'TR3') ON CONFLICT DO NOTHING`
    const token3 = await signAccessToken(
      {
        userId: USER3,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )

    const res = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token3}` },
      body: JSON.stringify({ content: "I shouldn't be able to send this" }),
    })
    expect(res.status).toBe(404)
  })

  it("DELETE /api/threads/:id/messages/:msgId admin cannot delete another user's message", async () => {
    // Create thread with USER1 (admin) and USER2
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({
        participantIds: [USER2],
        initialMessage: { content: "Admin thread" },
      }),
    })
    const { data: thread } = (await createRes.json()) as any

    // USER2 sends a message
    const sendRes = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${_token2}` },
      body: JSON.stringify({ content: "Message from user2" }),
    })
    expect(sendRes.status).toBe(200)
    const { data: msg } = (await sendRes.json()) as any
    expect(msg.authorId).toBe(USER2)

    // USER1 (admin) tries to delete USER2's message — should be denied
    const delRes = await app.request(`/api/threads/${thread.id}/messages/${msg.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(delRes.status).toBe(404)
  })

  it("PATCH /api/threads/:id/read marks thread as read", async () => {
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], initialMessage: { content: "Read me" } }),
    })
    const { data: thread } = (await createRes.json()) as any

    const msgsRes = await app.request(`/api/threads/${thread.id}/messages?limit=1`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { data: msgs } = (await msgsRes.json()) as any

    const res = await app.request(`/api/threads/${thread.id}/read`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ lastReadMessageId: msgs[0].id }),
    })
    expect(res.status).toBe(200)
  })

  // --- TST-1: Cross-org thread access returns 404 (zero-knowledge denial) ---

  it("returns 404 when org B user tries to GET a thread from org A", async () => {
    // Create a thread in org A
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Org A Secret", forceCreate: true }),
    })
    expect(createRes.status).toBe(200)
    const { data: thread } = (await createRes.json()) as any

    // Org B user tries to access it — should get 404, not 403
    const res = await app.request(`/api/threads/${thread.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    expect(res.status).toBe(404)
  })

  // --- TST-19: Pagination boundary tests ---

  it("GET /api/threads clamps excessively large limit", async () => {
    const res = await app.request("/api/threads?limit=99999", {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  // --- TST-21: type and hiddenFromList require thread-level admin role ---

  it("returns 403 when non-admin member changes type via PATCH /api/threads/:id", async () => {
    // USER1 is creator (thread-level admin); USER2 is added as plain member.
    // Use a token with explicit leaf scopes only (no broad "kernel" prefix which
    // would grant kernel:threads:admin via hasScope prefix matching).
    const memberOnlyToken = await signAccessToken(
      {
        userId: USER2,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )

    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Type Auth Test", forceCreate: true }),
    })
    expect(createRes.status).toBe(200)
    const { data: thread } = (await createRes.json()) as any

    // USER2 with member-only scopes (no kernel:threads:admin) cannot change type.
    const res = await app.request(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberOnlyToken}` },
      body: JSON.stringify({ type: "agent_chat" }),
    })
    expect(res.status).toBe(403)

    // hiddenFromList on a shared thread also requires thread-level admin role
    const res2 = await app.request(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberOnlyToken}` },
      body: JSON.stringify({ hiddenFromList: true }),
    })
    expect(res2.status).toBe(403)
  })

  // A chat's model override is permission gated by the same rule that gates
  // the picker: a model the org cannot call must not be pinnable, or every
  // turn after the pin fails at send time.
  it("refuses a per-chat model override the org cannot call, and accepts one it can", async () => {
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`

    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ participantIds: [USER2], title: "Model Override", forceCreate: true }),
    })
    const { data: thread } = (await createRes.json()) as any

    const refused = await app.request(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ agentModelId: "not-a-model-this-org-has" }),
    })
    expect(refused.status).toBe(403)

    // Clearing the override asks for less, so it is always allowed.
    const cleared = await app.request(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ agentModelId: null }),
    })
    expect(cleared.status).toBe(200)

    const [row] = await sql`SELECT agent_model_id FROM kernel.threads WHERE id = ${thread.id}`
    expect(row.agent_model_id).toBeNull()
  })

  // --- TST-20: Pinned thread scope enforcement ---

  it("returns 403 when non-admin creates a thread with isPinned: true", async () => {
    // Token with write but NOT admin scope
    const memberToken = await signAccessToken(
      {
        userId: USER2,
        orgId: ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ participantIds: [USER1], title: "Pin Attempt", isPinned: true }),
    })
    expect(res.status).toBe(403)
  })

  it("POST /api/threads/:id/join seats the caller, is idempotent, and 404s on a private thread", async () => {
    const [open] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG}, 'routes-join-channel', 'Joinable', ${USER2}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${open.id}, ${USER2}, ${ORG})`
    const [closed] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'routes-closed-thread', 'Closed', ${USER2}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${closed.id}, ${USER2}, ${ORG})`

    const join = async (id: string) =>
      app.request(`/api/threads/${id}/join`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token1}` },
      })

    const first = await join(open.id)
    expect(first.status).toBe(200)
    expect(((await first.json()) as any).data.added).toBe(true)

    const second = await join(open.id)
    expect(second.status).toBe(200)
    expect(((await second.json()) as any).data.added).toBe(false)

    const refused = await join(closed.id)
    expect(refused.status).toBe(404)

    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${open.id} AND user_id = ${USER1}`
    expect(rows.length).toBe(1)
  })

  it("GET /api/threads/discoverable lists a channel the caller has not joined, with no message content", async () => {
    const [row] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG}, 'routes-open-channel', 'Open Channel', ${USER2}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row.id}, ${USER2}, ${ORG})`
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
              VALUES (${row.id}, ${ORG}, ${USER2}, 'user', 'members only content', '{}')`

    const res = await app.request("/api/threads/discoverable", {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const channel = body.data.find((c: any) => c.id === row.id)
    expect(channel).toBeDefined()
    expect(channel.handle).toBe("routes-open-channel")
    expect(channel.title).toBe("Open Channel")
    expect(channel.participantCount).toBe(1)
    expect(JSON.stringify(body)).not.toContain("members only content")
  })

  it("GET /api/threads/:id gives a NON-member of a discoverable channel the projection only", async () => {
    // Discoverability grants the ROW, not the room: a listed channel has to be
    // openable enough to decide whether to join, and nothing more. The roster,
    // who created it and which model it runs are member facts.
    const [row] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable, agent_model_id)
      VALUES (${ORG}, 'routes-open-detail', 'Open Detail', ${USER2}, true, 'claude-haiku-4-5') RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row.id}, ${USER2}, ${ORG})`

    const res = await app.request(`/api/threads/${row.id}`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Object.keys(body.data).sort()).toEqual([
      "agentCount",
      "agents",
      // A channel's topic and description are what a non-member reads to decide
      // whether to join, so the projection carries them; the roster, the
      // creator and the model stay member facts.
      "description",
      "discoverable",
      "handle",
      "id",
      "participantCount",
      "title",
      "topic",
    ])
    expect(body.data.discoverable).toBe(true)
    expect(body.data.participantCount).toBe(1)
    expect(body.data.agentCount).toBe(0)
    // Same shape as the LIST row (D7): a channel says who runs it before it is
    // joined, and opening it by id must not answer with less than the list did.
    expect(body.data.agents).toEqual([])
    expect(JSON.stringify(body)).not.toContain(USER2)
    expect(JSON.stringify(body)).not.toContain("claude-haiku-4-5")
  })

  it("GET /api/threads/:id still 404s for a non-member of a PRIVATE thread", async () => {
    const [row] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'routes-private-detail', 'Private Detail', ${USER2}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row.id}, ${USER2}, ${ORG})`

    const res = await app.request(`/api/threads/${row.id}`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(404)
  })

  it("GET /api/threads/:id keeps the full shape for a MEMBER of a discoverable channel", async () => {
    const [row] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG}, 'routes-open-member-detail', 'Member Detail', ${USER1}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row.id}, ${USER1}, ${ORG})`

    const res = await app.request(`/api/threads/${row.id}`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Array.isArray(body.data.participants)).toBe(true)
    expect(body.data.participants.map((p: any) => p.id)).toContain(USER1)
    expect(body.data.createdBy).toBe(USER1)
    expect(body.data).toHaveProperty("references")
  })
})

describe("Security: updateThread enforces isPinned admin check in service", () => {
  it("throws 403 when non-admin tries to pin", async () => {
    const { updateThread } = await import("~/modules/threads/thread")
    const { withRlsContext } = await import("~/db/rls")

    const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
    const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: TEST_USER_ID,
          orgId: TEST_ORG_ID,
          scopes: ["kernel:threads:write"],
          dimensionGrants: {},
        },
        (tx) =>
          updateThread(tx, {
            orgId: TEST_ORG_ID,
            userId: TEST_USER_ID,
            threadId: "00000000-0000-0000-0000-000000000099",
            scopes: ["kernel:threads:write"], // no admin scope
            changes: { isPinned: true },
          }),
      )
      expect(true).toBe(false) // Should not reach
    } catch (err: any) {
      expect(err.status).toBe(403)
    }
  })
})

// P4c-T04: `POST /threads/dm` resolves the caller's own personal agent when
// no `agentId` is given, and the retired `agent_chat` creation path answers
// a client-correctable 400 instead of ever reaching `createThread`.
describe("P4c-T04: personal agent DM resolution + retired agent_chat creation", () => {
  const ORG_T04 = "550e8400-e29b-41d4-a716-446655440070"
  const WITH_AGENT_USER = "550e8400-e29b-41d4-a716-446655440071"
  const WITH_AGENT_PERSONAL_AGENT = "550e8400-e29b-41d4-a716-446655440072"
  const NO_AGENT_USER = "550e8400-e29b-41d4-a716-446655440073"
  const CONCURRENT_USER = "550e8400-e29b-41d4-a716-446655440074"
  const CONCURRENT_PERSONAL_AGENT = "550e8400-e29b-41d4-a716-446655440075"

  let withAgentToken: string
  let noAgentToken: string
  let concurrentToken: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_T04}, 'T04 Org', 't04-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${WITH_AGENT_USER}, ${ORG_T04}, 't04-with-agent@t.com', 'WithAgent') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${NO_AGENT_USER}, ${ORG_T04}, 't04-no-agent@t.com', 'NoAgent') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CONCURRENT_USER}, ${ORG_T04}, 't04-concurrent@t.com', 'Concurrent') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${WITH_AGENT_PERSONAL_AGENT}, ${ORG_T04}, 'personal', '@t04-with-agent', 'Liaison', ${WITH_AGENT_USER}, '[]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${CONCURRENT_PERSONAL_AGENT}, ${ORG_T04}, 'personal', '@t04-concurrent', 'Liaison', ${CONCURRENT_USER}, '[]'::jsonb) ON CONFLICT DO NOTHING`

    withAgentToken = await signAccessToken(
      {
        userId: WITH_AGENT_USER,
        orgId: ORG_T04,
        name: "WithAgent",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    noAgentToken = await signAccessToken(
      {
        userId: NO_AGENT_USER,
        orgId: ORG_T04,
        name: "NoAgent",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
    concurrentToken = await signAccessToken(
      {
        userId: CONCURRENT_USER,
        orgId: ORG_T04,
        name: "Concurrent",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_T04}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_T04}`
  })

  it("POST /threads/dm without agentId returns the caller's personal agent DM", async () => {
    const res = await app.request("/api/threads/dm", {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const dm = ((await res.json()) as any).data
    expect(dm.created).toBe(true)
    const seats = await sql<{ agent_id: string | null; participant_type: string }[]>`
      SELECT agent_id, participant_type FROM kernel.thread_participants
      WHERE thread_id = ${dm.id} AND participant_type = 'agent'`
    expect(seats[0]?.agent_id).toBe(WITH_AGENT_PERSONAL_AGENT)

    // A caller with no personal agent gets a clear 4xx, never a 500.
    const missing = await app.request("/api/threads/dm", {
      method: "POST",
      headers: { Authorization: `Bearer ${noAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as any
    expect(missingBody.error.code).toBe("personal_agent_missing")
  })

  // Surface 35: the agent page's "Add to channel" seats an AGENT through this
  // route. It used to post the agent's id as `userId`, which resolves to no
  // user, so the route answered 404 and no seat was ever written.
  it("POST /threads/:id/participants seats an agent when the body names agentId", async () => {
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG_T04}, ${"@t04-seat-channel"}, 'Seat Channel', 'thread', ${WITH_AGENT_USER})
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type, role)
      VALUES (${thread.id}, ${WITH_AGENT_USER}, ${ORG_T04}, 'user', 'admin')`

    // The agent id under `userId` is the shape that was refused.
    const asUser = await app.request(`/api/threads/${thread.id}/participants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: WITH_AGENT_PERSONAL_AGENT }),
    })
    expect(asUser.status).toBe(404)

    const res = await app.request(`/api/threads/${thread.id}/participants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: WITH_AGENT_PERSONAL_AGENT }),
    })
    expect(res.status).toBe(200)

    const seats = await sql<{ agent_id: string | null; participant_type: string }[]>`
      SELECT agent_id, participant_type FROM kernel.thread_participants
      WHERE thread_id = ${thread.id} AND participant_type = 'agent'`
    expect(seats.map((r) => r.agent_id)).toEqual([WITH_AGENT_PERSONAL_AGENT])

    // Seating it twice is the same request answered twice, not a failure.
    const again = await app.request(`/api/threads/${thread.id}/participants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: WITH_AGENT_PERSONAL_AGENT }),
    })
    expect(again.status).toBe(200)

    // A uuid that names no live agent of this org is a 404, not a silent ok.
    const ghost = await app.request(`/api/threads/${thread.id}/participants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "550e8400-e29b-41d4-a716-4466554400ff" }),
    })
    expect(ghost.status).toBe(404)
  })

  it("POST /threads with type agent_chat is refused with agent_chat_retired", async () => {
    const [{ n: before }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${ORG_T04} AND type = 'agent_chat'`

    const res = await app.request("/api/threads", {
      method: "POST",
      headers: { Authorization: `Bearer ${withAgentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ participantIds: [NO_AGENT_USER], type: "agent_chat" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("agent_chat_retired")
    expect(body.error.hint).toBe("POST /threads/dm")

    // The retirement never reached createThread: no new row, agent_chat or
    // otherwise, was left behind by the refused call.
    const [{ n: after }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.threads WHERE org_id = ${ORG_T04} AND type = 'agent_chat'`
    expect(after).toBe(before)
  })

  it("two concurrent POST /threads/dm calls yield one row", async () => {
    const openDm = () =>
      app.request("/api/threads/dm", {
        method: "POST",
        headers: { Authorization: `Bearer ${concurrentToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    const [a, b] = await Promise.all([openDm(), openDm()])
    const first = ((await a.json()) as any).data
    const second = ((await b.json()) as any).data
    expect(second.id).toBe(first.id)
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.threads t
      JOIN kernel.thread_participants seat
        ON seat.thread_id = t.id AND seat.agent_id = ${CONCURRENT_PERSONAL_AGENT}
      WHERE t.org_id = ${ORG_T04} AND t.type = 'agent_chat'`
    expect(n).toBe(1)
  })
})

// P4c-T51 (A50): the thread read model tells the reader where the agent's own
// view of the conversation resumes. A DM with one agent has one such boundary;
// a room seating several agents has one checkpoint per agent and therefore
// none to name.
describe("GET /api/threads/:threadId agentContextFrom", () => {
  const CTX_ORG = crypto.randomUUID()
  const CTX_USER = crypto.randomUUID()
  const CTX_AGENT_A = crypto.randomUUID()
  const CTX_AGENT_B = crypto.randomUUID()
  const ctxTag = crypto.randomUUID().slice(0, 8)
  let ctxToken: string
  let dmThreadId: string
  let channelThreadId: string
  let checkpointMessageId: string

  const readThread = (id: string) =>
    app.request(`/api/threads/${id}`, { headers: { Authorization: `Bearer ${ctxToken}` } })

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${CTX_ORG}, 'CtxOrg', ${`ctx-${ctxTag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CTX_USER}, ${CTX_ORG}, ${`ctx-${ctxTag}@t.com`}, 'Ctx User')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${CTX_AGENT_A}, ${CTX_ORG}, 'role', ${`@ctx-a-${ctxTag}`}, 'Liaison', '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${CTX_AGENT_B}, ${CTX_ORG}, 'role', ${`@ctx-b-${ctxTag}`}, 'Support', '[]'::jsonb)`

    const [dm] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${CTX_ORG}, ${`ctx-dm-${ctxTag}`}, 'agent_chat', ${CTX_USER}) RETURNING id`
    dmThreadId = dm.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${dmThreadId}, ${CTX_USER}, ${CTX_ORG}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${dmThreadId}, ${CTX_AGENT_A}, ${CTX_ORG}, 'agent')`
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${dmThreadId}, ${CTX_ORG}, ${CTX_USER}, 'user', 'first', '{}') RETURNING id`
    checkpointMessageId = msg.id
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${CTX_ORG}, ${CTX_AGENT_A}, ${dmThreadId}, ${checkpointMessageId}, 'summary v1', '{}', 100, 1)`

    // Two agents in one room: each keeps its own checkpoint, so there is no one
    // position to draw. This one even has a checkpoint, and still answers null.
    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, discoverable, created_by)
      VALUES (${CTX_ORG}, ${`ctx-ch-${ctxTag}`}, 'Ops room', 'thread', true, ${CTX_USER}) RETURNING id`
    channelThreadId = channel.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${channelThreadId}, ${CTX_USER}, ${CTX_ORG}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${channelThreadId}, ${CTX_AGENT_A}, ${CTX_ORG}, 'agent')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${channelThreadId}, ${CTX_AGENT_B}, ${CTX_ORG}, 'agent')`
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${CTX_ORG}, ${CTX_AGENT_A}, ${channelThreadId}, ${checkpointMessageId}, 'summary v1', '{}', 100, 1)`

    ctxToken = await signAccessToken(
      {
        userId: CTX_USER,
        orgId: CTX_ORG,
        name: "Ctx User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${CTX_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${CTX_ORG}`
  })

  it("a DM with an agent exposes the agent's checkpoint uptoMessageId", async () => {
    const res = await readThread(dmThreadId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.agentContextFrom).toBe(checkpointMessageId)
  })

  it("a DM with an agent that has no checkpoint exposes null", async () => {
    const [bare] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${CTX_ORG}, ${`ctx-bare-${ctxTag}`}, 'agent_chat', ${CTX_USER}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${bare.id}, ${CTX_USER}, ${CTX_ORG}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${bare.id}, ${CTX_AGENT_B}, ${CTX_ORG}, 'agent')`
    const res = await readThread(bare.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.agentContextFrom).toBeNull()
  })

  it("a room with two agents still exposes the boundary, named for the agent it belongs to", async () => {
    // It used to answer null here: the read required a SOLE agent counterpart,
    // so any room that picked up a second agent by mention could never draw the
    // row. The name travels with the position, because with several agents
    // seated the view cannot derive whose boundary it is.
    const res = await readThread(channelThreadId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.agentContextFrom).toBe(checkpointMessageId)
    expect(body.data.agentContextAgentId).toBe(CTX_AGENT_A)
    expect(body.data.agentContextAgentName).toBe("Liaison")
  })

  it("the first page of messages reaches the boundary, so the row is on screen without scrolling", async () => {
    const [far] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${CTX_ORG}, ${`ctx-far-${ctxTag}`}, 'agent_chat', ${CTX_USER}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${far.id}, ${CTX_USER}, ${CTX_ORG}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${far.id}, ${CTX_AGENT_A}, ${CTX_ORG}, 'agent')`
    // The boundary sits 73 messages back, exactly as it did on the live box,
    // while the client asks for 50.
    const ids: string[] = []
    for (let i = 0; i < 80; i++) {
      const [m] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${far.id}, ${CTX_ORG}, ${CTX_USER}, 'user', ${`m${i}`}, '{}') RETURNING id`
      ids.push(m.id)
    }
    const boundaryId = ids[6]
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${CTX_ORG}, ${CTX_AGENT_A}, ${far.id}, ${boundaryId}, 'far summary', '{}', 100, 1)`

    const res = await app.request(`/api/threads/${far.id}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${ctxToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const page = body.data as Array<{ id: string }>
    expect(page.length).toBeGreaterThan(50)
    expect(page.map((m) => m.id)).toContain(boundaryId)
  })

  it("the boundary follows the newest checkpoint version", async () => {
    const [second] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${dmThreadId}, ${CTX_ORG}, ${CTX_USER}, 'user', 'second', '{}') RETURNING id`
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${CTX_ORG}, ${CTX_AGENT_A}, ${dmThreadId}, ${second.id}, 'summary v2', '{}', 120, 2)`
    const body = (await (await readThread(dmThreadId)).json()) as any
    expect(body.data.agentContextFrom).toBe(second.id)
  })
})
