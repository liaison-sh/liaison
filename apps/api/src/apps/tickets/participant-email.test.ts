// SPDX-License-Identifier: FSL-1.1-ALv2
// Who a ticket is with, as `tickets:get` reports it (`participantEmail`, the
// address the customer card looks up): the requester, then the linked contact
// (a relinked contact wins at once), then the first inbound sender that is
// not one of the org's own inboxes. The agent's customer context reads the
// same loader (customer-context.test.ts).
import { beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId = ""
let userId = ""
let ticketId = ""
let contactA = ""
let contactB = ""
let actor: ActorContext

async function run(sql: ReturnType<typeof drizzleSql>): Promise<void> {
  await withSystemDb("participant-email-fixture", async (tx) => {
    await tx.execute(sql)
  })
}

beforeAll(async () => {
  const slug = `participant-${randomUUID().slice(0, 12)}`
  await withSystemDb("participant-email-fixture", async (tx) => {
    const [org] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Participant', ${slug}) RETURNING id`),
    )
    orgId = org?.id ?? ""
    const [user] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'P', 'active', 'h', 1, 1) RETURNING id`),
    )
    userId = user?.id ?? ""
  })
  await ensureAppsForOrg(orgId, {})
  contactA = randomUUID()
  contactB = randomUUID()
  for (const [id, email] of [
    [contactA, "Contact.A@Acme.test"],
    [contactB, "contact.b@acme.test"],
  ] as const) {
    await run(drizzleSql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
      VALUES (${id}, ${orgId}, ${`c-${id.slice(0, 8)}`}, 'Contact', ${email}, ${userId}, now(), now())`)
  }
  ticketId = randomUUID()
  await run(drizzleSql`
    INSERT INTO app_tickets.tickets (
      id, org_id, handle, subject, status, priority, channel, sensitivity,
      reply_token, sla_target_seconds, message_count, last_message_at, created_at, updated_at,
      requester_email, contact_id
    ) VALUES (
      ${ticketId}, ${orgId}, ${`ticket-${Math.floor(Math.random() * 1e9)}`}, 'Rule', 'open',
      'normal', 'email', 'internal', ${randomUUID()}, 3600, 2, now(), now(), now(),
      NULL, ${contactA}
    )`)
  await run(drizzleSql`
    INSERT INTO app_tickets.inboxes (
      id, org_id, connected_account_id, name, email_address, is_default_for_create, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Support', 'support@ourco.test', false, now(), now()
    )`)
  for (const [from, ago] of [
    ["support@ourco.test", "3 hours"],
    ["First.Sender@acme.test", "2 hours"],
  ] as const) {
    await run(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, text_body,
        received_at, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', ${from}, 'hi',
        now() - ${ago}::interval, now() - ${ago}::interval, now(), now())`)
  }
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  }
})

async function participant(): Promise<unknown> {
  const out = await executeTool({ toolName: "tickets:get", orgId, actor, params: { ticketId } })
  const data = out.data as { ticket: { participantEmail?: unknown } }
  return data.ticket.participantEmail
}

describe("tickets:get participantEmail (P2-SK5)", () => {
  it("requester, then contact (relinked), then the first external inbound sender", async () => {
    expect(await participant()).toBe("contact.a@acme.test")
    await run(
      drizzleSql`UPDATE app_tickets.tickets SET contact_id = ${contactB} WHERE id = ${ticketId}`,
    )
    expect(await participant()).toBe("contact.b@acme.test")
    await run(drizzleSql`UPDATE app_tickets.tickets SET contact_id = NULL WHERE id = ${ticketId}`)
    expect(await participant()).toBe("first.sender@acme.test")
    await run(
      drizzleSql`UPDATE app_tickets.tickets SET requester_email = 'Jane@Acme.test' WHERE id = ${ticketId}`,
    )
    expect(await participant()).toBe("jane@acme.test")
  })

  it("is null when the only address is not a plain addr-spec", async () => {
    await run(
      drizzleSql`UPDATE app_tickets.tickets SET requester_email = '"do this"@acme.test', contact_id = NULL WHERE id = ${ticketId}`,
    )
    await run(drizzleSql`DELETE FROM app_tickets.messages WHERE ticket_id = ${ticketId}`)
    expect(await participant()).toBeNull()
  })
})
