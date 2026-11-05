// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("contact endpoints", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    token = ((await res.json()) as any as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("POST /api/contacts/resolve creates contact", async () => {
    const res = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "customer@example.com", name: "Customer" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.email).toBe("customer@example.com")
    expect(body.data.handle).toMatch(/^@contact-/)
  })

  it("GET /api/contacts lists contacts (paginated)", async () => {
    const res = await app.request("/api/contacts?page=1&limit=10", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.meta).toBeDefined()
  })

  it("GET /api/contacts/:id returns single contact", async () => {
    const createRes = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "single@example.com" }),
    })
    const { data: created } = (await createRes.json()) as any

    const res = await app.request(`/api/contacts/${created.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.id).toBe(created.id)
  })

  it("GET /api/contacts returns 403 without kernel:contacts:read scope", async () => {
    // Seed a user with no scopes for the 403 tests
    const SCOPE_ORG = "00000000-0000-0000-0000-c0c000000001"
    const SCOPE_USER = "00000000-0000-0000-0000-c0c000000002"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SCOPE_ORG}, 'ContactScopeOrg', 'contact-scope-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${SCOPE_USER}, ${SCOPE_ORG}, 'noscope-contact@test.com', 'NoScope') ON CONFLICT (id) DO NOTHING`

    const noScopeToken = await signAccessToken(
      {
        userId: SCOPE_USER,
        orgId: SCOPE_ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/contacts?page=1&limit=10", {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    })
    expect(res.status).toBe(403)
  })

  it("POST /api/contacts/resolve returns 403 without kernel:contacts:write scope", async () => {
    // Seed a user with only read scope
    const SCOPE_ORG = "00000000-0000-0000-0000-c0c000000001"
    const SCOPE_USER_RO = "00000000-0000-0000-0000-c0c000000003"
    const SCOPE_ROLE_RO = "00000000-0000-0000-0000-c0c000000004"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SCOPE_ORG}, 'ContactScopeOrg', 'contact-scope-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${SCOPE_USER_RO}, ${SCOPE_ORG}, 'readonly-contact@test.com', 'ReadOnly') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${SCOPE_ROLE_RO}, ${SCOPE_ORG}, 'contact-reader', 'Read-only contacts') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${SCOPE_ROLE_RO}, 'kernel:contacts:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${SCOPE_USER_RO}, ${SCOPE_ROLE_RO}, ${SCOPE_ORG}) ON CONFLICT DO NOTHING`

    const readOnlyToken = await signAccessToken(
      {
        userId: SCOPE_USER_RO,
        orgId: SCOPE_ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:contacts:read"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readOnlyToken}`,
      },
      body: JSON.stringify({ email: "forbidden@example.com" }),
    })
    expect(res.status).toBe(403)
  })

  it("PATCH /api/contacts/:id returns 403 without kernel:contacts:write scope", async () => {
    const SCOPE_ORG = "00000000-0000-0000-0000-c0c000000001"
    const SCOPE_USER_RO = "00000000-0000-0000-0000-c0c000000003"
    const readOnlyToken = await signAccessToken(
      {
        userId: SCOPE_USER_RO,
        orgId: SCOPE_ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:contacts:read"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/contacts/00000000-0000-0000-0000-000000000099", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readOnlyToken}`,
      },
      body: JSON.stringify({ name: "Forbidden" }),
    })
    expect(res.status).toBe(403)
  })

  it("POST /api/contacts/merge returns 422 for self-merge", async () => {
    const createRes = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: "self-merge@example.com" }),
    })
    const { data: contact } = (await createRes.json()) as any

    const res = await app.request("/api/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sourceId: contact.id, targetId: contact.id }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("INVALID_ARGUMENT")
  })

  it("POST /api/contacts/merge returns 403 without kernel:contacts:write scope", async () => {
    const SCOPE_ORG = "00000000-0000-0000-0000-c0c000000001"
    const SCOPE_USER_RO = "00000000-0000-0000-0000-c0c000000003"
    const readOnlyToken = await signAccessToken(
      {
        userId: SCOPE_USER_RO,
        orgId: SCOPE_ORG,
        name: "Test User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:contacts:read"],
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readOnlyToken}` },
      body: JSON.stringify({
        sourceId: "00000000-0000-0000-0000-000000000001",
        targetId: "00000000-0000-0000-0000-000000000002",
      }),
    })
    expect(res.status).toBe(403)
  })

  it("POST /api/contacts/merge deletes source and reassigns mail conversations", async () => {
    const ORG = "00000000-0000-0000-0000-c0c000000021"
    const USER = "00000000-0000-0000-0000-c0c000000022"
    const ACCOUNT = "00000000-0000-0000-0000-c0c000000023"
    const CONVERSATION = "00000000-0000-0000-0000-c0c000000024"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'ContactMergeRouteOrg', 'contact-merge-route-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'merge-route@test.com', 'Merge Route') ON CONFLICT (id) DO NOTHING`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${ORG}`
    await sql`INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, provider, email_address, display_name, sync_status) VALUES (${ACCOUNT}, ${ORG}, gen_random_uuid(), 'org', 'gmail', 'merge-route@example.com', 'Merge Route', 'connected')`
    const writeToken = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Merge Route",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [
          "kernel:contacts:write",
          "kernel:contacts:read",
          "mail:conversations:read",
          "mail:conversations:write",
        ],
        dimensionGrants: { "mail:inbox": [ACCOUNT] },
      },
      env.JWT_SECRET,
    )
    const sourceRes = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ email: "source-route@example.com", name: "Source Route" }),
    })
    const targetRes = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ email: "target-route@example.com", name: "Target Route" }),
    })
    const source = ((await sourceRes.json()) as any).data
    const target = ((await targetRes.json()) as any).data
    await sql`INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, external_thread_id, subject, contact_id, status, labels, is_read, is_starred, message_count) VALUES (${CONVERSATION}, ${ORG}, ${ACCOUNT}, 'org', 'route-thread', 'Route Merge', ${source.id}, 'open', '[]'::jsonb, false, false, 0)`

    const res = await app.request("/api/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({
        sourceId: source.id,
        targetId: target.id,
        resolvedFields: { name: "Merged Route" },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.contact.id).toBe(target.id)
    expect(body.data.mergedConversationCount).toBe(1)
    const [sourceRow] = await sql`SELECT id FROM kernel.contacts WHERE id = ${source.id}`
    const [conversationRow] =
      await sql`SELECT contact_id FROM app_mail.conversations WHERE id = ${CONVERSATION}`
    expect(sourceRow).toBeUndefined()
    expect(conversationRow.contact_id).toBe(target.id)
  })

  it("PATCH /api/contacts/:id updates contact", async () => {
    const createRes = await app.request("/api/contacts/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "update-me@example.com" }),
    })
    const { data: created } = (await createRes.json()) as any

    const res = await app.request(`/api/contacts/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Updated Name", company: "ACME" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.name).toBe("Updated Name")
    expect(body.data.company).toBe("ACME")
  })

  it("GET /api/contacts?page=0 clamps page to 1", async () => {
    const res = await app.request("/api/contacts?page=0", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.meta.page).toBe(1)
  })

  it("POST /resolve keeps a new contact private unless the caller chooses the organisation; the owner shares it", async () => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const mine = (await (
      await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: `mine-${Date.now()}@example.com` }),
      })
    ).json()) as any
    expect(mine.data.orgAccess).toBe("none")
    const org = (await (
      await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: `org-${Date.now()}@example.com`, audience: "org" }),
      })
    ).json()) as any
    expect(org.data.orgAccess).toBe("editor")

    const before = (await (
      await app.request(`/api/contacts/${mine.data.id}/sharing`, { headers: auth })
    ).json()) as any
    expect(before.data).toMatchObject({ orgAccess: "none", canManage: true, users: [] })
    const put = await app.request(`/api/contacts/${mine.data.id}/sharing`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ orgAccess: "editor" }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as any).data.orgAccess).toBe("editor")
    const invalid = await app.request(`/api/contacts/${mine.data.id}/sharing`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ orgAccess: "everyone" }),
    })
    expect(invalid.status).toBe(400)
  })

  it("POST /api/contacts/:id/discussion opens the contact's thread to whoever sees the contact, and only them", async () => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const contact = (await (
      await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: `discussed-${Date.now()}@example.com` }),
      })
    ).json()) as any
    const open = (headers: Record<string, string>) =>
      app.request(`/api/contacts/${contact.data.id}/discussion`, { method: "POST", headers })
    const opened = await open(auth)
    expect(opened.status).toBe(200)
    const threadId = ((await opened.json()) as any).data.threadId as string
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/)
    // One thread per contact: opening it again finds the same one.
    expect(((await (await open(auth)).json()) as any).data.threadId).toBe(threadId)
    const [thread] = await sql<{ hidden_from_list: boolean; handle: string }[]>`
      SELECT hidden_from_list, handle FROM kernel.threads WHERE id = ${threadId}`
    expect(thread).toEqual({ hidden_from_list: true, handle: `contact-primary:${contact.data.id}` })
    const posted = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "Called back, wants a quote by Friday." }),
    })
    expect(posted.status).toBeLessThan(300)

    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`
      SELECT org_id::text FROM kernel.users WHERE email = 'admin@test.com'`
    const teammate = await minimal.session(orgId, { role: "member" })
    const asTeammate = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teammate.bearer}`,
    }
    const contents = async (headers: Record<string, string>): Promise<string[]> => {
      const res = await app.request(`/api/threads/${threadId}/messages`, { headers })
      if (res.status !== 200) return []
      return (((await res.json()) as any).data ?? []).map((m: { content: string }) => m.content)
    }
    // A private contact: its discussion is private too, even with the thread id in hand.
    expect((await open(asTeammate)).status).toBe(404)
    expect(await contents(asTeammate)).toEqual([])
    const intruder = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: asTeammate,
      body: JSON.stringify({ content: "Not mine to write" }),
    })
    expect(intruder.status).toBeGreaterThanOrEqual(400)

    // Shared for viewing: the teammate sees it, so reads and writes its discussion.
    const share = (orgAccess: string) =>
      app.request(`/api/contacts/${contact.data.id}/sharing`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ orgAccess }),
      })
    expect((await share("viewer")).status).toBe(200)
    const theirs = await open(asTeammate)
    expect(theirs.status).toBe(200)
    expect(((await theirs.json()) as any).data.threadId).toBe(threadId)
    expect(await contents(asTeammate)).toContain("Called back, wants a quote by Friday.")
    const reply = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: asTeammate,
      body: JSON.stringify({ content: "I'll send the terms." }),
    })
    expect(reply.status).toBeLessThan(300)

    // Made private again: the teammate is out of the discussion at once.
    expect((await share("none")).status).toBe(200)
    expect(await contents(asTeammate)).toEqual([])
    expect((await open(asTeammate)).status).toBe(404)
    expect(await contents(auth)).toContain("I'll send the terms.")
  })

  it("a merge folds the merged-away contact's discussion into the survivor's, in order, with its authors", async () => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const resolve = async (email: string) =>
      (
        (await (
          await app.request("/api/contacts/resolve", {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ email }),
          })
        ).json()) as any
      ).data.id as string
    const stamp = Date.now()
    const source = await resolve(`merge-src-${stamp}@example.com`)
    const target = await resolve(`merge-dst-${stamp}@example.com`)
    for (const id of [source, target]) {
      const shared = await app.request(`/api/contacts/${id}/sharing`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ orgAccess: "viewer" }),
      })
      expect(shared.status).toBe(200)
    }
    const open = async (id: string, headers: Record<string, string> = auth) =>
      app.request(`/api/contacts/${id}/discussion`, { method: "POST", headers })
    const threadOf = async (id: string, headers?: Record<string, string>) =>
      ((await (await open(id, headers)).json()) as any).data.threadId as string
    const post = async (threadId: string, content: string, headers = auth) => {
      const res = await app.request(`/api/threads/${threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content }),
      })
      expect(res.status).toBeLessThan(300)
    }
    const sourceThread = await threadOf(source)
    const targetThread = await threadOf(target)
    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`
      SELECT org_id::text FROM kernel.users WHERE email = 'admin@test.com'`
    const teammate = await minimal.session(orgId, { role: "member" })
    const asTeammate = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teammate.bearer}`,
    }
    const onlySource = await minimal.session(orgId, { role: "member" })
    const asOnlySource = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${onlySource.bearer}`,
    }
    expect(await threadOf(target, asTeammate)).toBe(targetThread)
    expect(await threadOf(source, asOnlySource)).toBe(sourceThread)
    await post(sourceThread, "First call: interested in the pro plan.")
    await post(targetThread, "Same person, other address: asked for a demo.", asTeammate)
    await post(sourceThread, "Sent the pricing sheet.")
    const before = await sql<{ id: string; author_id: string; created_at: Date }[]>`
      SELECT id::text, author_id::text, created_at FROM kernel.messages
       WHERE thread_id IN (${sourceThread}, ${targetThread}) ORDER BY created_at, id`

    const merged = await app.request("/api/contacts/merge", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sourceId: source, targetId: target }),
    })
    expect(merged.status).toBe(200)

    // One discussion, the survivor's, holding every message in the order written.
    const after = await sql<
      { id: string; author_id: string; created_at: Date; content: string; thread_id: string }[]
    >`SELECT id::text, author_id::text, created_at, content, thread_id::text FROM kernel.messages
       WHERE id IN ${sql(before.map((m) => m.id))} ORDER BY created_at, id`
    expect(after.map((m) => m.thread_id)).toEqual(before.map(() => targetThread))
    expect(after.map(({ id, author_id, created_at }) => ({ id, author_id, created_at }))).toEqual(
      before,
    )
    expect(after.map((m) => m.content)).toEqual([
      "First call: interested in the pro plan.",
      "Same person, other address: asked for a demo.",
      "Sent the pricing sheet.",
    ])
    expect((await sql`SELECT 1 FROM kernel.threads WHERE id = ${sourceThread}`).length).toBe(0)
    expect(await threadOf(target)).toBe(targetThread)
    // Seats follow the survivor's sharing: someone seated in the source only
    // is not carried, and gets in again by opening the survivor, which they see.
    const seated = async () =>
      (
        await sql`SELECT 1 FROM kernel.thread_participants
          WHERE thread_id = ${targetThread} AND user_id = ${onlySource.userId}`
      ).length
    expect(await seated()).toBe(0)
    expect(await threadOf(target, asOnlySource)).toBe(targetThread)
    expect(await seated()).toBe(1)
    const res = await app.request(`/api/threads/${targetThread}/messages`, {
      headers: asOnlySource,
    })
    expect(res.status).toBe(200)
    const seen = (((await res.json()) as any).data ?? []).map((m: { content: string }) => m.content)
    expect(seen).toContain("Sent the pricing sheet.")
  })

  it("a merge into a contact with no discussion yet hands it the merged-away contact's", async () => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const resolve = async (email: string) =>
      (
        (await (
          await app.request("/api/contacts/resolve", {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ email }),
          })
        ).json()) as any
      ).data.id as string
    const stamp = Date.now()
    const source = await resolve(`handover-src-${stamp}@example.com`)
    const target = await resolve(`handover-dst-${stamp}@example.com`)
    const opened = await app.request(`/api/contacts/${source}/discussion`, {
      method: "POST",
      headers: auth,
    })
    const threadId = ((await opened.json()) as any).data.threadId as string
    await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "Prefers calls after 4pm." }),
    })
    const merged = await app.request("/api/contacts/merge", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sourceId: source, targetId: target }),
    })
    expect(merged.status).toBe(200)
    const [thread] = await sql<{ handle: string; entity: string }[]>`
      SELECT handle, created_from ->> 'entityId' AS entity FROM kernel.threads WHERE id = ${threadId}`
    expect(thread).toEqual({ handle: `contact-primary:${target}`, entity: target })
    const refs = await sql<{ entity_id: string }[]>`
      SELECT entity_id FROM kernel.thread_references WHERE thread_id = ${threadId}`
    expect(refs.map((r) => r.entity_id)).toEqual([target])
    const reopened = await app.request(`/api/contacts/${target}/discussion`, {
      method: "POST",
      headers: auth,
    })
    expect(((await reopened.json()) as any).data.threadId).toBe(threadId)
  })

  it("deleting a contact deletes its discussion: nothing of it stays readable", async () => {
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const contact = (await (
      await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ email: `deleted-discussion-${Date.now()}@example.com` }),
      })
    ).json()) as any
    const opened = await app.request(`/api/contacts/${contact.data.id}/discussion`, {
      method: "POST",
      headers: auth,
    })
    const threadId = ((await opened.json()) as any).data.threadId as string
    const posted = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "Asked us to forget them." }),
    })
    expect(posted.status).toBeLessThan(300)

    const deleted = await app.request(`/api/contacts/${contact.data.id}`, {
      method: "DELETE",
      headers: auth,
    })
    expect(deleted.status).toBe(200)
    expect((await sql`SELECT 1 FROM kernel.threads WHERE id = ${threadId}`).length).toBe(0)
    expect((await sql`SELECT 1 FROM kernel.messages WHERE thread_id = ${threadId}`).length).toBe(0)
    expect(
      (await app.request(`/api/threads/${threadId}/messages`, { headers: auth })).status,
    ).toBeGreaterThanOrEqual(400)
  })

  it("GET /api/sharing/members and /roles list the share targets", async () => {
    const auth = { Authorization: `Bearer ${token}` }
    const members = (await (
      await app.request("/api/sharing/members", { headers: auth })
    ).json()) as any
    expect(members.data.some((m: any) => m.email === "admin@test.com")).toBe(true)
    const roles = await app.request("/api/sharing/roles", { headers: auth })
    expect(roles.status).toBe(200)
    expect(Array.isArray(((await roles.json()) as any).data)).toBe(true)
    expect((await app.request("/api/sharing/members")).status).toBe(401)
  })

  it("contact groups: CRUD, members, the list filter and the contact's groups (S15)", async () => {
    const json = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    const auth = { Authorization: `Bearer ${token}` }
    const resolve = async (email: string) =>
      (
        (await (
          await app.request("/api/contacts/resolve", {
            method: "POST",
            headers: json,
            body: JSON.stringify({ email, name: email.split("@")[0], audience: "org" }),
          })
        ).json()) as any
      ).data.id as string
    const inGroup = await resolve("group-member@example.com")
    const outside = await resolve("group-outsider@example.com")

    const createRes = await app.request("/api/contacts/groups", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "Route group" }),
    })
    expect(createRes.status).toBe(201)
    const group = ((await createRes.json()) as any).data
    expect(group).toMatchObject({ name: "Route group", memberCount: 0 })

    const dup = await app.request("/api/contacts/groups", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "route GROUP" }),
    })
    expect(dup.status).toBe(409)

    const addRes = await app.request(`/api/contacts/groups/${group.id}/members`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ contactIds: [inGroup] }),
    })
    expect(addRes.status).toBe(200)
    expect(((await addRes.json()) as any).data).toMatchObject({ changed: 1, notFound: [] })

    const groups = (
      (await (await app.request("/api/contacts/groups", { headers: auth })).json()) as any
    ).data
    expect(groups).toContainEqual(expect.objectContaining({ id: group.id, memberCount: 1 }))

    const filtered = (await (
      await app.request(`/api/contacts?groupId=${group.id}&mode=all`, { headers: auth })
    ).json()) as any
    expect(filtered.data.map((c: any) => c.id)).toEqual([inGroup])
    expect(filtered.data.map((c: any) => c.id)).not.toContain(outside)
    expect((await app.request("/api/contacts?groupId=nope", { headers: auth })).status).toBe(400)

    const members = (await (
      await app.request(`/api/contacts/groups/${group.id}/members`, { headers: auth })
    ).json()) as any
    expect(members.data.map((c: any) => c.id)).toEqual([inGroup])
    expect(members.meta.total).toBe(1)

    const ofContact = (await (
      await app.request(`/api/contacts/${inGroup}/groups`, { headers: auth })
    ).json()) as any
    expect(ofContact.data).toEqual([{ id: group.id, name: "Route group" }])

    const renamed = await app.request(`/api/contacts/groups/${group.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ name: "Renamed group" }),
    })
    expect(((await renamed.json()) as any).data.name).toBe("Renamed group")

    const removeRes = await app.request(`/api/contacts/groups/${group.id}/members/remove`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ contactIds: [inGroup] }),
    })
    expect(((await removeRes.json()) as any).data).toMatchObject({ changed: 1 })

    const del = await app.request(`/api/contacts/groups/${group.id}`, {
      method: "DELETE",
      headers: auth,
    })
    expect(del.status).toBe(200)
    expect(
      (await app.request(`/api/contacts/groups/${group.id}`, { method: "DELETE", headers: auth }))
        .status,
    ).toBe(404)
  })
})

