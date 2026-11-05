// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One pending reply draft per ticket.
//
// Observed on prod: a customer sent two emails a few minutes apart. Each
// inbound message fired the support routine (tickets:message:create), each
// tick drafted a reply, and each tickets:reply call staged its OWN pending
// approval, so the ticket carried two competing reply drafts. The same stack
// happens when one event's tick is retried after a worker restart that died
// after the draft was staged.
//
// tickets:reply now declares `approvalDedupeKeyParam: "ticketId"`, so a second
// staging call for a ticket that already has a pending reply draft restages
// THAT approval in place (newest body wins) instead of creating another one.
// The test drives the real tickets manifest registration and the real
// executeTool gate, as a routine tick would.

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
let agentId: string

beforeAll(async () => {
  const slug = `reply-one-pending-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("reply-one-pending-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Reply One Pending Test', ${slug}) RETURNING id`),
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
    agentId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (gen_random_uuid(), ${orgId}, 'role', ${`@support-${slug}`}, 'Support')
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

async function createTicket(): Promise<string> {
  return withPrivilegedDb(orgId, "reply-one-pending-ticket", async (tx) => {
    const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
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
    return ticketId
  })
}

async function addInbound(ticketId: string, text: string): Promise<void> {
  await withPrivilegedDb(orgId, "reply-one-pending-inbound", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, text_body, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust', ${text},
        now(), now(), now()
      )
    `),
  )
}

const replyActor = {
  actorType: "user",
  userId: "",
  orgId: "",
  scopes: ["tickets:tickets:read", "tickets:tickets:reply"],
  dimensionGrants: {},
}

/** One routine tick drafting a reply: a tick runs AS its owner (kernel-jobs
 *  agentInvoker) without the approve scope, with the routine's agent acting,
 *  so its gated tickets:reply call parks an approval naming that agent. */
function draftAsRoutineTick(ticketId: string, textBody: string) {
  return executeTool({
    toolName: "tickets:reply",
    orgId,
    actor: { ...replyActor, userId, orgId } as never,
    threadId,
    params: { ticketId, textBody },
    origin: "in-app-agent",
    agentId,
  })
}

/** The same person asking their own assistant in chat to draft a reply: an
 *  agent-originated call with no role agent acting. (A person's own UI click
 *  never parks an approval: without the approve scope it is refused.) The
 *  routine owner and the chatting person are the same user on purpose, the
 *  worst case. */
function draftInPersonsChat(ticketId: string, textBody: string) {
  return executeTool({
    toolName: "tickets:reply",
    orgId,
    actor: { ...replyActor, userId, orgId } as never,
    threadId,
    params: { ticketId, textBody },
    origin: "in-app-agent",
  })
}

async function pendingReplyDrafts(ticketId: string) {
  const r = await withPrivilegedDb(orgId, "reply-one-pending-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, current_payload->>'textBody' AS body
      FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'tickets:reply' AND status = 'pending'
        AND tool_params->>'ticketId' = ${ticketId}`),
  )
  return extractRows<{ id: string; body: string }>(r)
}

