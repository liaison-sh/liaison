// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { toolRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000065001"
const USER = "00000000-0000-4000-8000-000000065002"
const THREAD = "00000000-0000-4000-8000-000000065003"
const REQUEST = "00000000-0000-4000-8000-000000065004"
const TOOL = "route_approval:approveMe"

describe("POST /api/approvals/:id/decide", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approval Route Org', 'approval-route-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'approval-route@test.com', 'Approval Route User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'approval-route-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'route_approval:write'), (${USER}, ${ORG}, 'route_approval:approve')
      ON CONFLICT DO NOTHING`
    toolRegistry.set([ORG, "route_approval", "approveMe"], {
      appName: "route_approval",
      name: "approveMe",
      description: "Approve me",
      requiredScopes: ["route_approval:write"],
      gated: true,
      handler: async () => {
        const [row] =
          await sql`SELECT decided_by FROM kernel.approval_requests WHERE id = ${REQUEST}`
        const ctx = {
          orgId: ORG,
          approvalRequestId: REQUEST,
          approvalDeciderId: row.decided_by,
          toolName: TOOL,
        }
        await withPrivilegedDb(ORG, "route-approval-start", (tx) => recordStarted(tx, ctx, TOOL))
        await withPrivilegedDb(ORG, "route-approval-success", (tx) =>
          recordSucceeded(tx, ctx, TOOL, { ok: true }),
        )
        return { ok: true }
      },
      returns: { schema: { ok: "boolean" } },
    } as any)
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason
    ) VALUES (
      ${REQUEST}, ${ORG}, 'route-request', ${THREAD}, ${THREAD}, ${TOOL}, '{}'::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER}, 'pending', 'gated'
    )`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Approval Route User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["route_approval:write", "route_approval:approve"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await releaseTestLock()
  })

  it("refuses an approve that carries no payloadHash (a decision is bound to what was shown)", async () => {
    const res = await app.request(`/api/approvals/${REQUEST}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(res.status).toBe(400)
  })

  it("refuses an approve whose payloadHash is stale", async () => {
    const res = await app.request(`/api/approvals/${REQUEST}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: "approve", payloadHash: "0".repeat(64) }),
    })
    expect(res.status).toBe(409)
  })

  it("allows a self-approver without kernel:approvals:write", async () => {
    const shown = await app.request(`/api/approvals/${REQUEST}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const payloadHash = ((await shown.json()) as any).data.payloadHash as string
    expect(payloadHash).toHaveLength(64)
    const res = await app.request(`/api/approvals/${REQUEST}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: "approve", payloadHash }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toMatchObject({ id: REQUEST, status: "approved", decidedBy: USER })
  })

  it("exposes the decided tool result via GET /:id/result after approval", async () => {
    // Runs after the approve test above (sequential within the describe) — the
    // handler's {ok:true} return was persisted to approved_handler_executions.
    const res = await app.request(`/api/approvals/${REQUEST}/result`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toMatchObject({ status: "approved", result: { ok: true } })
  })
})

