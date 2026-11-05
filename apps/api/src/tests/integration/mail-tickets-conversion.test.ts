// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for Phase 7.3 — Mail ↔ Tickets conversion (and summary).
 *
 * Covers (per spec §3 / §5):
 *  - Task 14: mail:convertToTicket happy path (creates ticket, marks mail escalated)
 *  - Task 15: tickets:convertToMail happy path (creates mail conversation, closes ticket)
 *  - Task 16: compensating cleanup (note failure rolls back ticket via deleteIfUnreferenced)
 *  - Task 19: tickets:pullMailReply (idempotent attach of stray mail reply onto ticket)
 *  - Task 20: idempotency matrix (replay returns same envelope; conflict detected)
 *  - Task 22: ensureSummary scheduling (atomic-UPDATE-gate)
 */

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { executeTool, executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

let orgId: string
let userId: string
let actor: ActorContext
let mailAccountId: string
let inboxId: string

async function seedMailAccount(ownerUserId = userId): Promise<string> {
  return await withSystemDb("p7-3-conversion-fixture", async (tx) => {
    const accountId = crypto.randomUUID()
    const connectedAccountId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id, status,
        provider_type, identifier, access_token_encrypted, refresh_token_encrypted,
        provider_account_id, metadata, created_by, created_at, updated_at
      ) VALUES (
        ${connectedAccountId}, ${orgId}, 'mail', 'imap', 'user', ${ownerUserId},
        'active', 'credentials', ${`p7-${connectedAccountId}@test.com`}, 'enc', null,
        ${`p7-${connectedAccountId}@test.com`}, '{}'::jsonb, ${ownerUserId}, now(), now()
      )
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
        sync_status, sync_state, last_sync_at, created_at, updated_at
      ) VALUES (
        ${accountId}, ${orgId}, ${connectedAccountId}, 'user', ${ownerUserId}, 'imap',
        ${`p7-${accountId}@test.com`}, 'idle', '{}'::jsonb, now(), now(), now()
      )
    `)
    return accountId
  })
}

async function seedTicketsInbox(
  accountConnectedId?: string,
  opts: { defaultTeam?: string | null; defaultSensitivity?: string | null } = {},
): Promise<string> {
  return await withSystemDb("p7-3-conversion-inbox", async (tx) => {
    const id = crypto.randomUUID()
    const connId = accountConnectedId ?? crypto.randomUUID()
    if (!accountConnectedId) {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts (
          id, org_id, app_name, connection_name, owner_type, owner_id, status,
          provider_type, identifier, access_token_encrypted, provider_account_id,
          metadata, created_by, created_at, updated_at
        ) VALUES (
          ${connId}, ${orgId}, 'tickets', 'imap', 'org', null, 'active',
          'credentials', ${`inbox-${id}@test.com`}, 'enc', ${`inbox-${id}@test.com`},
          '{}'::jsonb, ${userId}, now(), now()
        )
      `)
    }
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (
        id, org_id, connected_account_id, name, email_address,
        default_team, default_sensitivity, is_default_for_create, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${connId}, 'Inbox', ${`inbox-${id}@test.com`},
        ${opts.defaultTeam ?? null}, ${opts.defaultSensitivity ?? null}, false, now(), now()
      )
    `)
    return id
  })
}

async function seedMailConversation(opts: {
  accountId: string
  status?: string
  subject?: string
  withMessages?: number
}): Promise<{ conversationId: string; messageIds: string[] }> {
  return await withSystemDb("p7-3-mail-conv-fixture", async (tx) => {
    const conversationId = crypto.randomUUID()
    const externalThreadId = `thr-${conversationId}`
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.conversations (
        id, org_id, account_id, owner_type, owner_id, external_thread_id, subject,
        snippet, status, labels, is_read, is_starred, last_message_at, message_count,
        created_at, updated_at
      ) VALUES (
        ${conversationId}, ${orgId}, ${opts.accountId}, 'user', ${userId},
        ${externalThreadId}, ${opts.subject ?? "Help me"}, 'snippet',
        ${opts.status ?? "open"}, '[]'::jsonb, true, false, now(), 0, now(), now()
      )
    `)
    const messageIds: string[] = []
    for (let i = 0; i < (opts.withMessages ?? 1); i++) {
      const messageId = crypto.randomUUID()
      messageIds.push(messageId)
      const direction = i % 2 === 0 ? "inbound" : "outbound"
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
          subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
          sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id, created_at, updated_at
        ) VALUES (
          ${messageId}, ${orgId}, ${conversationId}, ${opts.accountId},
          ${`<m${i}-${conversationId}@test>`}, null, null, '[]'::jsonb,
          ${JSON.stringify({ email: "alice@x.com", name: "Alice" })}::jsonb,
          ${JSON.stringify([{ email: "support@us.com" }])}::jsonb,
          '[]'::jsonb, '[]'::jsonb,
          ${opts.subject ?? "Help me"}, ${`message ${i}`}, null, ${`message ${i}`},
          true, false, '[]'::jsonb, ${direction}, now(), now(), '{}'::jsonb,
          'user', ${userId}, null, now(), now()
        )
      `)
    }
    await tx.execute(drizzleSql`
      UPDATE app_mail.conversations
      SET message_count = ${opts.withMessages ?? 1}
      WHERE id = ${conversationId}
    `)
    return { conversationId, messageIds }
  })
}

beforeAll(async () => {
  const slug = `p7-3-conv-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Phase 7.3 Conversion', ${slug}) RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`p7-3-${Date.now()}@test.com`}, 'P73 Tester', 'active', 'hash', 1, 1) RETURNING id
    `),
  )
  userId = user.id
  await ensureAppsForOrg(orgId)

  // Seed tickets settings (sla targets needed by createTicket)
  const { ticketsSettingsDefaults } = await import("@liaison/shared")
  await withSystemDb("p7-3-tickets-settings", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${orgId}
    `)
  })

  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: [
      "mail:accounts:read",
      "mail:accounts:write",
      "mail:conversations:read",
      "mail:conversations:write",
      "mail:messages:read",
      "mail:messages:write",
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:messages:read",
      "tickets:messages:write",
      "tickets:inboxes:read",
    ],
    dimensionGrants: {
      "tickets:team": ["*"],
      "tickets:sensitivity": ["restricted"],
      "tickets:inbox": ["*"],
      "mail:inbox": ["*"],
      "mail:sensitivity": ["restricted"],
      team: ["*"],
      sensitivity: ["restricted"],
      inbox: ["*"],
    },
  } as ActorContext

  mailAccountId = await seedMailAccount()
  inboxId = await seedTicketsInbox()
})

async function fetchTicket(id: string): Promise<any> {
  const rows = extractRows<any>(
    await db.execute(
      drizzleSql`SELECT * FROM app_tickets.tickets WHERE id = ${id} AND org_id = ${orgId}`,
    ),
  )
  return rows[0]
}

async function fetchMailConversation(id: string): Promise<any> {
  const rows = extractRows<any>(
    await db.execute(
      drizzleSql`SELECT * FROM app_mail.conversations WHERE id = ${id} AND org_id = ${orgId}`,
    ),
  )
  return rows[0]
}

