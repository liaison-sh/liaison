// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ticket 10346: a ticket had an agent/routine-drafted reply sitting as a
// pending gated approval ("suggested draft"). A human ignored it and typed
// their own reply instead. The suggested draft stayed on the ticket forever
// (its ApprovalCard never went away) because nothing ever told the approvals
// system the ticket had moved on.
//
// Fix: a reply that actually sends now cancels any OTHER pending
// tickets:reply/nudge/close approval for the same ticket, reusing the same
// primitive (`cancelApprovalsForSourceTicket`) merge.ts already relies on
// when a ticket disappears into another one.
//
// `sendOutbound` is mocked (HERMETICITY note, same pattern as
// reply-events.test.ts / ack.test.ts): mock.module leaks past this file
// under bun's flat test process, so we spread the REAL module and restore it
// in afterAll.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"

const realSendModule = { ...realSend }

let sendCounter = 0
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async (email: { subject: string }) => ({
    externalMessageId: `<supersede-${++sendCounter}@test>`,
    deliveryState: "delivered" as const,
    rfc2822: "",
  }),
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { ticketsReply } = await import("./tools")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let accountId: string
let inboxId: string
let threadId: string

beforeAll(async () => {
  const slug = `reply-supersedes-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("reply-supersedes-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Reply Supersedes Test', ${slug}) RETURNING id`),
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

async function createTicketWithInbound(): Promise<string> {
  return withPrivilegedDb(orgId, "reply-supersedes-create", async (tx) => {
    const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
    const ticketRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Need help', 'open', 'normal', 'email', 'internal',
          ${Math.random().toString(36).slice(2, 12)}, ${inboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )
    const ticketId = ticketRows[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust',
        now(), now(), now()
      )
    `)
    return ticketId
  })
}

async function insertPendingDraftApproval(
  ticketId: string,
  toolName: "tickets:reply" | "tickets:nudge" | "tickets:close" = "tickets:reply",
): Promise<string> {
  return withPrivilegedDb(orgId, "reply-supersedes-draft", async (tx) => {
    const r = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.approval_requests (
          id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
          current_payload, expires_at, requested_by, status, created_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`draft-${Math.random().toString(36).slice(2, 8)}`},
          ${threadId}, ${threadId}, ${toolName},
          ${JSON.stringify({ ticketId })}::jsonb, '{}'::jsonb,
          now() + interval '1 hour', ${userId}, 'pending', now()
        )
        RETURNING id
      `),
    )
    return r[0]!.id
  })
}

async function statusOf(approvalId: string): Promise<string> {
  const r = await withPrivilegedDb(orgId, "reply-supersedes-status", (tx) =>
    tx.execute(drizzleSql`SELECT status FROM kernel.approval_requests WHERE id = ${approvalId}`),
  )
  return extractRows<{ status: string }>(r)[0]!.status
}

describe("ticketsReply — a sent manual reply supersedes a stale pending draft", () => {
  it("cancels the OTHER pending drafted reply on the same ticket once a reply actually sends", async () => {
    const ticketId = await createTicketWithInbound()
    const staleDraftId = await insertPendingDraftApproval(ticketId)
    expect(await statusOf(staleDraftId)).toBe("pending")

    const result = await asOrgMember(orgId, userId, async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "Here is my own answer." }, ctx)
    })
    expect("ok" in result && result.ok).toBe(true)

    // Falsifiable: without the fix, cancelApprovalsForSourceTicket is never
    // called and this stays "pending" forever — the ApprovalCard for the
    // stale draft would still render on the ticket.
    expect(await statusOf(staleDraftId)).toBe("cancelled")
  })

  it("leaves a pending draft on a DIFFERENT ticket untouched", async () => {
    const ticketId = await createTicketWithInbound()
    const otherTicketId = await createTicketWithInbound()
    const unrelatedDraftId = await insertPendingDraftApproval(otherTicketId)

    const result = await asOrgMember(orgId, userId, async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "Answering this one only." }, ctx)
    })
    expect("ok" in result && result.ok).toBe(true)

    expect(await statusOf(unrelatedDraftId)).toBe("pending")
  })

  // Counter-case the reviewer caught: cancelling every gated tool on the
  // ticket (not just the superseded reply draft) would silently kill a
  // still-live nudge or close decision that has nothing to do with this
  // reply. A human replying to a ticket that ALSO has a scheduled nudge, or
  // an agent-proposed close, sitting pending must not make that other
  // decision vanish out from under whoever queued it.
  it("leaves a pending nudge and a pending close on the SAME ticket untouched", async () => {
    const ticketId = await createTicketWithInbound()
    const pendingNudgeId = await insertPendingDraftApproval(ticketId, "tickets:nudge")
    const pendingCloseId = await insertPendingDraftApproval(ticketId, "tickets:close")

    const result = await asOrgMember(orgId, userId, async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "Replying, but not deciding the other two." }, ctx)
    })
    expect("ok" in result && result.ok).toBe(true)

    // FALSIFIABLE: cancelApprovalsForSourceTicket's default toolNames covers
    // reply/nudge/close together -- without the ["tickets:reply"] scoping at
    // the tools.ts call site, both of these would read "cancelled" here.
    expect(await statusOf(pendingNudgeId)).toBe("pending")
    expect(await statusOf(pendingCloseId)).toBe("pending")
  })

  // An empty toolNames list would otherwise render `tool_name IN ()`, a
  // Postgres syntax error. No caller passes one today, but the primitive
  // itself must not crash if one ever does -- "cancel nothing" is exactly
  // what an empty scope means.
  it("cancelApprovalsForSourceTicket with an empty toolNames list cancels nothing and does not throw", async () => {
    const { cancelApprovalsForSourceTicket } = await import("~/modules/approvals/cancel")
    const ticketId = await createTicketWithInbound()
    const pendingDraftId = await insertPendingDraftApproval(ticketId, "tickets:reply")

    const result = await withPrivilegedDb(orgId, "reply-supersedes-empty-toolnames", (tx) =>
      cancelApprovalsForSourceTicket(tx as never, orgId, ticketId, "test_empty_toolnames", []),
    )
    expect(result.cancelledCount).toBe(0)
    expect(await statusOf(pendingDraftId)).toBe("pending")
  })
})