describe("Fix #7: resolveContact isNew flag", () => {
  const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
  const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Contact isNew Org', 'contact-isnew')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${TEST_USER_ID}, ${TEST_ORG_ID}, 'contact-isnew@test.com', 'Contact Test', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("returns isNew=true for a new contact and isNew=false for existing", async () => {
    const { resolveContact } = await import("~/modules/contacts/service")
    const { withRlsContext } = await import("~/db/rls")
    const { sql } = await import("~/db/connection")

    const testEmail = `resolve-test-${Date.now()}@test.com`

    // First resolve — should create
    const r1 = await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["kernel:contacts:write"],
        dimensionGrants: {},
      },
      (tx) =>
        resolveContact(
          tx,
          TEST_ORG_ID,
          TEST_USER_ID,
          { email: testEmail, name: "Test" },
          { audience: "org" },
        ),
    )
    expect(r1.isNew).toBe(true)

    // Second resolve with same email — should find existing
    const r2 = await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["kernel:contacts:write"],
        dimensionGrants: {},
      },
      (tx) =>
        resolveContact(
          tx,
          TEST_ORG_ID,
          TEST_USER_ID,
          { email: testEmail, name: "Test" },
          { audience: "org" },
        ),
    )
    expect(r2.isNew).toBe(false)
    expect(r2.contact!.id).toBe(r1.contact!.id)

    // Clean up
    await sql`DELETE FROM kernel.contacts WHERE id = ${r1.contact!.id}`
  })
})