describe("tickets:reply: one pending reply draft per ticket", () => {
  it("two routine ticks for two inbound messages on one ticket leave ONE pending draft carrying the newest body", async () => {
    const ticketId = await createTicket()

    await addInbound(ticketId, "The quantize does nothing.")
    const first = await draftAsRoutineTick(ticketId, "Draft answering the first email.")
    expect(first.blocked?.reason).toBe("gated")

    await addInbound(ticketId, "Also, the manual says the opposite.")
    const second = await draftAsRoutineTick(ticketId, "Draft answering both emails.")
    expect(second.blocked?.reason).toBe("gated")

    // FALSIFIABLE: without the dedupe key the second tick stages its own
    // approval, two pending drafts sit on the ticket and these fail.
    expect(second.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    const pending = await pendingReplyDrafts(ticketId)
    expect(pending.length).toBe(1)
    expect(pending[0]!.body).toContain("Draft answering both emails.")
  })

  it("a retried tick for the SAME event re-surfaces the existing draft instead of stacking one", async () => {
    const ticketId = await createTicket()
    await addInbound(ticketId, "Help please.")
    const first = await draftAsRoutineTick(ticketId, "Same draft.")
    const retried = await draftAsRoutineTick(ticketId, "Same draft.")
    expect(retried.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    expect((await pendingReplyDrafts(ticketId)).length).toBe(1)
  })

  it("drafts on two DIFFERENT tickets stay two separate approvals", async () => {
    const a = await createTicket()
    const b = await createTicket()
    await addInbound(a, "A")
    await addInbound(b, "B")
    const ra = await draftAsRoutineTick(a, "Reply A")
    const rb = await draftAsRoutineTick(b, "Reply B")
    expect(ra.blocked!.approvalRequestId).not.toBe(rb.blocked!.approvalRequestId!)
    expect((await pendingReplyDrafts(a)).length).toBe(1)
    expect((await pendingReplyDrafts(b)).length).toBe(1)
  })

  // Walk 2026-10-19: a ticket already held a pending reply draft; the person asked their own
  // agent to "draft a reply" and a SECOND pending draft appeared next to it. The dedupe only
  // restaged a draft staged by the very same requester + agent + routine, so any other caller
  // stacked its own. Now a draft by someone else is never overwritten AND never doubled: the
  // call is refused with the pending draft's id, and tickets:get shows that draft.
  it("a draft by another requester is neither overwritten nor doubled: the call is refused naming it", async () => {
    const ticketId = await createTicket()
    await addInbound(ticketId, "Question.")
    const human = await draftInPersonsChat(ticketId, "My own careful answer.")
    expect(human.blocked?.reason).toBe("gated")
    const humanApprovalId = human.blocked!.approvalRequestId!

    await addInbound(ticketId, "Follow-up.")
    // FALSIFIABLE: on the old code this staged a second pending draft.
    const refused = await draftAsRoutineTick(ticketId, "Agent draft.").then(
      () => null,
      (err: unknown) => err as { code?: string; message?: string },
    )
    expect(refused?.code).toBe("approval_already_pending")
    expect(refused?.message).toContain(humanApprovalId)
    // The refusal orders the agent to update the waiting draft, naming the call and the field.
    expect(refused?.message).toContain("a draft ALREADY EXISTS")
    expect(refused?.message).toContain(
      `kernel__approval_update_payload with requestId ${humanApprovalId}`,
    )
    expect(refused?.message).toContain("editable fields: textBody")

    const pending = await pendingReplyDrafts(ticketId)
    expect(pending.length).toBe(1)
    expect(pending[0]!.id).toBe(humanApprovalId)
    expect(pending[0]!.body).toContain("My own careful answer.")
  })

  it("tickets:get lists the ticket's pending reply draft (text, approval id, who drafted it)", async () => {
    const ticketId = await createTicket()
    await addInbound(ticketId, "Where is my order?")
    const staged = await draftAsRoutineTick(ticketId, "Your order ships tomorrow.")
    const got = (await executeTool({
      toolName: "tickets:get",
      orgId,
      actor: { ...replyActor, userId, orgId } as never,
      threadId,
      params: { ticketId },
      origin: "in-app-agent",
    })) as {
      data?: {
        pendingReplyDrafts?: Array<{
          approvalId: string
          textBody: string
          requestedBy: { userId: string; name: string | null }
          agent: { id: string; name: string | null } | null
          createdAt: string
        }>
      }
    }
    const drafts = got.data?.pendingReplyDrafts ?? []
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      approvalId: staged.blocked!.approvalRequestId,
      textBody: "Your order ships tomorrow.",
      requestedBy: { userId, name: "A" },
      agent: { id: agentId, name: "Support" },
    })
    expect(typeof drafts[0]!.createdAt).toBe("string")
  })
})
