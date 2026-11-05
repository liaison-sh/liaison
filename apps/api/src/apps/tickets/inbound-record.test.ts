// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { recordInboundOnTicket } from "~/apps/tickets/inbound-record"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"

const ORG_ID = "00000000-0000-0000-0000-0000000d3190"
const USER_ID = "00000000-0000-0000-0000-0000000d3191"
const actor = { actorType: "system" as const, userId: USER_ID, orgId: ORG_ID }

async function seedTicket(
  handle: string,
  overrides: { status?: string; lastInboundAt?: string | null } = {},
): Promise<string> {
  return withPrivilegedDb(ORG_ID, "inbound-record-test-seed-ticket", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets
          (org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline, status, last_inbound_at)
        VALUES (${ORG_ID}, ${handle}, ${`Subject ${handle}`}, 'email', ${`tok-${handle}`}, 3600,
                now() + interval '1 day', ${overrides.status ?? "open"}, ${overrides.lastInboundAt ?? null})
        RETURNING id`),
    )
    return rows[0]!.id
  })
}

async function fetchTicket(
  ticketId: string,
): Promise<{ message_count: number; last_inbound_at: Date | null }> {
  return extractRows<{ message_count: number; last_inbound_at: Date | null }>(
    await withPrivilegedDb(ORG_ID, "inbound-record-test-fetch", (tx) =>
      tx.execute(
        drizzleSql`SELECT message_count, last_inbound_at FROM app_tickets.tickets WHERE id = ${ticketId} AND org_id = ${ORG_ID}`,
      ),
    ),
  )[0]!
}

describe("recordInboundOnTicket", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'InboundRecordOrg', 'inbound-record-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'inbound-record@test.com', 'Inbound Record Tester') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await withPrivilegedDb(ORG_ID, "inbound-record-test-clean", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`)
      await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`)
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("last_inbound_at never moves backwards when a message carries an older Date header", async () => {
    const ticketId = await seedTicket("ir-monotonic")
    // First message: a normal, current-time send.
    await withPrivilegedDb(ORG_ID, "inbound-record-test-first", (tx) =>
      recordInboundOnTicket(tx, {
        orgId: ORG_ID,
        ticketId,
        sentAt: new Date().toISOString(),
        actor,
      }),
    )
    const afterFirst = await fetchTicket(ticketId)
    expect(afterFirst.message_count).toBe(1)
    const firstLastInbound = afterFirst.last_inbound_at
    expect(firstLastInbound).not.toBeNull()

    // Second message carries a sender Date header that claims it was sent
    // years ago -- a skewed or forged header must never push last_inbound_at
    // backwards and hide the ticket from the attention list.
    await withPrivilegedDb(ORG_ID, "inbound-record-test-second", (tx) =>
      recordInboundOnTicket(tx, {
        orgId: ORG_ID,
        ticketId,
        sentAt: "2001-01-01T00:00:00.000Z",
        actor,
      }),
    )
    const afterSecond = await fetchTicket(ticketId)
    expect(afterSecond.message_count).toBe(2)
    expect(afterSecond.last_inbound_at).not.toBeNull()
    expect(new Date(afterSecond.last_inbound_at as Date).getTime()).toBeGreaterThanOrEqual(
      new Date(firstLastInbound as Date).getTime(),
    )
  })

  it("a declined inbound transition logs a warning and still records the message", async () => {
    const ticketId = await seedTicket("ir-declined")
    // Mark the ticket as merged into another (nonexistent) ticket so the
    // state-machine transition declines with merged_ticket.
    await withPrivilegedDb(ORG_ID, "inbound-record-test-merge-marker", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET merged_into_ticket_id = ${ticketId} WHERE id = ${ticketId} AND org_id = ${ORG_ID}`,
      ),
    )
    // A ticket can't legally be merged into itself outside a test, but the
    // state machine only checks the column is non-null to decline -- this is
    // the cheapest way to force a declined transition without a second row.

    const warnSpy = spyOn(rootLogger, "warn")
    const result = await withPrivilegedDb(ORG_ID, "inbound-record-test-declined", (tx) =>
      recordInboundOnTicket(tx, {
        orgId: ORG_ID,
        ticketId,
        sentAt: new Date().toISOString(),
        actor,
      }),
    )

    expect(result.transition.ok).toBe(false)
    if (!result.transition.ok) expect(result.transition.code).toBe("merged_ticket")
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[1]).toBe("inbound message did not reopen the ticket")
    warnSpy.mockRestore()

    const after = await fetchTicket(ticketId)
    expect(after.message_count).toBe(1)
    expect(after.last_inbound_at).not.toBeNull()
  })

  it("a future dated header does not pin last_inbound_at in the future", async () => {
    const ticketId = await seedTicket("ir-future")
    const before = Date.now()

    await withPrivilegedDb(ORG_ID, "inbound-record-test-future", (tx) =>
      recordInboundOnTicket(tx, {
        orgId: ORG_ID,
        ticketId,
        sentAt: new Date(before + 30 * 24 * 60 * 60 * 1000).toISOString(),
        actor,
      }),
    )

    const after = await fetchTicket(ticketId)
    expect(after.message_count).toBe(1)
    expect(after.last_inbound_at).not.toBeNull()
    const lastInboundMs = new Date(after.last_inbound_at as Date).getTime()
    expect(lastInboundMs).toBeGreaterThanOrEqual(before - 5_000)
    expect(lastInboundMs).toBeLessThanOrEqual(before + 60_000)
  })
})
