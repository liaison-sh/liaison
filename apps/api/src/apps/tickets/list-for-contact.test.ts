// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { listForContact } from "~/apps/tickets/list-for-contact"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"

async function ensureOrgAndContact(): Promise<{ orgId: string; contactId: string }> {
  const slug = `lfc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const out = await withSystemDb("lfc-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'LFC Org', ${slug}) RETURNING id
    `)) as any
    const orgId = (orgRows.rows ?? orgRows)[0].id as string
    const contactRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${`contact-${slug}`}, 'Cust', ${`cust-${slug}@test.com`}, now(), now())
      RETURNING id
    `)) as any
    const contactId = (contactRows.rows ?? contactRows)[0].id as string
    return { orgId, contactId }
  })
  return out
}

async function seedTicket(
  orgId: string,
  contactId: string | null,
  options: {
    status?: string
    mergedInto?: string | null
    lastMessageMinutesAgo?: number | null
  } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `ticket-${Math.floor(Math.random() * 1e9)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  const status = options.status ?? "open"
  const merged = options.mergedInto ?? null
  const lastMessageAt =
    options.lastMessageMinutesAgo === null
      ? drizzleSql`NULL`
      : drizzleSql`now() - (${options.lastMessageMinutesAgo ?? 5} || ' minutes')::interval`
  await withSystemDb("lfc-seed-ticket", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        contact_id, merged_into_ticket_id,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'lfc subject', ${status}, 'normal', 'manual', 'internal',
        ${contactId}, ${merged},
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        ${lastMessageAt}, now(), now()
      )
    `)
  })
  return id
}

describe("tickets.list-for-contact", () => {
  it("returns tickets for a contact ordered by last_message_at DESC, excluding merged sources", async () => {
    const { orgId, contactId } = await ensureOrgAndContact()
    const t1 = await seedTicket(orgId, contactId, { lastMessageMinutesAgo: 60 })
    const t2 = await seedTicket(orgId, contactId, { lastMessageMinutesAgo: 5 })
    const target = await seedTicket(orgId, contactId, { lastMessageMinutesAgo: 1 })
    await seedTicket(orgId, contactId, { mergedInto: target })

    const out = await listForContact(db, { contactId })
    const ids = out.items.map((r) => r.id)
    expect(ids).toContain(target)
    expect(ids).toContain(t1)
    expect(ids).toContain(t2)
    expect(ids).not.toContain(
      out.items.find((r) => r.id !== target && r.id !== t1 && r.id !== t2)?.id ?? "X",
    )
    expect(new Date(out.items[0].lastActivityAt!).getTime()).toBeGreaterThan(
      new Date(out.items[out.items.length - 1].lastActivityAt!).getTime(),
    )
  })

  it("respects limit and caps at 100", async () => {
    const { orgId, contactId } = await ensureOrgAndContact()
    await seedTicket(orgId, contactId, { lastMessageMinutesAgo: 1 })
    await seedTicket(orgId, contactId, { lastMessageMinutesAgo: 2 })
    const out = await listForContact(db, { contactId, limit: 1 })
    expect(out.items).toHaveLength(1)
  })

  it("empty result for contact with no tickets", async () => {
    const { contactId } = await ensureOrgAndContact()
    const out = await listForContact(db, { contactId })
    expect(out.items).toEqual([])
  })
})
