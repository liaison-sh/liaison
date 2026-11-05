// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

// The `data` payload `tickets:create` returns in the API success envelope, typed at the callsite so
// each `out.data.ticketId` read is checked rather than `as any`-cast off the dispatcher's `unknown`.
interface TicketCreateData {
  ticketId: string
  ticketHandle?: string
}

let orgId: string
let otherOrgId: string
let userId: string
let otherUserId: string
let contactId: string
let otherContactId: string
let categoryId: string
let archivedCategoryId: string
let otherCategoryId: string
let ticketId: string
let actor: ActorContext

describe("tickets.reference-validation", () => {
  beforeAll(async () => {
    const slug = `tickets-ref-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await withSystemDb("tickets-reference-validation-fixture", async (tx) => {
      const orgRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug, settings)
        VALUES
          (gen_random_uuid(), 'Ticket Ref Org', ${slug}, jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)),
          (gen_random_uuid(), 'Other Ticket Ref Org', ${`${slug}-other`}, jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb))
        RETURNING id, slug
      `)
      for (const row of extractRows<{ id: string; slug: string }>(orgRows)) {
        if (row.slug === slug) orgId = row.id
        else otherOrgId = row.id
      }
      const userRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`agent-${slug}@test.com`}, 'Agent', 'active', 'hash', 1, 1)
        RETURNING id
      `)
      userId = extractRows<{ id: string }>(userRows)[0].id
      const otherUserRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${otherOrgId}, ${`other-${slug}@test.com`}, 'Other', 'active', 'hash', 1, 1)
        RETURNING id
      `)
      otherUserId = extractRows<{ id: string }>(otherUserRows)[0].id
      const contactRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, ${`contact-${slug}`}, 'Contact', ${`contact-${slug}@test.com`}, now(), now())
        RETURNING id
      `)
      contactId = extractRows<{ id: string }>(contactRows)[0].id
      const otherContactRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_at, updated_at)
        VALUES (gen_random_uuid(), ${otherOrgId}, ${`other-contact-${slug}`}, 'Other Contact', ${`other-contact-${slug}@test.com`}, now(), now())
        RETURNING id
      `)
      otherContactId = extractRows<{ id: string }>(otherContactRows)[0].id
      const categoryRows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.categories (id, org_id, name, sort_order, archived_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'Active', 0, null, now(), now())
        RETURNING id
      `)
      categoryId = extractRows<{ id: string }>(categoryRows)[0].id
      const archivedCategoryRows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.categories (id, org_id, name, sort_order, archived_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'Archived', 1, now(), now(), now())
        RETURNING id
      `)
      archivedCategoryId = extractRows<{ id: string }>(archivedCategoryRows)[0].id
      const otherCategoryRows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.categories (id, org_id, name, sort_order, archived_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${otherOrgId}, 'Other', 0, null, now(), now())
        RETURNING id
      `)
      otherCategoryId = extractRows<{ id: string }>(otherCategoryRows)[0].id
      const ticketRows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          contact_id, assigned_to, reply_token, sla_target_seconds, sla_deadline,
          sla_active_started_at, sla_elapsed_seconds, message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket-${slug}`}, 'Reference validation',
          'open', 'normal', 'manual', 'internal', ${contactId}, ${userId},
          ${`RT${slug.replace(/-/g, "").slice(0, 20)}`}, 3600, now() + interval '1 hour',
          now(), 0, 0, now(), now()
        ) RETURNING id
      `)
      ticketId = extractRows<{ id: string }>(ticketRows)[0].id
    })
    await ensureAppsForOrg(orgId, {})
    actor = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read", "tickets:tickets:write"],
      dimensionGrants: { team: ["*"], sensitivity: ["restricted"], inbox: ["*"] },
    } as ActorContext
  })

  it("tickets:create rejects a contact from another org", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad contact", channel: "manual", contactId: otherContactId },
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" })
  })

  it("tickets:create rejects an assignee from another org", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad assignee", channel: "manual", assignedTo: otherUserId },
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" })
  })

  it("tickets:create accepts same-org references", async () => {
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Good refs",
        channel: "manual",
        contactId,
        assignedTo: userId,
        categoryId,
      },
    })
    expect(out.data.ticketId).toBeTruthy()
  })

  it("tickets:create resolves a manual contactEmail into an org contact", async () => {
    const email = `manual-${Date.now()}@test.com`
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Manual email",
        channel: "manual",
        contactEmail: email,
        contactName: "Manual",
      },
    })
    expect(out.data.ticketId).toBeTruthy()
    await withSystemDb("tickets-reference-validation-contact-email-check", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT c.id FROM kernel.contacts c
        JOIN app_tickets.tickets t ON t.contact_id = c.id
        WHERE t.id = ${out.data.ticketId}::uuid AND c.org_id = ${orgId}::uuid AND c.email = ${email}
      `)) as any
      expect((rows.rows ?? rows).length).toBe(1)
    })
  })

  it("tickets:setCategory rejects cross-org and archived categories", async () => {
    await expect(
      executeTool({
        toolName: "tickets:setCategory",
        orgId,
        actor,
        params: { ticketId, categoryId: otherCategoryId },
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" })

    await expect(
      executeTool({
        toolName: "tickets:setCategory",
        orgId,
        actor,
        params: { ticketId, categoryId: archivedCategoryId },
      }),
    ).rejects.toMatchObject({ code: "archived_category" })
  })

  // BL-246: a NON-UUID categoryId (e.g. a category NAME like "Support" passed straight to
  // createTicket/createFromMail, which does NOT name-resolve like setCategory does) used to reach
  // `${categoryId}::uuid` and throw "invalid input syntax for type uuid" → an opaque HTTP 500.
  // It must now be a clean, actionable, non-2xx-free error the agent can recover from.
  it("tickets:create returns a clean invalid_category (not a 500) for a non-UUID categoryId", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad category name", channel: "manual", categoryId: "Support" },
      }),
    ).rejects.toMatchObject({ code: "invalid_category" })
  })

  // Regression (artist-relations-vip-followup-priya-thread, l475/l476 gate): a NON-UUID sourceInboxId
  // (e.g. the inbox SLUG "support" the agent guessed when calling mail:convertToTicket) reached
  // `WHERE id = 'support'` against the uuid `id` column and threw "invalid input syntax for type uuid"
  // → an opaque HTTP 500. The categoryId/contactId/assignedTo guards existed but sourceInboxId was
  // missed; it must now be a clean, actionable, non-2xx-free error the agent can recover from.
  it("tickets:create returns a clean invalid_inbox (not a 500) for a non-UUID sourceInboxId", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad inbox slug", channel: "manual", sourceInboxId: "support" },
      }),
    ).rejects.toMatchObject({ code: "invalid_inbox" })
  })

  // boxtal-tracking-exception-sweep-to-tickets gate: a NON-UUID contactId (e.g. a contact HANDLE
  // "@contact-7" or a NAME the agent passed instead of contacts_search's `id`) reached
  // `WHERE id = '<non-uuid>'::uuid` and threw "invalid input syntax for type uuid" → an opaque HTTP
  // 500. categoryId + sourceInboxId were guarded (BL-246) but contactId — the remaining unguarded
  // `::uuid` cast — was missed. It must now be a clean, actionable, non-2xx-free error.
  it("tickets:create returns a clean invalid_contact (not a 500) for a non-UUID contactId", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad contact handle", channel: "manual", contactId: "@contact-7" },
      }),
    ).rejects.toMatchObject({ code: "invalid_contact" })
  })

  // A non-UUID contactId WITH a contactEmail fallback resolves via email instead of 500ing — the
  // proactive-ticket flow (open a case per affected customer) still lands a linked ticket.
  it("tickets:create falls back to contactEmail when contactId is non-UUID", async () => {
    const email = `fallback-${Date.now()}@test.com`
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Non-uuid contactId + email fallback",
        channel: "manual",
        contactId: "@contact-bogus",
        contactEmail: email,
        contactName: "Fallback Customer",
      },
    })
    expect(out.data.ticketId).toBeTruthy()
    await withSystemDb("tickets-reference-validation-contact-fallback-check", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT c.id FROM kernel.contacts c
        JOIN app_tickets.tickets t ON t.contact_id = c.id
        WHERE t.id = ${out.data.ticketId}::uuid AND c.org_id = ${orgId}::uuid AND c.email = ${email}
      `)) as any
      expect((rows.rows ?? rows).length).toBe(1)
    })
  })

  // boxtal-tracking-exception-sweep-to-tickets gate (run-2 fail): a NON-UUID assignedTo that is NOT
  // the 'me' sentinel (e.g. a teammate NAME) reached `WHERE id = '<non-uuid>'::uuid` in
  // requireUserInOrg → "invalid input syntax for type uuid" → opaque HTTP 500. Must be a clean,
  // actionable, non-2xx-free error like categoryId/contactId/sourceInboxId.
  it("tickets:create returns a clean invalid_assignee (not a 500) for a non-UUID assignedTo", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bad assignee name", channel: "manual", assignedTo: "Nadia" },
      }),
    ).rejects.toMatchObject({ code: "invalid_assignee" })
  })

  // boxtal-tracking-exception-sweep-to-tickets gate: a weak model frequently passes EMPTY STRINGS
  // for every optional field it has no value for (contactId:"", assignedTo:"", team:"", categoryId:"",
  // sourceInboxId:"", externalRef:""). Each empty string must coalesce to SQL NULL — never reach
  // `''::uuid` (→ "invalid input syntax for type uuid" → opaque HTTP 500). The create must succeed
  // (it is ungated) and produce a contact-less, unassigned ticket.
  it("tickets:create succeeds (no 500) when ALL optional fields are empty strings", async () => {
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Empty-string optionals",
        channel: "manual",
        contactId: "",
        assignedTo: "",
        team: "",
        categoryId: "",
        sourceInboxId: "",
      },
    })
    expect(out.data.ticketId).toBeTruthy()
  })

  // social-angry-instagram-dm-triage-to-support-ticket gate: a ticket opened from a social-platform DM
  // or comment must be honestly labeled with the `social` channel. Before the fix, `channel` was a free
  // string with no `social` value in the DB CHECK — a model labeling the source channel ("instagram-dm")
  // bound a non-enum value → opaque HTTP 500 (the agent had to mislabel the ticket "email" to recover).
  // (a) `social` is now a first-class accepted channel + persists.
  it("tickets:create accepts the 'social' channel for a social-derived ticket (and persists it)", async () => {
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Angry IG DM — Kestrel 6 bricked after firmware", channel: "social" },
    })
    expect(out.data.ticketId).toBeTruthy()
    await withSystemDb("tickets-reference-validation-social-channel-check", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT channel FROM app_tickets.tickets WHERE id = ${out.data.ticketId}::uuid
      `)) as any
      expect((rows.rows ?? rows)[0]?.channel).toBe("social")
    })
  })

  // (b) The natural alias a weak model reaches for ("instagram-dm" — the EXACT value that 500'd in the
  // discovery run) is canonicalized to the real `social` channel, so the create SUCCEEDS and is labeled
  // honestly — never a 500, never silently mislabeled "email".
  it("tickets:create canonicalizes the 'instagram-dm' channel alias to 'social' (no 500)", async () => {
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "From Instagram DM", channel: "instagram-dm" },
    })
    expect(out.data.ticketId).toBeTruthy()
    await withSystemDb("tickets-reference-validation-instagram-alias-check", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT channel FROM app_tickets.tickets WHERE id = ${out.data.ticketId}::uuid
      `)) as any
      expect((rows.rows ?? rows)[0]?.channel).toBe("social")
    })
  })

  // (c) A genuinely-unknown channel is a clean, retryable invalid_params error naming the allowed set —
  // never the opaque HTTP 500 the raw DB CHECK violation produced.
  it("tickets:create returns a clean invalid_params (not a 500) for an unknown channel", async () => {
    await expect(
      executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Bogus channel", channel: "carrier-pigeon" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" })
  })

  // boxtal-tracking-exception-sweep-to-tickets gate: the realistic proactive-ticket payload the
  // agent builds — priority high, a real category by id, contactEmail find-or-create, a team string,
  // and an initialMessage OBJECT carrying the exception detail — must create cleanly (no 500).
  it("tickets:create succeeds with a full proactive-ticket payload (category + contactEmail + team + initialMessage object)", async () => {
    const email = `proactive-${Date.now()}@customer.example`
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Proactive: shipment EXCEPTION — Westcoast Pro Audio",
        channel: "manual",
        priority: "high",
        categoryId,
        contactEmail: email,
        contactName: "Westcoast Pro Audio",
        team: "Support",
        initialMessage: {
          kind: "inbound",
          textBody: "Shipment 1Z-XSW-0US1 is held at customs (import clearance docs required).",
        },
      },
    })
    expect(out.data.ticketId).toBeTruthy()
  })

  // Regression: an inbound initialMessage created alongside a contactEmail must carry that
  // email as its from_email — tickets:reply resolves the outbound To: from the most recent
  // inbound from_email, so without the stamp the fresh ticket is unreplyable (no_recipient).
  it("tickets:create stamps contactEmail as the inbound initial message sender", async () => {
    const email = `replayable-${Date.now()}@customer.example`
    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: {
        subject: "Activation help",
        channel: "email",
        contactEmail: email,
        contactName: "Replay Customer",
        initialMessage: { kind: "inbound", textBody: "I need help activating my license." },
      },
    })
    const got = await executeTool<{ messages: { items: Array<Record<string, unknown>> } }>({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: out.data.ticketId },
    })
    const inbound = got.data.messages.items.find((m) => (m.kind as string) === "inbound")
    expect(inbound).toBeTruthy()
    expect((inbound?.fromEmail ?? inbound?.from_email) as string).toBe(email)
  })

  it("tickets:assign rejects users outside the ticket org", async () => {
    await expect(
      executeTool({
        toolName: "tickets:assign",
        orgId,
        actor,
        params: { ticketId, assignedTo: otherUserId },
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" })
  })

  // Regression (marco-mondial-relay-pickup-expiry-followup, gate run): a ticket created WITHOUT an
  // explicit sourceInboxId landed with source_inbox_id NULL, so a subsequent tickets:reply preflighted
  // `no_inbox` ("ticket has no source inbox") and the agent's create-then-reply flow dead-ended on a 422.
  // createTicket now binds an inbox-less create to the org's DEFAULT outbound inbox (the same routing
  // inbound mail uses), so the created ticket is replyable.
  it("tickets:create binds a ticket with no sourceInboxId to the org's default outbound inbox", async () => {
    // Seed an active connected account + a default-for-create inbox for this org.
    const inboxId = await withSystemDb("tickets-default-inbox-fixture", async (tx) => {
      const caRows = await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by)
        VALUES (gen_random_uuid(), ${orgId}::uuid, 'tickets', 'gmail', 'org', NULL, 'oauth2', ${`support-${Date.now()}@qa.local`}, 'active', ${userId}::uuid)
        RETURNING id
      `)
      const caId = extractRows<{ id: string }>(caRows)[0].id
      const inbRows = await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${caId}::uuid, 'Support', ${`support-${Date.now()}@qa.local`}, 'internal', true)
        RETURNING id
      `)
      return extractRows<{ id: string }>(inbRows)[0].id
    })

    const out = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject: "Pickup heads-up (no explicit inbox)", channel: "manual", contactId },
    })
    expect(out.data.ticketId).toBeTruthy()

    const sourceInboxId = await withSystemDb("tickets-default-inbox-check", async (tx) => {
      const rows = await tx.execute(drizzleSql`
        SELECT source_inbox_id FROM app_tickets.tickets WHERE id = ${out.data.ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
      return extractRows<{ source_inbox_id: string | null }>(rows)[0]?.source_inbox_id ?? null
    })
    // The created ticket is bound to the default inbox — without the fix it was NULL (un-replyable).
    expect(sourceInboxId).toBe(inboxId)
  })
})
