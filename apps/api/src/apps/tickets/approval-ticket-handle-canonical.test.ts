// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A gated tickets call staged by HANDLE stores and links the ticket UUID.
//
// Observed on prod: an agent staged tickets:reply with `ticketId: "ticket-10381"`.
// The approval kept that raw handle in its payload and in its "Open ticket"
// link, and the approvals UI resolves a link's entityId as a uuid, so the
// button opened nothing. The same handle in the payload also hid the approval
// from everything that finds a ticket's approvals by uuid (the ticket view,
// merge cancellation, the one-pending-draft-per-ticket dedupe).
//
// Each gated tool's propose-time preflight already resolves the handle; it now
// hands the uuid back (`canonicalParams`) and the kernel stages with it. The
// test drives the real tickets manifest registration and the real executeTool
// gate, as an agent call does.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const { executeTool } = await import("~/modules/apps/execute-tool")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let accountId: string
let inboxId: string
let threadId: string
let nextNumber = 700_000_000 + Math.floor(Math.random() * 1e8)

beforeAll(async () => {
  const slug = `approval-handle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("approval-handle-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Approval Handle Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
    threadId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (gen_random_uuid(), ${orgId}, ${`thread-${slug}`}, 'agent_chat', ${userId})
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

/** A ticket with one inbound customer message, addressed by its handle. */
async function createTicket(): Promise<{ id: string; handle: string }> {
  const handle = `ticket-${nextNumber++}`
  const id = await withPrivilegedDb(orgId, "approval-handle-ticket", async (tx) => {
    const ticketId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Looper question', 'open', 'normal', 'email', 'internal',
          ${Math.random().toString(36).slice(2, 12)}, ${inboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, text_body, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust',
        'The quantize does nothing.', now(), now(), now()
      )
    `)
    return ticketId
  })
  return { id, handle }
}

async function addNote(ticketId: string, text: string): Promise<string> {
  return withPrivilegedDb(
    orgId,
    "approval-handle-note",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (
          id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at
        ) VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'note', ${text}, now(), now(), now())
        RETURNING id
      `),
      )[0]!.id,
  )
}

/** An agent call: the actor holds the tool scope but not the approve scope,
 *  so every gated call parks an approval. */
function agentCall(toolName: string, params: Record<string, unknown>) {
  return executeTool({
    toolName,
    orgId,
    actor: {
      actorType: "user",
      userId,
      orgId,
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:reply",
        "tickets:tickets:close",
        "tickets:tickets:write",
      ],
      dimensionGrants: {},
    } as never,
    threadId,
    params,
    origin: "in-app-agent",
  })
}

type StagedRow = {
  tool_params: Record<string, unknown>
  current_payload: Record<string, unknown>
  summary: { lines?: string[]; links?: Array<{ entityType?: string; entityId?: string }> }
}

async function stagedApproval(approvalId: string): Promise<StagedRow> {
  const r = await withPrivilegedDb(orgId, "approval-handle-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT tool_params, current_payload, summary
      FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND id = ${approvalId}`),
  )
  return extractRows<StagedRow>(r)[0]!
}

/** The three places the uuid must be: the stored params, the editable
 *  payload, and the card's "Open ticket" link. */
function expectStagedForTicket(row: StagedRow, ticketId: string): void {
  expect(row.tool_params.ticketId).toBe(ticketId)
  expect(row.current_payload.ticketId).toBe(ticketId)
  const link = row.summary.links?.find((l) => l.entityType === "ticket")
  expect(link?.entityId).toBe(ticketId)
}