async function seedEscalatedTicketWithReply(
  opts: { direction?: "inbound" | "outbound"; sentAtOffsetMinutes?: number } = {},
): Promise<{ ticketId: string; conversationId: string; mailMessageId: string }> {
  const { conversationId } = await seedMailConversation({
    accountId: mailAccountId,
    withMessages: 1,
    subject: "Escalated reply",
  })
  const converted = await executeTool({
    toolName: "mail:convertToTicket",
    orgId,
    actor,
    params: { conversationId, inboxId },
  })
  const ticketId = (converted.data as any).ticketId
  const mailMessageId = crypto.randomUUID()
  const sentAt = new Date(Date.now() + (opts.sentAtOffsetMinutes ?? 1) * 60_000).toISOString()
  await withSystemDb("p7-3-eligible-mail-reply", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_mail.messages (
        id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
        in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
        subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
        sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id, created_at, updated_at
      ) VALUES (
        ${mailMessageId}, ${orgId}, ${conversationId}, ${mailAccountId},
        ${`<reply-${mailMessageId}@test>`}, null, null, '[]'::jsonb,
        ${JSON.stringify({ email: "alice@x.com", name: "Alice" })}::jsonb,
        ${JSON.stringify([{ email: "support@us.com" }])}::jsonb,
        '[]'::jsonb, '[]'::jsonb, 'Escalated reply', 'new reply', null, 'new reply',
        false, false, '[]'::jsonb, ${opts.direction ?? "inbound"}, ${sentAt}::timestamptz,
        now(), '{}'::jsonb, 'user', ${userId}, null, now(), now()
      )
    `)
    await tx.execute(drizzleSql`
      UPDATE app_mail.conversations
      SET message_count = message_count + 1, last_message_at = ${sentAt}::timestamptz
      WHERE id = ${conversationId} AND org_id = ${orgId}
    `)
  })
  return { ticketId, conversationId, mailMessageId }
}

async function executeInternalTool(
  toolName: string,
  callerApp: string,
  params: Record<string, unknown>,
  callActor: ActorContext = actor,
): Promise<any> {
  return await executeToolCore({
    toolName,
    orgId,
    actor: callActor,
    params,
    origin: "in-app-agent",
    internalCall: { callerApp },
    callChain: [`${callerApp}:test`],
  })
}

describe("mail:convertToTicket", () => {
  it("creates a ticket from a mail conversation and marks mail as escalated", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 2,
    })
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    expect(result.blocked).toBeUndefined()
    const data = result.data as any
    expect(data.ticketId).toBeDefined()
    expect(data.ticketHandle).toMatch(/^ticket-\d+$/)

    const ticket = await fetchTicket(data.ticketId)
    expect(ticket.status).toBe("open")
    expect(ticket.channel).toBe("mail_escalation")
    expect(ticket.source_conversation_id).toBe(conversationId)
    expect(ticket.first_response_at).toBeDefined()
    expect(ticket.sla_active_started_at).toBeNull()
    expect(ticket.sla_paused_at).toBeNull()
    expect(ticket.sla_breached_at).toBeNull()

    const conv = await fetchMailConversation(conversationId)
    expect(conv.status).toBe("escalated")
    expect(conv.escalated_ticket_id).toBe(data.ticketId)

    const copiedMessages = extractRows<any>(
      await db.execute(drizzleSql`
        SELECT kind, external_message_id, in_reply_to, header_references, text_body, sent_at
        FROM app_tickets.messages
        WHERE ticket_id = ${data.ticketId} AND org_id = ${orgId}
        ORDER BY external_message_id
      `),
    )
    expect(copiedMessages.map((m) => m.kind)).toEqual(["inbound", "outbound"])
    expect(copiedMessages.map((m) => m.external_message_id)).toEqual([
      `<m0-${conversationId}@test>`,
      `<m1-${conversationId}@test>`,
    ])
    expect(copiedMessages[0].header_references).toEqual([])
    expect(copiedMessages[1].text_body).toBe("message 1")

    const events = extractRows<{ payload: any }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId}
          AND (
            payload->>'entityId' = ${data.ticketId}
            OR payload->>'entityId' = ${conversationId}
            OR payload->'data'->>'ticketId' = ${data.ticketId}
          )
      `),
    ).map((row) => row.payload)
    expect(events).toContainEqual(
      expect.objectContaining({ app: "tickets", entity: "ticket", action: "create" }),
    )
    expect(
      events.filter((e) => e.app === "tickets" && e.entity === "message" && e.action === "create"),
    ).toHaveLength(2)
    expect(events).toContainEqual(
      expect.objectContaining({ app: "mail", entity: "conversation", action: "converted" }),
    )
  })

  it("is idempotent — second call with same conversation returns existing ticket", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })
    const r1 = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    const r2 = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    expect((r2.data as any).ticketId).toBe((r1.data as any).ticketId)
    expect((r2.data as any).idempotent).toBe(true)
  })

  it("defaults created ticket team and sensitivity from the target inbox", async () => {
    const routedInboxId = await seedTicketsInbox(undefined, {
      defaultTeam: "support-emea",
      defaultSensitivity: "confidential",
    })
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })

    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId: routedInboxId },
    })
    const ticket = await fetchTicket((result.data as any).ticketId)

    expect(ticket.team).toBe("support-emea")
    expect(ticket.sensitivity).toBe("confidential")
  })
})

