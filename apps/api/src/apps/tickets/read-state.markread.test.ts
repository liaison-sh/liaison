// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { type MarkReadResult, markRead } from "~/apps/tickets/read-state"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { withTicketFixture } from "./read-state.test-fixtures"

function expectOk(out: Awaited<ReturnType<typeof markRead>>): MarkReadResult {
  if ("error" in out) throw new Error(`expected success, got ${JSON.stringify(out)}`)
  return out
}

describe("tickets.read-state.upsert-monotonic", () => {
  it("inserts new row on first mark-read", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId }) => {
      const result = expectOk(await markRead(tx, { ticketId, userId }))
      expect(result.readAt).toBeTruthy()
      const rows = extractRows<{ count: string }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::text AS count FROM app_tickets.ticket_reads WHERE ticket_id = ${ticketId}`,
        ),
      )
      expect(Number(rows[0].count)).toBe(1)
    })
  })

  it("upsert is monotonic — older candidate is a no-op", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId }) => {
      const first = expectOk(await markRead(tx, { ticketId, userId }))
      const earlier = new Date(new Date(first.readAt).getTime() - 60_000).toISOString()
      const second = expectOk(await markRead(tx, { ticketId, userId, candidateReadAt: earlier }))
      expect(second.readAt).toBe(first.readAt)
    })
  })

  it("advances read_at on later candidate", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId }) => {
      const first = expectOk(await markRead(tx, { ticketId, userId }))
      const later = new Date(new Date(first.readAt).getTime() + 60_000).toISOString()
      const second = expectOk(await markRead(tx, { ticketId, userId, candidateReadAt: later }))
      expect(new Date(second.readAt).getTime()).toBeGreaterThan(new Date(first.readAt).getTime())
    })
  })

  it("stores last_read_message_id when provided", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId, messageId }) => {
      const result = expectOk(
        await markRead(tx, {
          ticketId,
          userId,
          lastReadMessageId: messageId,
        }),
      )
      expect(result.lastReadMessageId).toBe(messageId)
    })
  })

  it("rejects last_read_message_id from a different ticket", async () => {
    await withTicketFixture(async ({ orgId, tx, ticketId, userId }) => {
      const otherTicketId = crypto.randomUUID()
      const otherMessageId = crypto.randomUUID()
      await withSystemDb("read-state-unrelated-message", async (sys) => {
        await sys.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
            sla_elapsed_seconds, message_count, created_at, updated_at
          ) VALUES (
            ${otherTicketId}, ${orgId}, ${`ticket-unrelated-${Date.now()}`}, 'Other', 'open', 'normal', 'manual', 'internal',
            ${`RT${Math.floor(Math.random() * 1e16)}`}, 3600, now() + interval '1 hour', now(), 0, 1, now(), now()
          )
        `)
        await sys.execute(drizzleSql`
          INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
          VALUES (${otherMessageId}, ${orgId}, ${otherTicketId}, 'inbound', 'wrong ticket', now(), now(), now())
        `)
      })

      const result = await markRead(tx, { ticketId, userId, lastReadMessageId: otherMessageId })
      expect("error" in result && result.error.code).toBe("invalid_params")
    })
  })

  it("does not replace last_read_message_id on an older candidate", async () => {
    await withTicketFixture(async ({ orgId, ticketId, tx, userId, messageId }) => {
      const newerMessageId = crypto.randomUUID()
      await withSystemDb("read-state-second-message", async (sys) => {
        await sys.execute(drizzleSql`
          INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
          VALUES (${newerMessageId}, ${orgId}, ${ticketId}, 'inbound', 'newer pointer', now(), now(), now())
        `)
      })
      const first = expectOk(
        await markRead(tx, {
          ticketId,
          userId,
          lastReadMessageId: messageId,
          candidateReadAt: "2026-01-01T00:01:00.000Z",
        }),
      )
      const second = expectOk(
        await markRead(tx, {
          ticketId,
          userId,
          lastReadMessageId: newerMessageId,
          candidateReadAt: "2026-01-01T00:00:00.000Z",
        }),
      )
      expect(second.readAt).toBe(first.readAt)
      expect(second.lastReadMessageId).toBe(messageId)
    })
  })

  // Ticket read state is shared by the team, and every open client is told
  // when it flips (handlers.ts ticketsMarkRead). The flip, not every re-read:
  // opening an already read ticket must not broadcast.
  it("reports becameRead on the read that clears the ticket, and only on that one", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId }) => {
      const first = expectOk(await markRead(tx, { ticketId, userId }))
      expect(first.becameRead).toBe(true)
      const second = expectOk(await markRead(tx, { ticketId, userId }))
      expect(second.becameRead).toBe(false)
    })
  })

  it("a closed ticket is never unread, so its read never flips", async () => {
    await withTicketFixture({ closed: true }, async ({ tx, ticketId, userId }) => {
      expect(expectOk(await markRead(tx, { ticketId, userId })).becameRead).toBe(false)
    })
  })

  it("works on closed ticket without raising", async () => {
    await withTicketFixture({ closed: true }, async ({ tx, ticketId, userId }) => {
      const result = expectOk(await markRead(tx, { ticketId, userId }))
      expect(result.readAt).toBeTruthy()
    })
  })

  it("treats an empty-string lastReadMessageId as null instead of throwing", async () => {
    await withTicketFixture(async ({ tx, ticketId, userId }) => {
      const result = expectOk(
        await markRead(tx, {
          ticketId,
          userId,
          lastReadMessageId: "",
        }),
      )
      expect(result.lastReadMessageId).toBeNull()
      const rows = extractRows<{ last_read_message_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT last_read_message_id FROM app_tickets.ticket_reads WHERE ticket_id = ${ticketId} AND user_id = ${userId}`,
        ),
      )
      expect(rows[0].last_read_message_id).toBeNull()
    })
  })
})

// Two first reads of one ticket by one user, at once (two tabs, a double click).
// ON CONFLICT (ticket_id, user_id) makes the upsert race-free only while that
// key is the table's sole unique index: a second, wider one (org_id, ticket_id,
// user_id) is not arbitrated, so one of the racing inserts failed on it with a
// unique violation, surfaced as HTTP 409. Many rounds, since one race in a
// round is enough to fail.
describe("tickets.read-state.concurrent", () => {
  it("concurrent first reads by one user on one ticket all succeed and leave one row", async () => {
    await withTicketFixture(async ({ tx, orgId, userId, actor }) => {
      const reader = { ...actor, dimensionGrants: { "*": ["*"] } }
      const failures: string[] = []
      for (let round = 0; round < 40; round++) {
        const ticketId = crypto.randomUUID()
        await withSystemDb("read-state-concurrent-ticket", async (sys) => {
          await sys.execute(drizzleSql`
            INSERT INTO app_tickets.tickets (
              id, org_id, handle, subject, status, priority, channel, sensitivity,
              reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
              sla_elapsed_seconds, message_count, last_inbound_at, last_message_at,
              created_at, updated_at
            ) VALUES (
              ${ticketId}, ${orgId}, ${`ticket-race-${round}-${ticketId.slice(0, 8)}`}, 'Race', 'open', 'normal', 'manual', 'internal',
              ${`RT${Math.floor(Math.random() * 1e16)}`}, 3600, now() + interval '1 hour', now(),
              0, 1, now(), now(), now(), now()
            )
          `)
        })
        const outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, () =>
            withRlsContext(reader, (rls) => markRead(rls, { ticketId, userId })),
          ),
        )
        for (const o of outcomes) {
          if (o.status === "rejected") failures.push(String(o.reason?.cause ?? o.reason))
          else if ("error" in o.value) failures.push(JSON.stringify(o.value))
        }
        const rows = extractRows<{ count: string }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::text AS count FROM app_tickets.ticket_reads WHERE ticket_id = ${ticketId} AND user_id = ${userId}`,
          ),
        )
        expect(Number(rows[0].count)).toBe(1)
      }
      expect(failures).toEqual([])
    })
  }, 120_000)
})