describe("GET /api/approvals list/detail", () => {
  const LIST_ORG = "00000000-0000-4000-8000-000000065101"
  const LIST_USER = "00000000-0000-4000-8000-000000065102"
  const LIST_THREAD = "00000000-0000-4000-8000-000000065103"
  const LIST_REQUEST = "00000000-0000-4000-8000-000000065104"
  // Distinct requester for the routine-raised fixture (below) — a routine
  // ticks as its own agent identity, not LIST_USER, and using a different
  // requested_by keeps that fixture out of LIST_USER's decidable feed
  // (requested_by === userId short-circuits canSee in the non-ticket modes).
  const LIST_ROUTINE_REQUESTER = "00000000-0000-4000-8000-000000065107"
  let listToken: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${LIST_ORG}, 'Approval List Org', 'approval-list-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
      VALUES (${LIST_USER}, ${LIST_ORG}, 'approval-list@test.local', 'Approval List User', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
      VALUES (${LIST_ROUTINE_REQUESTER}, ${LIST_ORG}, 'approval-list-routine@test.local', 'Approval List Routine', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${LIST_USER}, ${LIST_ORG}, 'list_approval:approve') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${LIST_THREAD}, ${LIST_ORG}, 'approval-list-thread', 'approval', ${LIST_USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${LIST_THREAD}, ${LIST_USER}, ${LIST_ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${LIST_REQUEST}, ${LIST_ORG}, 'request-list', ${LIST_THREAD}, ${LIST_THREAD}, 'list_approval:tool', '{}'::jsonb,
      '{"message":"hello"}'::jsonb, now() + interval '1 hour', ARRAY[${LIST_USER}]::uuid[], ${LIST_USER}, 'pending', 'gated',
      '{"kind":"list","title":"List Approval","lines":[]}'::jsonb
    ) ON CONFLICT DO NOTHING`
    listToken = await signAccessToken(
      {
        userId: LIST_USER,
        orgId: LIST_ORG,
        name: "Approval List User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["list_approval:approve", "kernel:approvals:read"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${LIST_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${LIST_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${LIST_ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${LIST_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${LIST_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${LIST_ORG}`
  })

  it("rejects unsupported list query strings", async () => {
    const res = await app.request("/api/approvals?status=pending&decidableByMe=true&foo=bar", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(res.status).toBe(400)
  })

  it("lists approvals by threadId (MCP connection threads host many approvals)", async () => {
    const res = await app.request(`/api/approvals?threadId=${LIST_THREAD}`, {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(LIST_REQUEST)

    // A thread with no approvals returns an empty list, not an error.
    const empty = await app.request(
      "/api/approvals?threadId=00000000-0000-4000-8000-000000065fff",
      {
        headers: { Authorization: `Bearer ${listToken}` },
      },
    )
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as any).data).toHaveLength(0)
  })

  it("lists approvals by ticketId even when raised by a routine on a different thread", async () => {
    // Proven staging shape: an agent ROUTINE raises the gated tickets:reply
    // approval on its own output thread (not the ticket's internalThreadId),
    // recording the ticket id only in tool_params. The threadId mode can
    // never find this row; ticketId mode matches on tool_params.ticketId
    // regardless of which thread hosts the approval_request.
    const ROUTINE_THREAD = "00000000-0000-4000-8000-000000065105"
    const ROUTINE_REQUEST = "00000000-0000-4000-8000-000000065106"
    const TICKET_ID = "00000000-0000-4000-8000-000000065999"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${ROUTINE_THREAD}, ${LIST_ORG}, 'routine-output-thread', 'agent_chat', ${LIST_USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${ROUTINE_REQUEST}, ${LIST_ORG}, 'request-routine', ${ROUTINE_THREAD}, ${ROUTINE_THREAD}, 'tickets:reply',
      ${`{"ticketId":"${TICKET_ID}","body":"Routine drafted reply"}`}::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[]::uuid[], ${LIST_ROUTINE_REQUESTER}, 'pending', 'gated',
      '{"kind":"list","title":"Reply","lines":[]}'::jsonb
    ) ON CONFLICT DO NOTHING`

    const ticketReadToken = await signAccessToken(
      {
        userId: LIST_USER,
        orgId: LIST_ORG,
        name: "Approval List User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["tickets:tickets:read"],
      },
      env.JWT_SECRET,
    )

    const res = await app.request(`/api/approvals?ticketId=${TICKET_ID}`, {
      headers: { Authorization: `Bearer ${ticketReadToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(ROUTINE_REQUEST)

    // A ticket with no matching approvals returns an empty list, not an error.
    const empty = await app.request(
      "/api/approvals?ticketId=00000000-0000-4000-8000-0000000659ff",
      {
        headers: { Authorization: `Bearer ${ticketReadToken}` },
      },
    )
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as any).data).toHaveLength(0)
  })

  it("lists approvals by conversationId (gated mail:reply drafts, mirrors ticket mode)", async () => {
    const MAIL_THREAD = "00000000-0000-4000-8000-000000065108"
    const MAIL_REQUEST = "00000000-0000-4000-8000-000000065109"
    const CONVERSATION_ID = "00000000-0000-4000-8000-000000065997"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${MAIL_THREAD}, ${LIST_ORG}, 'mail-routine-thread', 'agent_chat', ${LIST_USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${MAIL_REQUEST}, ${LIST_ORG}, 'request-mail', ${MAIL_THREAD}, ${MAIL_THREAD}, 'mail:reply',
      ${`{"conversationId":"${CONVERSATION_ID}","textBody":"Drafted mail reply"}`}::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[]::uuid[], ${LIST_ROUTINE_REQUESTER}, 'pending', 'gated',
      '{"kind":"list","title":"Mail reply","lines":[]}'::jsonb
    ) ON CONFLICT DO NOTHING`

    const mailReadToken = await signAccessToken(
      {
        userId: LIST_USER,
        orgId: LIST_ORG,
        name: "Approval List User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["mail:conversations:read"],
      },
      env.JWT_SECRET,
    )

    const res = await app.request(`/api/approvals?conversationId=${CONVERSATION_ID}`, {
      headers: { Authorization: `Bearer ${mailReadToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(MAIL_REQUEST)

    // Without mail:conversations:read the same list returns nothing.
    const noScopeToken = await signAccessToken(
      {
        userId: LIST_USER,
        orgId: LIST_ORG,
        name: "Approval List User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["list_approval:approve"],
      },
      env.JWT_SECRET,
    )
    const denied = await app.request(`/api/approvals?conversationId=${CONVERSATION_ID}`, {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    })
    expect(denied.status).toBe(200)
    expect(((await denied.json()) as any).data).toEqual([])
  })

  it("rejects the ticketId list without tickets:tickets:read even if requested_by matches", async () => {
    // Ticket mode authorizes on tickets:tickets:read alone (mirrors ticket
    // reads), NOT on requested_by/notify_user_ids like the other modes — a
    // token missing the ticket-read scope must see nothing, even for its own
    // requested approval.
    const NO_SCOPE_TOKEN = await signAccessToken(
      {
        userId: LIST_USER,
        orgId: LIST_ORG,
        name: "Approval List User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["list_approval:approve"],
      },
      env.JWT_SECRET,
    )
    const TICKET_ID = "00000000-0000-4000-8000-000000065998"
    const res = await app.request(`/api/approvals?ticketId=${TICKET_ID}`, {
      headers: { Authorization: `Bearer ${NO_SCOPE_TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data).toEqual([])
  })

  it("scopes the decidable feed to one app's tools with app=", async () => {
    const mine = await app.request(
      "/api/approvals?status=pending&decidableByMe=true&app=list_approval",
      {
        headers: { Authorization: `Bearer ${listToken}` },
      },
    )
    expect(mine.status).toBe(200)
    expect(((await mine.json()) as any).data.map((r: any) => r.id)).toEqual([LIST_REQUEST])

    const other = await app.request("/api/approvals?status=pending&decidableByMe=true&app=boxtal", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(other.status).toBe(200)
    expect(((await other.json()) as any).data).toEqual([])

    // A prefix is not an app: "list" must not match "list_approval:tool".
    const prefix = await app.request("/api/approvals?status=pending&decidableByMe=true&app=list", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(((await prefix.json()) as any).data).toEqual([])

    const bad = await app.request("/api/approvals?status=pending&decidableByMe=true&app=a%27b", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(bad.status).toBe(400)
  })

  // Home's "Waiting on others" (D21): the requests I raised that are still
  // pending, whoever decides them. Someone else's pending request, and my own
  // decided ones, are not in it.
  it("lists my own pending requests with requestedByMe=true", async () => {
    const MINE_DECIDED = "00000000-0000-4000-8000-000000065121"
    const OTHERS = "00000000-0000-4000-8000-000000065122"
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES
    (${MINE_DECIDED}, ${LIST_ORG}, 'request-mine-decided', ${LIST_THREAD}, ${LIST_THREAD}, 'list_approval:tool', '{}'::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[${LIST_USER}]::uuid[], ${LIST_USER}, 'denied', 'gated',
      '{"kind":"list","title":"Mine decided","lines":[]}'::jsonb),
    (${OTHERS}, ${LIST_ORG}, 'request-others', ${LIST_THREAD}, ${LIST_THREAD}, 'list_approval:tool', '{}'::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[${LIST_USER}]::uuid[], ${LIST_ROUTINE_REQUESTER}, 'pending', 'gated',
      '{"kind":"list","title":"Someone else","lines":[]}'::jsonb)
    ON CONFLICT DO NOTHING`
    try {
      const res = await app.request("/api/approvals?status=pending&requestedByMe=true", {
        headers: { Authorization: `Bearer ${listToken}` },
      })
      expect(res.status).toBe(200)
      const ids = ((await res.json()) as any).data.map((r: any) => r.id)
      expect(ids).toEqual([LIST_REQUEST])

      // The two modes stay exclusive.
      const both = await app.request(
        "/api/approvals?status=pending&requestedByMe=true&decidableByMe=true",
        { headers: { Authorization: `Bearer ${listToken}` } },
      )
      expect(both.status).toBe(400)
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE id IN (${MINE_DECIDED}, ${OTHERS})`
    }
  })

  it("returns list and detail rows with notifyUserIds and denial-only reason", async () => {
    const listRes = await app.request("/api/approvals?status=pending&decidableByMe=true", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as any
    expect(listBody.data).toHaveLength(1)
    expect(listBody.data[0]).toMatchObject({
      id: LIST_REQUEST,
      notifyUserIds: [LIST_USER],
      lastEdit: null,
    })
    expect(listBody.data[0].reason).toBeUndefined()

    const detailRes = await app.request(`/api/approvals/${LIST_REQUEST}`, {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(detailRes.status).toBe(200)
    const detailBody = (await detailRes.json()) as any
    expect(detailBody.data).toMatchObject(listBody.data[0])
  })

  it("GET /:id/result returns status + null result for a still-pending approval", async () => {
    const res = await app.request(`/api/approvals/${LIST_REQUEST}/result`, {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual({ status: "pending", result: null })
  })

  it("GET /:id/result 404s an approval the caller cannot see / does not exist", async () => {
    const res = await app.request("/api/approvals/00000000-0000-4000-8000-0000000651ff/result", {
      headers: { Authorization: `Bearer ${listToken}` },
    })
    expect(res.status).toBe(404)
  })
})