describe("BL-73 — convertToTicket carries the conversation's contact + supports a note", () => {
  async function seedContact(email: string, name: string): Promise<string> {
    return await withSystemDb("bl73-contact", async (tx) => {
      const id = crypto.randomUUID()
      const handle = `@contact-bl73-${id.slice(0, 8)}`
      await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
        VALUES (${id}, ${orgId}, ${handle}, ${name}, ${email}, ${userId}, now(), now())
      `)
      return id
    })
  }

  async function seedConvWithContact(opts: {
    contactId: string
    fromEmail: string
    fromName: string
  }): Promise<string> {
    return await withSystemDb("bl73-conv", async (tx) => {
      const conversationId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.conversations (
          id, org_id, account_id, owner_type, owner_id, contact_id, external_thread_id, subject,
          snippet, status, labels, is_read, is_starred, last_message_at, message_count, created_at, updated_at
        ) VALUES (
          ${conversationId}, ${orgId}, ${mailAccountId}, 'user', ${userId}, ${opts.contactId},
          ${`thr-bl73-${conversationId}`}, 'VIP dead touch zone', 'snippet', 'open',
          '[]'::jsonb, true, false, now(), 1, now(), now()
        )
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
          subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
          sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}, ${orgId}, ${conversationId}, ${mailAccountId},
          ${`<bl73-${conversationId}@test>`}, null, null, '[]'::jsonb,
          ${JSON.stringify({ email: opts.fromEmail, name: opts.fromName })}::jsonb,
          ${JSON.stringify([{ email: "support@us.com" }])}::jsonb,
          '[]'::jsonb, '[]'::jsonb, 'VIP dead touch zone', 'urgent help', null, 'urgent help',
          true, false, '[]'::jsonb, 'inbound', now(), now(), '{}'::jsonb,
          'user', ${userId}, null, now(), now()
        )
      `)
      return conversationId
    })
  }

  it("links the new ticket to the conversation's contact and adds the note (no idempotencyKey rejection)", async () => {
    const email = `bl73-${crypto.randomUUID()}@x.com`
    const contactId = await seedContact(email, "Claudine Moreau")
    const conversationId = await seedConvWithContact({
      contactId,
      fromEmail: email,
      fromName: "Claudine Moreau",
    })

    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: {
        conversationId,
        inboxId,
        priority: "high",
        note: "VIP — promoted from personal mailbox; recording session this week",
      },
    })
    expect(result.blocked).toBeUndefined()
    expect((result.data as any)?.error).toBeUndefined()
    const ticketId = (result.data as any).ticketId
    expect(ticketId).toBeDefined()

    // (a) the ticket inherits the conversation's authoritative contact link
    const ticket = await fetchTicket(ticketId)
    expect(ticket.contact_id).toBe(contactId)

    // (b) the internal addNote no longer trips on idempotencyKey — the note landed
    const notes = extractRows<{ kind: string; text_body: string }>(
      await db.execute(drizzleSql`
        SELECT kind, text_body FROM app_tickets.messages
        WHERE ticket_id = ${ticketId} AND org_id = ${orgId} AND kind = 'note'
      `),
    )
    expect(notes.length).toBe(1)
    expect(notes[0].text_body).toContain("VIP")

    // (c) the convert RETURN confirms the note was recorded in the same call, so the
    // agent (and the chaos judge) can verify the hand-off note took effect WITHOUT a
    // separate tickets:addNote toolEvent (the nested addNote never surfaces). This is the
    // BL-246 observability fix — a one-call note was previously invisible to the judge.
    expect((result.data as any).noteAdded).toBe(true)
  })

  it("returns noteAdded:false when no note is passed (the convert is note-less)", async () => {
    const email = `bl246-nonote-${crypto.randomUUID()}@x.com`
    const contactId = await seedContact(email, "Nora NoNote")
    const conversationId = await seedConvWithContact({
      contactId,
      fromEmail: email,
      fromName: "Nora NoNote",
    })
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId, priority: "high" },
    })
    expect(result.blocked).toBeUndefined()
    expect((result.data as any)?.error).toBeUndefined()
    const ticketId = (result.data as any).ticketId
    expect(ticketId).toBeDefined()
    // no note arg → no note row, and the return says so (so a chat claim of "I added a
    // note" with noteAdded:false is unambiguously a fabrication to the judge)
    expect((result.data as any).noteAdded).toBe(false)
    const notes = extractRows<{ kind: string }>(
      await db.execute(drizzleSql`
        SELECT kind FROM app_tickets.messages
        WHERE ticket_id = ${ticketId} AND org_id = ${orgId} AND kind = 'note'
      `),
    )
    expect(notes.length).toBe(0)
  })

  it("links the sender's organisation contact when one exists, and never creates one", async () => {
    // Adding someone to the organisation's contacts is an explicit share
    // (modules/sharing): converting a conversation to a ticket links the
    // sender's organisation contact if there is one, and otherwise keeps the
    // address on the copied inbound message only.
    const convertFrom = async (email: string) => {
      const { conversationId } = await seedMailConversation({
        accountId: mailAccountId,
        withMessages: 1,
      })
      await withSystemDb("bl73-rewrite-sender", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE app_mail.messages
          SET from_address = ${JSON.stringify({ email, name: "Nora New" })}::jsonb
          WHERE conversation_id = ${conversationId} AND org_id = ${orgId} AND direction = 'inbound'
        `)
      })
      const result = await executeTool({
        toolName: "mail:convertToTicket",
        orgId,
        actor,
        params: { conversationId, inboxId },
      })
      return fetchTicket((result.data as any).ticketId)
    }
    const contactsWith = async (email: string) =>
      extractRows<{ id: string }>(
        await db.execute(
          drizzleSql`SELECT id FROM kernel.contacts WHERE org_id = ${orgId} AND lower(email) = ${email}`,
        ),
      )

    const stranger = `bl73-nolink-${crypto.randomUUID()}@x.com`
    const unlinked = await convertFrom(stranger)
    expect(unlinked.contact_id).toBeNull()
    expect(await contactsWith(stranger)).toEqual([])
    const copied = extractRows<{ from_email: string | null }>(
      await db.execute(drizzleSql`
        SELECT from_email FROM app_tickets.messages
         WHERE ticket_id = ${unlinked.id} AND org_id = ${orgId} AND kind = 'inbound'`),
    )
    expect(copied.map((m) => m.from_email)).toContain(stranger)

    const customer = `bl73-known-${crypto.randomUUID()}@x.com`
    const [known] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.contacts (org_id, handle, email, name)
        VALUES (${orgId}, ${`@bl73-${crypto.randomUUID().slice(0, 8)}`}, ${customer}, 'Known')
        RETURNING id`),
    )
    const linked = await convertFrom(customer)
    expect(linked.contact_id).toBe(known.id)
  })

  it("carries the sender from_email onto the copied ticket message so a later reply has a customer recipient", async () => {
    // Repro for the sofia-promote chaos failure: convertToTicket created the ticket + linked the
    // contact, but the gated tickets:reply preflight (loadPriorMessages → find m.from.email) failed
    // with "ticket has no customer recipient". The preflight reads the ticket MESSAGE's from_email,
    // NOT the linked contact — so the copied inbound message MUST carry from_email.
    const email = `reply-recipient-${crypto.randomUUID()}@x.com`
    // Seed EXACTLY as the chaos editorHandshakeMailSlice does: an ORG-owned conversation with TWO
    // inbound messages, from_address jsonb carrying the sender email, and the same column set the
    // fixture uses (no owner_type/owner_id/synced_at on the message rows).
    const conversationId = await withSystemDb("reply-recipient-orgconv", async (tx) => {
      const c = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_mail.conversations
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, from_email,
             status, labels, is_read, is_starred, last_message_at, message_count, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}, ${mailAccountId}, 'org', NULL, ${`thr-${crypto.randomUUID()}`},
             'Editor handshake repro', 'snippet', ${email},
             'open', '["Inbox"]'::jsonb, false, false, now(), 2, now(), now())
          RETURNING id
        `),
      )[0]!.id
      let seq = 0
      for (const hoursAgo of [48, 3]) {
        await tx.execute(drizzleSql`
          INSERT INTO app_mail.messages
            (id, org_id, conversation_id, account_id, external_message_id, message_references,
             from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body,
             snippet, is_read, is_starred, labels, direction, sent_at, created_at)
          VALUES (gen_random_uuid(), ${orgId}, ${c}, ${mailAccountId}, ${`repro-msg-${seq}-${c}`}, '[]'::jsonb,
             ${JSON.stringify({ name: "Reply Customer", email })}::jsonb,
             ${JSON.stringify([{ name: "Support", email: "support@us.com" }])}::jsonb, '[]'::jsonb, '[]'::jsonb,
             'Editor handshake repro', ${"body"}, NULL,
             'snippet', false, false, '["Inbox"]'::jsonb, 'inbound',
             now() - (${hoursAgo} * interval '1 hour'), now() - (${hoursAgo} * interval '1 hour'))
        `)
        seq++
      }
      return c
    })
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    const ticketId = (result.data as any).ticketId as string
    const msgs = extractRows<{ kind: string; from_email: string | null }>(
      await db.execute(drizzleSql`
        SELECT kind, from_email FROM app_tickets.messages
        WHERE ticket_id = ${ticketId} AND org_id = ${orgId}
      `),
    )
    const inbound = msgs.find((m) => m.kind === "inbound")
    expect(inbound).toBeDefined()
    // The exact precondition the reply send-preflight checks (tools.ts loadPriorMessages):
    expect(inbound?.from_email).toBe(email)
  })
})

describe("BL-83 — setFollowup is self-verifying (echoes followupAt + reason)", () => {
  it("returns the applied followupAt and followupReason so the result is verifiable without a re-read", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Schedule a follow-up", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    const at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const reason = "confirm v2.5-beta dead-zone fix"
    const r = await executeTool({
      toolName: "tickets:setFollowup",
      orgId,
      actor,
      params: { ticketId, at, reason },
    })
    expect(r.blocked).toBeUndefined()
    expect((r.data as any).status).toBe("awaiting_followup")
    expect((r.data as any).followupAt).toBe(at)
    expect((r.data as any).followupReason).toBe(reason)
    const ticket = await fetchTicket(ticketId)
    expect(ticket.status).toBe("awaiting_followup")
    expect(ticket.followup_reason).toBe(reason)
  })
})

describe("BL-76 — self-assignment via the 'me' sentinel", () => {
  it("convertToTicket with assigneeId 'me' assigns the ticket to the acting user", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId, priority: "high", assigneeId: "me" },
    })
    expect(result.blocked).toBeUndefined()
    // BL-78: the convert result is self-verifying — it echoes the applied
    // priority + resolved assignee + escalation so a judge (or caller) can
    // confirm the atomic convert without a separate ticket-detail read.
    expect((result.data as any).priority).toBe("high")
    expect((result.data as any).assignedTo).toBe(userId)
    expect((result.data as any).escalated).toBe(true)
    const ticket = await fetchTicket((result.data as any).ticketId)
    expect(ticket.assigned_to).toBe(userId)
  })

  it("tickets:create with assignedTo 'me' assigns to the acting user", async () => {
    const result = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Self-assigned via me", channel: "manual", assignedTo: "me" },
    })
    const ticket = await fetchTicket((result.data as any).ticketId)
    expect(ticket.assigned_to).toBe(userId)
  })

  it("tickets:assign with 'me' resolves to the acting user and returns the resolved id", async () => {
    const created = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Assign me later", channel: "manual" },
    })
    const ticketId = (created.data as any).ticketId
    const assigned = await executeTool({
      toolName: "tickets:assign",
      orgId,
      actor,
      params: { ticketId, assignedTo: "me" },
    })
    expect((assigned.data as any).assignedTo).toBe(userId)
    const ticket = await fetchTicket(ticketId)
    expect(ticket.assigned_to).toBe(userId)
  })
})

describe("tickets:convertToMail", () => {
  it("converts a ticket back to a mail conversation and closes it as converted_to_mail", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Convert me back",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "hello", fromEmail: "alice@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId

    const result = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: mailAccountId },
    })
    expect(result.blocked).toBeUndefined()
    const mailConvId = (result.data as any).mailConversationId
    expect(mailConvId).toBeDefined()

    const ticket = await fetchTicket(ticketId)
    expect(ticket.status).toBe("closed")
    expect(ticket.closed_reason).toBe("converted_to_mail")
    expect(ticket.converted_to_mail_conversation_id).toBe(mailConvId)

    const mailMessages = extractRows<any>(
      await db.execute(drizzleSql`
        SELECT direction, text_body, external_message_id, message_references
        FROM app_mail.messages
        WHERE conversation_id = ${mailConvId} AND org_id = ${orgId}
      `),
    )
    expect(mailMessages).toHaveLength(1)
    expect(mailMessages[0].direction).toBe("inbound")
    expect(mailMessages[0].text_body).toBe("hello")

    const events = extractRows<{ payload: any }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId}
          AND (
            payload->>'entityId' = ${ticketId}
            OR payload->>'entityId' = ${mailConvId}
            OR payload->'data'->>'conversationId' = ${mailConvId}
          )
      `),
    ).map((row) => row.payload)
    expect(events).toContainEqual(
      expect.objectContaining({ app: "tickets", entity: "ticket", action: "update" }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ app: "tickets", entity: "ticket", action: "converted" }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ app: "mail", entity: "conversation", action: "create" }),
    )
    expect(
      events.filter((e) => e.app === "mail" && e.entity === "message" && e.action === "create"),
    ).toHaveLength(1)
  })

  it("rejects converting into another user's Mail account", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Do not convert cross-user",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "hello", fromEmail: "alice@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    const [otherUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`p7-3-other-${crypto.randomUUID()}@test.com`}, 'Other User', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const otherAccountId = await seedMailAccount(otherUser.id)

    await expect(
      executeTool({
        toolName: "tickets:convertToMail",
        orgId,
        actor,
        params: { ticketId, accountId: otherAccountId },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("BL-79 — convertToMail can target an org-owned (shared) mailbox", () => {
  async function seedOrgMailAccount(): Promise<string> {
    return await withSystemDb("bl79-org-account", async (tx) => {
      const accountId = crypto.randomUUID()
      const connectedAccountId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts (
          id, org_id, app_name, connection_name, owner_type, owner_id, status,
          provider_type, identifier, access_token_encrypted, provider_account_id,
          metadata, created_by, created_at, updated_at
        ) VALUES (
          ${connectedAccountId}, ${orgId}, 'mail', 'imap', 'org', null, 'active',
          'credentials', ${`org-shared-${accountId}@test.com`}, 'enc',
          ${`org-shared-${accountId}@test.com`}, '{}'::jsonb, ${userId}, now(), now()
        )
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts (
          id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
          sync_status, sync_state, last_sync_at, created_at, updated_at
        ) VALUES (
          ${accountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'imap',
          ${`org-shared-${accountId}@test.com`}, 'idle', '{}'::jsonb, now(), now(), now()
        )
      `)
      return accountId
    })
  }

  it("de-escalates a ticket into a shared org mailbox (not just the actor's personal one)", async () => {
    const orgAccountId = await seedOrgMailAccount()
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Misrouted — route to sales",
        channel: "manual",
        initialMessage: {
          kind: "inbound",
          textBody: "wholesale pricing?",
          fromEmail: "dealer@x.com",
        },
      },
    })
    const ticketId = (create.data as any).ticketId
    const result = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: orgAccountId },
    })
    expect(result.blocked).toBeUndefined()
    expect((result.data as any)?.error).toBeUndefined()
    const mailConvId = (result.data as any).mailConversationId
    expect(mailConvId).toBeDefined()
    const conv = await fetchMailConversation(mailConvId)
    expect(conv.owner_type).toBe("org")
    const ticket = await fetchTicket(ticketId)
    expect(ticket.status).toBe("closed")
    expect(ticket.closed_reason).toBe("converted_to_mail")
  })
})

describe("pullMailReply", () => {
  it("keeps the internal helper unavailable to direct user tool execution", async () => {
    await expect(
      executeTool({
        toolName: "tickets:pullMailReply",
        orgId,
        actor,
        params: { ticketId: crypto.randomUUID(), mailMessageId: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it("attaches an eligible linked mail reply onto a ticket as kind=inbound", async () => {
    const { ticketId, mailMessageId } = await seedEscalatedTicketWithReply()

    const r1 = await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId },
    })
    expect(r1.blocked).toBeUndefined()

    // Replay should be idempotent
    const r2 = await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId },
    })
    expect(r2.blocked).toBeUndefined()
    expect((r2.data as any).messageId).toBe((r1.data as any).messageId)
    expect((r2.data as any).idempotent).toBe(true)
  })

  it("dedupes a null external-id mail reply by source mail message id", async () => {
    const { ticketId, mailMessageId } = await seedEscalatedTicketWithReply()
    await withSystemDb("p7-3-null-mail-message-id", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_mail.messages
        SET external_message_id = null
        WHERE id = ${mailMessageId} AND org_id = ${orgId}
      `)
    })

    const r1 = await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId },
    })
    const r2 = await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId },
    })

    expect((r2.data as any).messageId).toBe((r1.data as any).messageId)
    expect((r2.data as any).idempotent).toBe(true)
    const rows = extractRows<{ count: string }>(
      await db.execute(drizzleSql`
        SELECT count(*)::text AS count
        FROM app_tickets.messages
        WHERE ticket_id = ${ticketId} AND org_id = ${orgId}
          AND header_references @> ${JSON.stringify([`liaison:source-mail-message:${mailMessageId}`])}::jsonb
      `),
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  it("rejects unrelated mail messages outside the escalated conversation", async () => {
    const { ticketId } = await seedEscalatedTicketWithReply()
    const { messageIds } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
      subject: "Unrelated reply",
    })

    await expect(
      executeTool({
        toolName: "tickets:pullMailReplyFromBanner",
        orgId,
        actor,
        params: { ticketId, mailMessageId: messageIds[0] },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it("rejects outbound or pre-escalation messages from the linked conversation", async () => {
    const outbound = await seedEscalatedTicketWithReply({ direction: "outbound" })
    await expect(
      executeTool({
        toolName: "tickets:pullMailReplyFromBanner",
        orgId,
        actor,
        params: { ticketId: outbound.ticketId, mailMessageId: outbound.mailMessageId },
      }),
    ).rejects.toMatchObject({ status: 404 })

    const old = await seedEscalatedTicketWithReply({ sentAtOffsetMinutes: -10 })
    await expect(
      executeTool({
        toolName: "tickets:pullMailReplyFromBanner",
        orgId,
        actor,
        params: { ticketId: old.ticketId, mailMessageId: old.mailMessageId },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("mail:appendInboundMessage idempotency", () => {
  it("dedupes omitted-key appends with null externalMessageId using the default body hash key", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 0,
      subject: "Rerouted null id",
    })
    const message = {
      externalMessageId: null,
      fromEmail: "customer@example.com",
      toEmails: ["support@example.com"],
      ccEmails: [],
      subject: "Rerouted null id",
      textBody: "same body without an external id",
      sentAt: "2026-05-01T10:00:00.000Z",
    }

    const first = await executeInternalTool("mail:appendInboundMessage", "tickets", {
      conversationId,
      message,
    })
    const second = await executeInternalTool("mail:appendInboundMessage", "tickets", {
      conversationId,
      message,
    })

    expect((first.data as any)?.messageId).toBe((second.data as any)?.messageId)
    expect((second.data as any)?.idempotent).toBe(true)
    const rows = extractRows<{ count: string }>(
      await db.execute(drizzleSql`
        SELECT count(*)::text AS count
        FROM app_mail.messages
        WHERE conversation_id = ${conversationId} AND org_id = ${orgId}
      `),
    )
    expect(Number(rows[0].count)).toBe(1)
  })
})

describe("idempotency matrix", () => {
  it("convertToTicket replay with same idempotency key returns identical envelope", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })
    const idempotencyKey = `mail:convert:${conversationId}`
    const r1 = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId, idempotencyKey },
    })
    const r2 = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId, idempotencyKey },
    })
    expect((r1.data as any).ticketId).toBe((r2.data as any).ticketId)
  })
})

