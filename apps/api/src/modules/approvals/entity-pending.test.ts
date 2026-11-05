// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { listPendingApprovalsForEntities } from "~/modules/approvals/list"

const ORG = "00000000-0000-4000-8000-000000092001"
const USER_A = "00000000-0000-4000-8000-000000092002"
const USER_B = "00000000-0000-4000-8000-000000092003"
const USER_C = "00000000-0000-4000-8000-000000092004"
const THREAD = "00000000-0000-4000-8000-000000092005"

const TICKET_ID = "00000000-0000-4000-8000-0000000920e1"
const ORDER_ID = "00000000-0000-4000-8000-0000000920e2"
const OTHER_ENTITY = "00000000-0000-4000-8000-0000000920e3"

const A_TICKET = "00000000-0000-4000-8000-0000000920a1"
const A_SUMMARY_LINK = "00000000-0000-4000-8000-0000000920a2"
const A_DECIDED = "00000000-0000-4000-8000-0000000920a3"
const A_PERSONAL = "00000000-0000-4000-8000-0000000920a4"

async function insertApproval(opts: {
  id: string
  toolName: string
  toolParams?: Record<string, unknown>
  summary?: Record<string, unknown> | null
  status?: string
  resourceOwnerId?: string
}) {
  const handle = `entpend-${opts.id.slice(-4)}`
  const summary =
    opts.summary === undefined
      ? JSON.stringify({ title: `Title for ${opts.toolName}` })
      : opts.summary === null
        ? null
        : JSON.stringify(opts.summary)
  const params = JSON.stringify(opts.toolParams ?? {})
  const expiresIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, status, tool_name, tool_params, summary, current_payload,
      thread_id, originating_thread_id, requested_by, notify_user_ids,
      resource_owner_id, expires_at
    ) VALUES (
      ${opts.id}, ${ORG}, ${handle}, ${opts.status ?? "pending"},
      ${opts.toolName}, ${params}::jsonb, ${summary}::jsonb, ${params}::jsonb,
      ${THREAD}, ${THREAD}, ${USER_A}, ${sql.array([USER_A], 2950)},
      ${opts.resourceOwnerId ?? null}, ${expiresIso}::timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `
}

function ctx(userId: string) {
  return {
    actorType: "user" as const,
    userId,
    orgId: ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }
}

describe("approvals.entity-pending", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Entity Pending Org', 'entity-pending-org') ON CONFLICT DO NOTHING`
    for (const [id, mail] of [
      [USER_A, "a@entpend.test"],
      [USER_B, "b@entpend.test"],
      [USER_C, "c@entpend.test"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${mail}, ${mail.split("@")[0].toUpperCase()}, 'active', 'hash') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'entpend-thread', 'approval', ${USER_A}) ON CONFLICT DO NOTHING`

    // Ticket reply draft — entity id in tool_params
    await insertApproval({
      id: A_TICKET,
      toolName: "tickets:reply",
      toolParams: { ticketId: TICKET_ID, body: "draft body" },
      summary: { title: "Reply to Joe" },
    })
    // Boxtal-style shipment — entity id ONLY in the summary link (params carry
    // a shipment-internal id, not the order id the user is viewing)
    await insertApproval({
      id: A_SUMMARY_LINK,
      toolName: "boxtal:create_shipment",
      toolParams: { draftId: "d-1" },
      summary: {
        title: "Ship order #1042",
        links: [{ label: "Order", app: "shopify", entityType: "order", entityId: ORDER_ID }],
      },
    })
    // Already decided — must not surface
    await insertApproval({
      id: A_DECIDED,
      toolName: "tickets:reply",
      toolParams: { ticketId: TICKET_ID },
      status: "approved",
    })
    // Personally-routed (personal mailbox draft) — requester A, owner B
    await insertApproval({
      id: A_PERSONAL,
      toolName: "mail:reply",
      toolParams: { conversationId: TICKET_ID },
      resourceOwnerId: USER_B,
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("matches a pending approval by entity id in tool_params", async () => {
    const rows = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_C, entityIds: [TICKET_ID] }),
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(A_TICKET)
    const t = rows.find((r) => r.id === A_TICKET)!
    expect(t.toolName).toBe("tickets:reply")
    expect(t.title).toBe("Reply to Joe")
    expect(t.requesterName).toBe("A")
  })

  it("matches a pending approval by entity id in the summary links (cross-app, e.g. shipment for an order)", async () => {
    // Run as the REQUESTER: non-tickets/mail approvals (e.g. boxtal) are only
    // RLS-visible to requester / notify-approvers / approvals-admins — the
    // shared-surface widening in the 0028 policy covers tickets:% and mail:%
    // only. The entity-pending surface is bounded by that same RLS.
    const rows = await withRlsContext(ctx(USER_A), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_A, entityIds: [ORDER_ID] }),
    )
    expect(rows.map((r) => r.id)).toContain(A_SUMMARY_LINK)
  })

  it("does not widen RLS: a boxtal approval stays invisible to a non-requester without approver/admin grants", async () => {
    const rows = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_C, entityIds: [ORDER_ID] }),
    )
    expect(rows.map((r) => r.id)).not.toContain(A_SUMMARY_LINK)
  })

  it("excludes decided approvals", async () => {
    const rows = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_C, entityIds: [TICKET_ID] }),
    )
    expect(rows.map((r) => r.id)).not.toContain(A_DECIDED)
  })

  it("hides personally-routed approvals from third parties, shows them to requester and owner", async () => {
    const forC = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_C, entityIds: [TICKET_ID] }),
    )
    expect(forC.map((r) => r.id)).not.toContain(A_PERSONAL)

    const forOwner = await withRlsContext(ctx(USER_B), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_B, entityIds: [TICKET_ID] }),
    )
    expect(forOwner.map((r) => r.id)).toContain(A_PERSONAL)

    const forRequester = await withRlsContext(ctx(USER_A), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_A, entityIds: [TICKET_ID] }),
    )
    expect(forRequester.map((r) => r.id)).toContain(A_PERSONAL)
  })

  it("returns empty for unreferenced entities and empty input", async () => {
    const rows = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, {
        orgId: ORG,
        userId: USER_C,
        entityIds: [OTHER_ENTITY],
      }),
    )
    expect(rows).toEqual([])
    const none = await withRlsContext(ctx(USER_C), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER_C, entityIds: [] }),
    )
    expect(none).toEqual([])
  })
})
