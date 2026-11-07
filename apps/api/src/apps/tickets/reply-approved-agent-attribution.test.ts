// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent-drafted ticket reply, approved later by a human, is authored by the
// AGENT. The approved re-entry reaches tickets:reply through the sandbox bridge
// (`tickets_admin` -> runAdminOp -> ticketsReply), and that callback runs in no
// routine frame. The bridge used to hand runAdminOp only the requester, so the
// row carried no agent, no approver and no routine, and read as written by the
// routine's owner. This drives the real bridge method inside the re-entry frame
// run-approved-handler builds, then reads the ticket back the way the UI does.
//
// `sendOutbound` is mocked (spread the REAL module and restore it in afterAll,
// same pattern as reply-events.test.ts) so no mail leaves.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"

const realSendModule = { ...realSend }

let sendCounter = 0
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async () => ({
    externalMessageId: `<approved-agent-${++sendCounter}@test>`,
    deliveryState: "delivered" as const,
    rfc2822: "",
  }),
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { createRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
const { getTicket } = await import("~/apps/tickets/search")
const { toCamelMessage } = await import("~/apps/tickets/projection")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let ownerUserId: string
let deciderUserId: string
let agentId: string
let routineId: string
let accountId: string
let inboxId: string

beforeAll(async () => {
  const slug = `approved-agent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("approved-agent-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Approved Agent Org', ${slug}) RETURNING id`),
    )[0].id
    ownerUserId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`owner-${slug}@x.test`}, 'Pat Rivera', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    deciderUserId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`decider-${slug}@x.test`}, 'Morgan Lee', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    agentId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
        VALUES (gen_random_uuid(), ${orgId}, 'role', ${`support-${slug}`}, 'Support', '["*"]'::jsonb) RETURNING id`),
    )[0].id
    routineId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.routines (id, org_id, owner_user_id, name, description, prompt, scopes, created_by_actor_type, kind, event)
        VALUES (gen_random_uuid(), ${orgId}, ${ownerUserId}, 'Support triage', 'drafts replies', 'draft a reply', '{}', 'user', 'event', 'tickets:message:create')
        RETURNING id`),
    )[0].id
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${ownerUserId}, 'enc')
        RETURNING id`),
    )[0].id
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

async function createTicketWithInbound(): Promise<string> {
  return withPrivilegedDb(orgId, "approved-agent-create", async (tx) => {
    const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
    const ticketId = extractRows<{ id: string }>(
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
    )[0]!.id
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

/** The approved re-entry exactly as run-approved-handler builds it: a frame
 *  naming the proposing agent and no routine, the requester as the bridge's
 *  user, and the approval (decider + recorded routine) as its approval context. */
async function replyAsApprovedReentry(ticketId: string, withAgent: boolean): Promise<void> {
  const approvalRequestId = crypto.randomUUID()
  await runContextStore.run(
    {
      runId: approvalRequestId,
      parentRunId: null,
      rootRunId: approvalRequestId,
      nestingDepth: 0,
      ...(withAgent ? { agentId } : {}),
    },
    () =>
      asOrgMember(orgId, ownerUserId, async (tx) => {
        const bridge = createRpcBridge(
          "tickets",
          ownerUserId,
          orgId,
          tx as never,
          { name: "tickets", schema: {}, events: {}, connections: {}, network: {} } as never,
          ["tickets:tickets:write"],
          "user",
          {
            approvalRequestId,
            approvalDeciderId: deciderUserId,
            toolName: "tickets:reply",
            originRoutineId: routineId,
          },
        )
        const out = JSON.parse(
          await bridge.tickets_admin(
            "tools.reply",
            JSON.stringify({ ticketId, textBody: "We are on it." }),
          ),
        )
        expect(out.error).toBeUndefined()
      }),
  )
}

async function outboundAsRead(ticketId: string) {
  const got = await withPrivilegedDb(orgId, "approved-agent-read", (tx) =>
    getTicket(tx as never, orgId, { ticketId }),
  )
  if ("error" in got) throw new Error(JSON.stringify(got.error))
  const row = got.messages.items.find((m) => m.kind === "outbound")
  expect(row).toBeTruthy()
  return toCamelMessage(row!)
}

describe("approved agent-drafted reply attribution (real bridge seam)", () => {
  it("is authored by the agent and names the approver, not the routine owner", async () => {
    const ticketId = await createTicketWithInbound()
    await replyAsApprovedReentry(ticketId, true)
    const m = await outboundAsRead(ticketId)
    expect(m.authorName).toBe("Support")
    expect(m.authorLabel).toBeNull()
    expect(m.approverName).toBe("Morgan Lee")
    // The audit identity is untouched: the call still executed as the owner.
    expect(m.createdBy).toBe(ownerUserId)
  })

  it("falls back to the routine label when no agent proposed it", async () => {
    const ticketId = await createTicketWithInbound()
    await replyAsApprovedReentry(ticketId, false)
    const m = await outboundAsRead(ticketId)
    expect(m.authorLabel).toBe("Routine: Support triage")
    expect(m.approverName).toBe("Morgan Lee")
  })

  it("an internal note an agent writes in a routine is authored by the agent", async () => {
    const ticketId = await createTicketWithInbound()
    const runId = crypto.randomUUID()
    await runContextStore.run(
      { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, routineId, agentId },
      () =>
        asOrgMember(orgId, ownerUserId, async (tx) => {
          const bridge = createRpcBridge(
            "tickets",
            ownerUserId,
            orgId,
            tx as never,
            { name: "tickets", schema: {}, events: {}, connections: {}, network: {} } as never,
            ["tickets:tickets:write"],
            "user",
          )
          const out = JSON.parse(
            await bridge.tickets_admin(
              "addNote",
              JSON.stringify({ ticketId, text: "Investigation notes." }),
            ),
          )
          expect(out.error).toBeUndefined()
        }),
    )
    const got = await withPrivilegedDb(orgId, "approved-agent-read", (tx) =>
      getTicket(tx as never, orgId, { ticketId }),
    )
    if ("error" in got) throw new Error(JSON.stringify(got.error))
    const note = toCamelMessage(got.messages.items.find((m) => m.kind === "note")!)
    expect(note.authorName).toBe("Support")
    expect(note.createdBy).toBe(ownerUserId)
  })
})