describe("compensating cleanup", () => {
  it("deleteIfUnreferenced removes a ticket with no mail/approval references", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Cleanup target", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    const before = await fetchTicket(ticketId)
    expect(before).toBeDefined()

    // Internal tool — call via system actor (mirrors compensating cleanup
    // path inside mail:convertToTicket / tickets:convertToMail handlers).
    const systemActor: ActorContext = {
      actorType: "system",
      orgId,
      purpose: "job",
      scopes: [
        "tickets:tickets:write",
        "tickets:tickets:read",
        "mail:conversations:read",
        "mail:conversations:write",
      ],
    } as any
    const r = await executeInternalTool(
      "tickets:deleteIfUnreferenced",
      "mail",
      { ticketId },
      systemActor,
    )
    expect(r.blocked).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect((r.data as any).deleted).toBe(true)

    const after = await fetchTicket(ticketId)
    expect(after).toBeUndefined()
  })

  it("deleteIfUnreferenced is idempotent — second call on missing ticket returns deleted: false", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Cleanup idempotent", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    const systemActor: ActorContext = {
      actorType: "system",
      orgId,
      purpose: "job",
      scopes: [
        "tickets:tickets:write",
        "tickets:tickets:read",
        "mail:conversations:read",
        "mail:conversations:write",
      ],
    } as any
    await executeInternalTool("tickets:deleteIfUnreferenced", "mail", { ticketId }, systemActor)
    const second = await executeInternalTool(
      "tickets:deleteIfUnreferenced",
      "mail",
      { ticketId },
      systemActor,
    )
    expect(second.error?.code).toBe("not_found")
  })

  it("deleteIfUnreferenced refuses when ticket has child messages from a converted mail conversation", async () => {
    // Conversion path created the ticket — it has messages; cleanup should NOT delete it
    // unless the caller knows there's nothing referencing it. The bridge guards via
    // SELECT FOR UPDATE + reference checks; without external references and with only
    // child messages, the bridge does delete (per spec §5.6). This test pins that contract:
    // ensures the deletion cascades messages (FK ON DELETE CASCADE).
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 2,
    })
    const r = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    const ticketId = (r.data as any).ticketId
    expect(ticketId).toBeDefined()

    // Mail conversation now references the ticket via escalated_ticket_id;
    // deleteIfUnreferenced must refuse.
    const systemActor: ActorContext = {
      actorType: "system",
      orgId,
      purpose: "job",
      scopes: [
        "tickets:tickets:write",
        "tickets:tickets:read",
        "mail:conversations:read",
        "mail:conversations:write",
      ],
    } as any
    // executeTool throws on tool errors; still_referenced maps to status 500 (default)
    let cleanupErr: any
    let cleanupRes: any
    try {
      cleanupRes = await executeInternalTool(
        "tickets:deleteIfUnreferenced",
        "mail",
        { ticketId },
        systemActor,
      )
    } catch (e) {
      cleanupErr = e
    }
    // Either we caught an error (still_referenced) OR we got a result without deleted: true
    if (cleanupErr) {
      expect(cleanupErr.message.toLowerCase()).toContain("still")
    } else if (cleanupRes.error) {
      expect(cleanupRes.error.code).toBe("still_referenced")
    } else {
      expect((cleanupRes?.data as any)?.deleted).not.toBe(true)
    }
    const after = await fetchTicket(ticketId)
    expect(after).toBeDefined()
  })

  it("deleteIfUnreferenced refuses when an approval request references the ticket", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Approval referenced cleanup", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    await withSystemDb("p7-3-approval-ref", async (tx) => {
      const threadId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, type, created_by, created_at, updated_at)
        VALUES (${threadId}, ${orgId}, ${`approval-${threadId}`}, 'approval', ${userId}, now(), now())
      `)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.approval_requests (
          id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
          current_payload, expires_at, notify_user_ids, requested_by, status, reason, created_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`request-${threadId}`}, ${threadId}, ${threadId},
          'tickets:close', ${JSON.stringify({ ticketId })}::jsonb,
          ${JSON.stringify({ target: { app: "tickets", entity: "ticket", id: ticketId } })}::jsonb,
          now() + interval '1 day', ARRAY[${userId}]::uuid[], ${userId}, 'pending', 'gated', now()
        )
      `)
    })
    const systemActor: ActorContext = {
      actorType: "system",
      orgId,
      purpose: "job",
      scopes: ["tickets:tickets:write", "tickets:tickets:read"],
    } as any

    const result = await executeInternalTool(
      "tickets:deleteIfUnreferenced",
      "mail",
      { ticketId },
      systemActor,
    )

    expect(result.error?.code).toBe("still_referenced")
    expect(await fetchTicket(ticketId)).toBeDefined()
  })

  it("deleteIfUnreferenced invalidates the createFromMail idempotency cache for retry", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 0,
      subject: "Cleanup retry source",
    })
    const idempotencyKey = `mail:convert:${conversationId}:cleanup-retry`
    const params = {
      idempotencyKey,
      sourceConversationId: conversationId,
      sourceInboxId: inboxId,
      subject: "Cleanup retry source",
      messages: [],
    }
    const first = await executeInternalTool("tickets:createFromMail", "mail", params)
    const firstTicketId = (first.data as any).ticketId
    expect(firstTicketId).toBeDefined()

    const cleanup = await executeInternalTool("tickets:deleteIfUnreferenced", "mail", {
      ticketId: firstTicketId,
      idempotencyKey,
    })
    expect((cleanup.data as any).deleted).toBe(true)

    const second = await executeInternalTool("tickets:createFromMail", "mail", params)
    const secondTicketId = (second.data as any).ticketId
    expect(secondTicketId).toBeDefined()
    expect(secondTicketId).not.toBe(firstTicketId)
    expect(await fetchTicket(firstTicketId)).toBeUndefined()
    expect(await fetchTicket(secondTicketId)).toBeDefined()
  })
})