describe("gated tickets tools staged by handle store and link the ticket uuid", () => {
  it("tickets:reply by handle -> approval payload and Open ticket link carry the uuid", async () => {
    const ticket = await createTicket()
    const res = await agentCall("tickets:reply", {
      ticketId: ticket.handle,
      textBody: "Thanks, here is how to fix it.",
    })
    expect(res.blocked?.reason).toBe("gated")
    // FALSIFIABLE: without the canonicalisation these read "ticket-<n>".
    expectStagedForTicket(await stagedApproval(res.blocked!.approvalRequestId!), ticket.id)
  })

  it("tickets:reply by handle then by uuid -> ONE pending draft (the dedupe sees the same ticket)", async () => {
    const ticket = await createTicket()
    const byHandle = await agentCall("tickets:reply", {
      ticketId: ticket.handle,
      textBody: "First draft.",
    })
    const byUuid = await agentCall("tickets:reply", {
      ticketId: ticket.id,
      textBody: "Second draft.",
    })
    expect(byHandle.blocked?.reason).toBe("gated")
    expect(byUuid.blocked?.approvalRequestId).toBe(byHandle.blocked!.approvalRequestId!)
    const row = await stagedApproval(byHandle.blocked!.approvalRequestId!)
    expect(row.current_payload.textBody).toContain("Second draft.")
  })

  it("tickets:close by handle -> approval payload and Open ticket link carry the uuid", async () => {
    const ticket = await createTicket()
    const res = await agentCall("tickets:close", {
      ticketId: ticket.handle,
      closedReason: "resolved",
    })
    expect(res.blocked?.reason).toBe("gated")
    expectStagedForTicket(await stagedApproval(res.blocked!.approvalRequestId!), ticket.id)
  })

  it("tickets:editNote by handle -> uuid stored and linked, card shows the current note text", async () => {
    const ticket = await createTicket()
    const messageId = await addNote(ticket.id, "Customer uses firmware 2.1")
    const res = await agentCall("tickets:editNote", {
      ticketId: ticket.handle,
      messageId,
      text: "Customer uses firmware 2.2",
    })
    expect(res.blocked?.reason).toBe("gated")
    const row = await stagedApproval(res.blocked!.approvalRequestId!)
    expectStagedForTicket(row, ticket.id)
    expect(row.summary.lines?.join("\n")).toContain("Current text: Customer uses firmware 2.1")
  })

  it("a uuid call is staged unchanged", async () => {
    const ticket = await createTicket()
    const res = await agentCall("tickets:close", { ticketId: ticket.id, closedReason: "resolved" })
    expect(res.blocked?.reason).toBe("gated")
    expectStagedForTicket(await stagedApproval(res.blocked!.approvalRequestId!), ticket.id)
  })
})

describe("ticket summarizers given a handle (a path that skips the preflight)", () => {
  it("reply and note cards link the uuid and still load the note", async () => {
    const { summarizeTicketReply, summarizeTicketNoteDelete } = await import(
      "~/apps/tickets/summarizers"
    )
    const ticket = await createTicket()
    const messageId = await addNote(ticket.id, "Serial 4411 confirmed")
    const [reply, note] = await withPrivilegedDb(orgId, "approval-handle-summarize", async (tx) => {
      const ctx = { tx: tx as never, orgId, userId }
      return [
        await summarizeTicketReply({ ticketId: ticket.handle, textBody: "Hi" }, ctx),
        await summarizeTicketNoteDelete({ ticketId: ticket.handle, messageId }, ctx),
      ]
    })
    expect(reply.links?.[0]).toMatchObject({ entityType: "ticket", entityId: ticket.id })
    expect(note.links?.[0]).toMatchObject({ entityType: "ticket", entityId: ticket.id })
    expect(note.lines.join("\n")).toContain("Current text: Serial 4411 confirmed")
  })
})

describe("applyPreflightCanonicalParams", () => {
  it("replaces a string param, never adds, drops or retypes one", async () => {
    const { applyPreflightCanonicalParams } = await import("~/modules/apps/execute-tool")
    const params = { ticketId: "ticket-1", textBody: "Hi", count: 2 }
    const out = applyPreflightCanonicalParams(params, {
      ok: true,
      canonicalParams: { ticketId: "uuid-1", extra: "x", count: "3", textBody: "" },
    })
    expect(out).toEqual({ ticketId: "uuid-1", textBody: "Hi", count: 2 })
    expect(params.ticketId).toBe("ticket-1")
    expect(applyPreflightCanonicalParams(params, { ok: true })).toBe(params)
    expect(applyPreflightCanonicalParams(params, null)).toBe(params)
  })
})
