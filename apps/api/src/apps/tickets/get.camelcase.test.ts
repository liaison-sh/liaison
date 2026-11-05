// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 6] camelCase shape adapter for `tickets:get`. Verifies the app-tool
// envelope returns camelCase ticket + messages, populates read-state fields,
// and sanitizes message HTML.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let ticketId: string
let ticketHandle: string
let actor: ActorContext

beforeAll(async () => {
  const slug = `get-camel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("get-camel-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Get Camel', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'GC', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (userRows.rows ?? userRows)[0].id
    ticketId = crypto.randomUUID()
    // A REAL handle: `ticket-<n>`, exactly what nextHandle mints and what the
    // UI, search results and every agent-visible surface show.
    ticketHandle = `ticket-${Math.floor(Math.random() * 1e9)}`
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        last_inbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${ticketHandle}, 'Hello', 'open', 'normal', 'manual', 'internal',
        ${`RT${slug.replace(/-/g, "").slice(0, 14)}`}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        now(), now(), now(), now()
      )
    `)
    // Two messages — one with HTML containing a script tag (must be sanitized).
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, html_body, text_body, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound',
              '<p>safe</p><script>alert(1)</script>',
              'safe', now() - interval '5 minutes', now(), now())
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'note', 'internal note',
              now() - interval '4 minutes', now(), now())
    `)
    // Link a contact + assignee so the get path's contact/assignee name
    // subqueries (mirrored from the search projection) can be asserted.
    const contactId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
      VALUES (${contactId}, ${orgId}, ${`hans-${slug}`}, 'Hans Weber', 'hans@example.com', ${userId}, now(), now())
    `)
    await tx.execute(drizzleSql`
      UPDATE app_tickets.tickets
      SET contact_id = ${contactId}, assigned_to = ${userId}
      WHERE id = ${ticketId} AND org_id = ${orgId}
    `)
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

describe("tickets.get.camelcase-projection", () => {
  it("returns camelCase ticket and messages", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId },
    })
    const data = out.data as any
    expect(data.ticket.id).toBe(ticketId)
    expect(data.ticket.handle).toMatch(/^ticket-/)
    expect(data.ticket.subject).toBe("Hello")
    expect(data.ticket.lastInboundAt).toBeTruthy()
    // No snake_case keys leak.
    for (const k of Object.keys(data.ticket)) expect(k.includes("_")).toBe(false)
    expect(data.messages.items.length).toBe(2)
    for (const m of data.messages.items) {
      for (const k of Object.keys(m)) expect(k.includes("_")).toBe(false)
      expect(m.id).toBeTruthy()
      expect(m.ticketId).toBe(ticketId)
    }
  })

  it("tickets.get.html-sanitized — strips <script> tags from htmlBody (rich view)", async () => {
    // The slim default view carries no htmlBody at all — the sanitization path
    // is exercised through the explicit rich-view opt-in the web UI uses.
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId, includeHtml: true },
    })
    const data = out.data as any
    const inbound = data.messages.items.find((m: any) => m.kind === "inbound")
    expect(inbound.htmlBody).toBeTruthy()
    expect(inbound.htmlBody).not.toContain("<script")
    expect(inbound.htmlBody).toContain("safe")
  })

  it("tickets.get slim default — no htmlBody, totalMessageCount present", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId },
    })
    const data = out.data as any
    expect(typeof data.totalMessageCount).toBe("number")
    expect(data.totalMessageCount).toBeGreaterThan(0)
    const inbound = data.messages.items.find((m: any) => m.kind === "inbound")
    expect(inbound.htmlBody ?? null).toBeNull()
    expect(typeof inbound.textBody).toBe("string")
  })

  it("tickets.get.contact-and-assignee — projects contact name/email + assignee name", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId },
    })
    const t = (out.data as any).ticket
    expect(t.contact?.name).toBe("Hans Weber")
    expect(t.contact?.email).toBe("hans@example.com")
    expect(t.assigneeName).toBe("GC")
  })

  it("tickets.get.read-by-projection — readByCount and readByRecent populated on ticket", async () => {
    await executeTool({
      toolName: "tickets:markRead",
      orgId,
      actor,
      params: { ticketId },
    })
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId },
    })
    const t = (out.data as any).ticket
    expect(t.readByCount).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(t.readByRecent)).toBe(true)
  })
})

// The handle (`ticket-<n>`) is the ONLY ticket identifier an agent sees in the
// UI and in search results, so it is what agents pass back to the tools. It
// used to be bound straight into the uuid `id` column: Postgres threw
// "invalid input syntax for type uuid" and the caller got a 500.
describe("tickets.get.ticket-ref resolution", () => {
  it("resolves a ticket handle to the ticket", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: ticketHandle },
    })
    const data = out.data as any
    expect((out as any).error).toBeUndefined()
    expect(data.ticket.id).toBe(ticketId)
    expect(data.ticket.handle).toBe(ticketHandle)
    expect(data.messages.items.length).toBeGreaterThan(0)
  })

  it("returns a typed invalid_params error for a garbage ticket id", async () => {
    // Before the resolver this reached Postgres as a uuid cast and came back as
    // a 500 "invalid input syntax for type uuid", not a tool error.
    const err = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: "not-a-ticket-at-all" },
    }).then(
      () => null,
      (e) => e as Error & { code?: string; status?: number },
    )
    expect(err).not.toBeNull()
    expect(err?.code).toBe("invalid_params")
    expect(err?.status).toBe(400)
    expect(err?.message).not.toContain("invalid input syntax")
  })

  it("returns a typed not_found error for an unknown ticket handle", async () => {
    const err = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: "ticket-999999999" },
    }).then(
      () => null,
      (e) => e as Error & { code?: string; status?: number },
    )
    expect(err).not.toBeNull()
    expect(err?.code).toBe("not_found")
    expect(err?.status).toBe(404)
  })
})