describe("inbound reroute dispatch", () => {
  it("matcher returns 'rerouted' for a converted ticket and dispatches to mail", async () => {
    // 1) Convert a ticket to mail to set converted_to_mail_conversation_id
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Reroute me",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "first", fromEmail: "alice@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    const conv = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: mailAccountId },
    })
    const mailConvId = (conv.data as any).mailConversationId
    expect(mailConvId).toBeDefined()

    // 2) Verify the ticket carries converted_to_mail_conversation_id
    const ticket = await fetchTicket(ticketId)
    expect(ticket.converted_to_mail_conversation_id).toBe(mailConvId)
    expect(ticket.closed_reason).toBe("converted_to_mail")
    const replyToken = (ticket.reply_token as string).toLowerCase()
    await withSystemDb("p7-3-reroute-bridge-token", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets SET reply_token = ${replyToken}
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
    })

    const beforeRows = extractRows<{ count: string }>(
      await db.execute(drizzleSql`
        SELECT count(*)::text AS count FROM app_mail.messages
        WHERE conversation_id = ${mailConvId} AND org_id = ${orgId}
      `),
    )
    const result = await withSystemDb("p7-3-reroute-bridge", async (tx) => {
      const bridge = createRpcBridge(
        "tickets",
        userId,
        orgId,
        tx as any,
        ticketsAppManifest as any,
        actor.scopes,
        "user",
        undefined,
        { actor, callChain: [] },
      )
      return JSON.parse(
        await bridge.tickets_processInboundMessage(
          JSON.stringify({
            messageId: `<reroute-bridge-${ticketId}@x>`,
            inReplyTo: null,
            references: [],
            from: { email: "alice@x.com", name: "Alice" },
            to: [{ email: `support+tkt_${replyToken}@us.com` }],
            cc: [],
            subject: `Re: ${ticket.subject}`,
            textBody: "bridge follow-up",
            htmlBody: null,
            sentAt: new Date().toISOString(),
            headers: {},
          }),
          JSON.stringify({
            id: inboxId,
            connectedAccountId: "00000000-0000-0000-0000-000000000000",
            emailAddress: `inbox-${inboxId}@test.com`,
            defaultTeam: null,
            defaultSensitivity: null,
          }),
        ),
      )
    })

    expect(result.outcome).toBe("rerouted")
    expect(result.conversationId).toBe(mailConvId)
    const afterRows = extractRows<{ count: string }>(
      await db.execute(drizzleSql`
        SELECT count(*)::text AS count FROM app_mail.messages
        WHERE conversation_id = ${mailConvId} AND org_id = ${orgId}
      `),
    )
    expect(Number(afterRows[0].count)).toBe(Number(beforeRows[0].count) + 1)
    expect((await fetchTicket(ticketId)).status).toBe("closed")
  })
})

describe("ensureSummary", () => {
  it("returns idle on freshly-created ticket with zero messages", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Summary idle", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    const r = await executeTool({
      toolName: "tickets:ensureSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect(r.blocked).toBeUndefined()
    const data = r.data as any
    expect(["idle", "generating"]).toContain(data.summaryStatus)
  })

  it("transitions to generating on stale ticket with messages", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Summary stale",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "first", fromEmail: "a@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    const r = await executeTool({
      toolName: "tickets:ensureSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect(r.blocked).toBeUndefined()
    const data = r.data as any
    expect(["generating", "idle"]).toContain(data.summaryStatus)
    expect(typeof data.isStale).toBe("boolean")

    // ensureSummary called concurrently must not double-enqueue: second call should
    // observe summaryStatus already 'generating' (atomic UPDATE gate per spec §10A.5).
    const second = await executeTool({
      toolName: "tickets:ensureSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect(second.blocked).toBeUndefined()
    const sd = second.data as any
    if (data.summaryStatus === "generating") {
      expect(sd.summaryStatus).toBe("generating")
    }
  })

  it("concurrent ensureSummary calls enqueue exactly one summarize job and no-op when current", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Summary concurrent exact",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "first", fromEmail: "a@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    await Promise.all([
      executeTool({ toolName: "tickets:ensureSummary", orgId, actor, params: { ticketId } }),
      executeTool({ toolName: "tickets:ensureSummary", orgId, actor, params: { ticketId } }),
    ])
    // The logical id is a BullMQ deduplication id since the queue-class work
    // (jobs.ts): look the job up the way the app does, not by the old encoded
    // job id, which a deduplicated job no longer carries.
    const job = await JobsTestAccess.findJob(
      "tickets",
      "tickets-summarize",
      `tickets-summarize:${ticketId}`,
    )
    expect(job?.name).toBe("tickets-summarize")

    await withSystemDb("p7-3-summary-current", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets
        SET summary_status = 'idle', summary_message_count = message_count
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
    })
    const beforeId = job?.id
    await executeTool({ toolName: "tickets:ensureSummary", orgId, actor, params: { ticketId } })
    const afterJob = await JobsTestAccess.findJob(
      "tickets",
      "tickets-summarize",
      `tickets-summarize:${ticketId}`,
    )
    expect(afterJob?.id).toBe(beforeId)
  })

  it("regenerateSummary forces transition even when summary not stale", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Summary regenerate",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "ping", fromEmail: "a@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId

    // Manually mark summary as up-to-date so ensureSummary sees it as not-stale.
    await withSystemDb("p7-3-summary-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets
        SET summary_status = 'idle', summary_message_count = message_count
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
    })

    // ensureSummary should be a no-op (idle, not stale)
    const ensure = await executeTool({
      toolName: "tickets:ensureSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect((ensure.data as any).summaryStatus).toBe("idle")

    // regenerateSummary must force generating regardless
    const regen = await executeTool({
      toolName: "tickets:regenerateSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect(regen.blocked).toBeUndefined()
    const regenData = regen.data as any
    expect(regenData.summaryStatus).toBe("generating")
  })

  it("ensureSummary on a closed ticket returns the existing summary without enqueuing", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Summary closed",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "hi", fromEmail: "a@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId

    // Close the ticket directly (skip the gated tickets:close). Spec §10A.5: ensureSummary
    // on a closed ticket must NOT trigger a new generation.
    await withSystemDb("p7-3-summary-close", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets
        SET status = 'closed', closed_reason = 'resolved', summary_status = 'idle'
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
    })

    const r = await executeTool({
      toolName: "tickets:ensureSummary",
      orgId,
      actor,
      params: { ticketId },
    })
    expect(r.blocked).toBeUndefined()
    const data = r.data as any
    // Status remains idle (no enqueue) even though message_count > summary_message_count
    expect(data.summaryStatus).toBe("idle")
  })
})

describe("extended idempotency matrix", () => {
  it("convertToMail replay with same idempotency key returns the same mail conversation", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Idem convertToMail",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "hi", fromEmail: "a@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    const idempotencyKey = `tickets:convert:${ticketId}`

    const r1 = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: mailAccountId, idempotencyKey },
    })
    const r2 = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: mailAccountId, idempotencyKey },
    })
    expect((r1.data as any).mailConversationId).toBe((r2.data as any).mailConversationId)
  })

  it("pullMailReply replay with same idempotency key is a no-op (no duplicate ticket message)", async () => {
    const { ticketId, mailMessageId } = await seedEscalatedTicketWithReply()
    const idempotencyKey = `tickets:pullMailReply:${ticketId}:${mailMessageId}`

    await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId, idempotencyKey },
    })
    await executeTool({
      toolName: "tickets:pullMailReplyFromBanner",
      orgId,
      actor,
      params: { ticketId, mailMessageId, idempotencyKey },
    })

    // Count messages on the ticket — should be exactly 1 even after replay
    const rows = extractRows<{ count: string }>(
      await db.execute(
        drizzleSql`SELECT COUNT(*)::text AS count FROM app_tickets.messages WHERE ticket_id = ${ticketId} AND org_id = ${orgId} AND header_references @> ${JSON.stringify([`liaison:source-mail-message:${mailMessageId}`])}::jsonb`,
      ),
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  it("convertToTicket with same key but different params returns idempotency_conflict", async () => {
    const { conversationId } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })
    const idempotencyKey = `mail:convert:conflict:${conversationId}`
    await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId, idempotencyKey, priority: "high" },
    })

    // Same key, different priority — must be a conflict (HTTP 409)
    await expect(
      executeTool({
        toolName: "mail:convertToTicket",
        orgId,
        actor,
        params: { conversationId, inboxId, idempotencyKey, priority: "urgent" },
      }),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("pullMailReply edge cases", () => {
  it("returns not_found when mailMessageId does not exist", async () => {
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Pull missing", channel: "manual" },
    })
    const ticketId = (create.data as any).ticketId
    const fakeMailMsgId = "00000000-0000-0000-0000-000000000099"
    await expect(
      executeTool({
        toolName: "tickets:pullMailReplyFromBanner",
        orgId,
        actor,
        params: { ticketId, mailMessageId: fakeMailMsgId },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it("returns not_found when ticketId does not exist", async () => {
    const { messageIds } = await seedMailConversation({
      accountId: mailAccountId,
      withMessages: 1,
    })
    const fakeTicketId = "00000000-0000-0000-0000-000000000088"
    await expect(
      executeTool({
        toolName: "tickets:pullMailReplyFromBanner",
        orgId,
        actor,
        params: { ticketId: fakeTicketId, mailMessageId: messageIds[0] },
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("inbound matcher reroute end-to-end", () => {
  it("processInboundMessage on a converted ticket returns outcome=rerouted", async () => {
    // Build a ticket, convert it to mail, then send an inbound email targeting
    // the ticket's reply token. The matcher must return outcome=rerouted with
    // the mail conversation id (apps/tickets/inbound.ts:174–187).
    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Reroute end-to-end",
        channel: "manual",
        initialMessage: { kind: "inbound", textBody: "first", fromEmail: "alice@x.com" },
      },
    })
    const ticketId = (create.data as any).ticketId
    const conv = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: mailAccountId },
    })
    const mailConvId = (conv.data as any).mailConversationId

    // Read reply_token directly. The matcher's `extractTokens` lowercases the
    // recipient email before regex capture, so we mirror by lowercasing the
    // ticket's reply_token here (DB stores it as base32 uppercase) — this
    // exercises the post-lookup reroute branch deterministically without
    // relying on a sync run to invoke the matcher.
    const ticketRow = await fetchTicket(ticketId)
    const replyToken = (ticketRow.reply_token as string).toLowerCase()
    await withSystemDb("p7-3-matcher-token-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets SET reply_token = ${replyToken}
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
    })
    expect(replyToken).toBeDefined()

    // Build an inbox row matching this ticket's account, then call processInboundMessage
    const { processInboundMessage } = await import("~/apps/tickets/inbound")
    const result = await withSystemDb("p7-3-matcher-reroute", async (tx) => {
      const inboxRow = {
        id: inboxId,
        connectedAccountId: "00000000-0000-0000-0000-000000000000",
        emailAddress: `inbox-${inboxId}@test.com`,
        defaultTeam: null,
        defaultSensitivity: null,
      } as any
      return processInboundMessage(
        {
          messageId: `<reroute-${ticketId}@x>`,
          inReplyTo: null,
          references: [],
          from: { email: "alice@x.com", name: "Alice" },
          to: [{ email: `support+tkt_${replyToken}@us.com` }],
          cc: [],
          subject: `Re: ${ticketRow.subject}`,
          textBody: "follow-up",
          htmlBody: null,
          sentAt: new Date().toISOString(),
          headers: {},
        } as any,
        inboxRow,
        { orgId, db: tx as any } as any,
      )
    })
    expect((result as any).outcome).toBe("rerouted")
    expect((result as any).target).toBe("mail_conversation")
    expect((result as any).conversationId).toBe(mailConvId)
  })
})

// ── Task 5.4: converting a ticket into an enrolled personal mailbox ──────────
//
// The mail copy of a converted ticket is sealed to the mailbox owner's key. The
// team keeps the ticket itself, which is where their visibility lives; what the
// mail surface holds is one person's mailbox, and it obeys the same rule as
// every other writer. What must never happen is the third option: writing it as
// plaintext into an armed table.

describe("Task 5.4: convertToMail into an end to end encrypted mailbox", () => {
  it("seals the converted mail copy and writes no plaintext", async () => {
    const { mailboxAad } = await import("@liaison/mailbox-crypto/src/aad")
    const { openField, unsealContentKey } = await import("@liaison/mailbox-crypto/src/client")

    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
    const KEY_ID = 66
    await withSystemDb("t5-4-enroll", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                ${Buffer.from("attestation")}, 'active')
        ON CONFLICT DO NOTHING`),
    )
    const sealedAccountId = await seedMailAccount(userId)
    await withSystemDb("t5-4-ready", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_mail.accounts SET encryption_state = 'ready' WHERE id = ${sealedAccountId}`,
      ),
    )

    const create = await executeTool({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Convert into a sealed mailbox",
        channel: "manual",
        initialMessage: {
          kind: "inbound",
          textBody: "the ticket body that must not land in cleartext",
          fromEmail: "alice@x.com",
        },
      },
    })
    const ticketId = (create.data as any).ticketId

    const result = await executeTool({
      toolName: "tickets:convertToMail",
      orgId,
      actor,
      params: { ticketId, accountId: sealedAccountId },
    })
    const mailConvId = (result.data as any).mailConversationId
    expect(mailConvId).toBeDefined()

    const rows = extractRows<any>(
      await db.execute(drizzleSql`
        SELECT * FROM app_mail.messages WHERE conversation_id = ${mailConvId} AND org_id = ${orgId}`),
    )
    // Non-vacuity: the conversion really produced a message row.
    expect(rows).toHaveLength(1)
    const message = rows[0]
    expect(message.subject).toBeNull()
    expect(message.text_body).toBeNull()
    expect(message.snippet).toBeNull()
    expect(message.enc_version).toBe(1)
    expect(message.text_body_ciphertext?.length ?? 0).toBeGreaterThan(0)

    const contentKey = await unsealContentKey({
      privateKey: ecdh.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
      userId,
      keyId: KEY_ID,
      wrapped: new Uint8Array(message.content_key_wrapped),
      epkSpki: new Uint8Array(message.content_key_epk),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(message.id),
      blob: new Uint8Array(message.text_body_ciphertext),
    })
    expect(new TextDecoder().decode(opened)).toBe("the ticket body that must not land in cleartext")

    const [conv] = extractRows<any>(
      await db.execute(
        drizzleSql`SELECT * FROM app_mail.conversations WHERE id = ${mailConvId} AND org_id = ${orgId}`,
      ),
    )
    expect(conv.subject).toBeNull()
    expect(conv.snippet).toBeNull()
    expect(conv.snippet_source_message_id).toBe(message.id)
  }, 60_000)
})

// ── T-INT-4, blueprint Task 9.7, spec section 5.6 ───────────────────────────
//
// `app_tickets.tickets` is TEAM VISIBLE, so converting a message out of an
// end-to-end encrypted personal mailbox is a disclosure, not a copy. It has to
// be client-fulfilled and explicitly consented, and a conversion nobody
// confirmed must create NOTHING.
describe("Task 9.7: converting an end to end encrypted conversation into a ticket", () => {
  async function seedSealedAccount(): Promise<string> {
    const sealedAccountId = await seedMailAccount(userId)
    await withSystemDb("t9-7-ready", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_mail.accounts SET encryption_state = 'ready' WHERE id = ${sealedAccountId}`,
      ),
    )
    return sealedAccountId
  }

  /** A shared ORG mailbox: Invariant P is armed per OWNER identity, so a
   *  user-owned account cannot hold cleartext once that user is enrolled, and
   *  the plaintext control has to live on an org-owned mailbox. */
  async function seedSharedAccount(): Promise<string> {
    return await withSystemDb("t9-7-org-account", async (tx) => {
      const accountId = crypto.randomUUID()
      const connectedAccountId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts (
          id, org_id, app_name, connection_name, owner_type, owner_id, status,
          provider_type, identifier, access_token_encrypted, provider_account_id,
          metadata, created_by, created_at, updated_at
        ) VALUES (
          ${connectedAccountId}, ${orgId}, 'mail', 'imap', 'org', null, 'active',
          'credentials', ${`t97-org-${accountId}@test.com`}, 'enc',
          ${`t97-org-${accountId}@test.com`}, '{}'::jsonb, ${userId}, now(), now()
        )
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts (
          id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
          sync_status, sync_state, last_sync_at, created_at, updated_at
        ) VALUES (
          ${accountId}, ${orgId}, ${connectedAccountId}, 'org', null, 'imap',
          ${`t97-org-${accountId}@test.com`}, 'idle', '{}'::jsonb, now(), now(), now()
        )
      `)
      return accountId
    })
  }

  /** A sealed conversation looks exactly like one a synced encrypted mailbox
   *  produces: every content column NULL, envelope columns intact. */
  async function seedSealedConversation(
    accountId: string,
  ): Promise<{ conversationId: string; messageIds: string[] }> {
    return await withSystemDb("t9-7-sealed-conv", async (tx) => {
      const conversationId = crypto.randomUUID()
      const messageId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.conversations (
          id, org_id, account_id, owner_type, owner_id, external_thread_id, subject,
          snippet, status, labels, is_read, is_starred, last_message_at, message_count,
          created_at, updated_at
        ) VALUES (
          ${conversationId}, ${orgId}, ${accountId}, 'user', ${userId},
          ${`thr-${conversationId}`}, null, null,
          'open', '[]'::jsonb, true, false, now(), 1, now(), now()
        )
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.messages (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
          subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
          sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id, created_at, updated_at
        ) VALUES (
          ${messageId}, ${orgId}, ${conversationId}, ${accountId},
          ${`<sealed-${messageId}@test>`}, null, null, '[]'::jsonb,
          ${JSON.stringify({ email: "alice@x.com", name: "Alice" })}::jsonb,
          ${JSON.stringify([{ email: "owner@us.com" }])}::jsonb,
          '[]'::jsonb, '[]'::jsonb,
          null, null, null, null,
          true, false, '[]'::jsonb, 'inbound', now(), now(), '{}'::jsonb,
          'user', ${userId}, null, now(), now()
        )
      `)
      return { conversationId, messageIds: [messageId] }
    })
  }

  it("converts a plaintext conversation and copies its real body (non-vacuity)", async () => {
    const plainAccountId = await seedSharedAccount()
    const { conversationId } = await seedMailConversation({
      accountId: plainAccountId,
      subject: "Plain escalation",
    })
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    const ticketId = (result.data as any).ticketId
    expect(ticketId).toBeDefined()
    const rows = extractRows<{ text_body: string | null }>(
      await db.execute(
        drizzleSql`SELECT text_body FROM app_tickets.messages WHERE ticket_id = ${ticketId} AND org_id = ${orgId}`,
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => r.text_body).join("\n")).toContain("message 0")
  }, 60_000)

  it("creates no ticket without the owner's confirmation, and names what would become visible", async () => {
    const sealedAccountId = await seedSealedAccount()
    const { conversationId, messageIds } = await seedSealedConversation(sealedAccountId)
    const before = extractRows<{ n: string }>(
      await db.execute(
        drizzleSql`SELECT count(*)::text AS n FROM app_tickets.tickets WHERE org_id = ${orgId}`,
      ),
    )[0].n

    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: { conversationId, inboxId },
    })
    const marker = (result.data as any).needsPlaintext
    expect(marker?.requestKind).toBe("mail.convert")
    expect(marker.messageIds).toEqual(messageIds)
    expect(marker.disclosure).toContain("readable by everyone")
    expect((result.data as any).ticketId).toBeUndefined()

    const after = extractRows<{ n: string }>(
      await db.execute(
        drizzleSql`SELECT count(*)::text AS n FROM app_tickets.tickets WHERE org_id = ${orgId}`,
      ),
    )[0].n
    expect(after).toBe(before)
    // The conversation is untouched: not escalated, not linked to a ticket.
    const [conv] = extractRows<{ status: string; escalated_ticket_id: string | null }>(
      await db.execute(
        drizzleSql`SELECT status, escalated_ticket_id FROM app_mail.conversations WHERE id = ${conversationId}`,
      ),
    )
    expect(conv.status).not.toBe("escalated")
    expect(conv.escalated_ticket_id).toBeNull()
  }, 60_000)

  it("refuses when the client answered without consent", async () => {
    const sealedAccountId = await seedSealedAccount()
    const { conversationId, messageIds } = await seedSealedConversation(sealedAccountId)
    // The soft-error envelope surfaces as a thrown, code-carrying error at the
    // executeTool boundary. What matters is that it is MAILBOX_LOCKED and that
    // no ticket exists afterwards.
    const thrown = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: {
        conversationId,
        inboxId,
        __mailboxConversion: {
          consented: false,
          messages: { [messageIds[0]]: { subject: "s", textBody: "b", htmlBody: null } },
        },
      },
    }).catch((err: unknown) => err as Error & { code?: string })
    expect((thrown as { code?: string }).code).toBe("MAILBOX_LOCKED")
    const [conv] = extractRows<{ escalated_ticket_id: string | null }>(
      await db.execute(
        drizzleSql`SELECT escalated_ticket_id FROM app_mail.conversations WHERE id = ${conversationId}`,
      ),
    )
    expect(conv.escalated_ticket_id).toBeNull()
  }, 60_000)

  it("converts with the client-supplied plaintext, and the ticket carries it", async () => {
    const sealedAccountId = await seedSealedAccount()
    const { conversationId, messageIds } = await seedSealedConversation(sealedAccountId)
    const result = await executeTool({
      toolName: "mail:convertToTicket",
      orgId,
      actor,
      params: {
        conversationId,
        inboxId,
        __mailboxConversion: {
          consented: true,
          messages: {
            [messageIds[0]]: {
              subject: "The decrypted subject",
              textBody: "THE DECRYPTED BODY THE OWNER AGREED TO SHARE",
              htmlBody: null,
            },
          },
        },
      },
    })
    const ticketId = (result.data as any).ticketId
    expect(ticketId).toBeDefined()
    const rows = extractRows<{ text_body: string | null; subject: string | null }>(
      await db.execute(
        drizzleSql`SELECT text_body, subject FROM app_tickets.messages WHERE ticket_id = ${ticketId} AND org_id = ${orgId}`,
      ),
    )
    expect(rows.map((r) => r.text_body).join("\n")).toContain(
      "THE DECRYPTED BODY THE OWNER AGREED TO SHARE",
    )
  }, 60_000)
})
