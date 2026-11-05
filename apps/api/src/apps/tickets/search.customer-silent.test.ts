// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (ticket-autoclose-stale-awaiting-customer-routine, sofia_week_support journey S3): the
// tickets app had NO server-side "no customer reply since N days" filter, so an auto-close routine tick
// had to judge each awaiting_customer ticket's staleness IN-CONTEXT from its last-inbound age — which a
// flash-lite tick did UNRELIABLY: it acted on the FRESH 1-2-day-silent tickets too, applying a "we
// haven't heard from you in over a week" final notice to a customer who had just replied (a routine-
// execution HARD FAIL: "acts on the FRESH tickets"). The fix mirrors the proven `aging`/`followupDue`
// lever: search now accepts `silentForDays: N` and computes, per awaiting_customer row,
// `customerSilentDays` (whole days since last_inbound_at) AND a `customerSilent` BOOLEAN
// (= customerSilentDays >= N), so the tick RENDERS the boolean — the STALE set to act on is exactly the
// rows where customerSilent is true; the FRESH set to skip is where it is false. The tick copies a
// boolean, it does not do date math.
//
// These tests pin: (1) each row's customerSilent boolean is true for >= N-day-silent and false for the
// fresh ones, (2) customerSilentDays reports the real last-inbound age, (3) the camelCase projection
// surfaces both, (4) a ticket with NO inbound customer message maps both to undefined (never a misleading
// false-stale / 0). FAILS-WITHOUT the server field (the tick would have no boolean to copy and would
// mis-discriminate) / PASSES-WITH.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { toCamelTicket } from "~/apps/tickets/projection"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let inboxId: string
const HANDLES: Record<string, string> = {}

/** Seed an awaiting_customer ticket whose last INBOUND customer message landed `silentDays` ago (the
 *  staleness signal). `silentDays = null` seeds a ticket with NO inbound customer message (last_inbound_at
 *  NULL) — the undefined-not-false-stale edge case. */
async function seedSilent(handleKey: string, silentDays: number | null): Promise<void> {
  const id = crypto.randomUUID()
  const handle = `silent-${handleKey}-${Math.floor(Math.random() * 1e10)}`
  HANDLES[handleKey] = handle
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-silent-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, first_response_at, last_inbound_at, last_outbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Customer silent test', 'awaiting_customer',
        'normal', 'email', 'internal',
        ${replyToken}, 86400, now() + interval '1 day',
        NULL, 0, 2, ${inboxId},
        now() - interval '20 days',
        ${silentDays === null ? drizzleSql`NULL` : drizzleSql`now() - (interval '1 day' * ${silentDays})`},
        now() - interval '21 days',
        ${silentDays === null ? drizzleSql`now() - interval '21 days'` : drizzleSql`now() - (interval '1 day' * ${silentDays})`},
        now() - interval '25 days', now()
      )
    `)
  })
}

beforeAll(async () => {
  const slug = `search-silent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-silent-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Customer Silent', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  await seedSilent("stale14", 14) // last inbound 14 days ago → STALE (>= 7)
  await seedSilent("stale9", 9) // last inbound 9 days ago → STALE (>= 7)
  await seedSilent("fresh2", 2) // last inbound 2 days ago → FRESH (< 7)
  await seedSilent("fresh1", 1) // last inbound 1 day ago → FRESH (< 7)
  await seedSilent("noinbound", null) // no inbound customer message ever → undefined, never false-stale
})

describe("searchTickets — server-computed `customerSilent` staleness discrimination (silentForDays)", () => {
  it("each awaiting_customer row carries customerSilent = (silentDays >= silentForDays) — server does the discrimination, NOT the tick", async () => {
    await withSystemDb("search-silent-bool", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "awaiting_customer",
        silentForDays: 7,
        limit: 50,
      } as never)
      const byHandle = new Map<string, Record<string, unknown>>()
      for (const r of res.items) byHandle.set(String((r as Record<string, unknown>).handle), r)
      // The decisive discrimination: stale (>=7d) → true; fresh (<7d) → false. WITHOUT the server field
      // the tick judged this in-context and acted on the fresh ones (the S3 hard fail).
      expect(
        Boolean((byHandle.get(HANDLES.stale14!) as Record<string, unknown>).customer_silent),
      ).toBe(true)
      expect(
        Boolean((byHandle.get(HANDLES.stale9!) as Record<string, unknown>).customer_silent),
      ).toBe(true)
      expect(
        Boolean((byHandle.get(HANDLES.fresh2!) as Record<string, unknown>).customer_silent),
      ).toBe(false)
      expect(
        Boolean((byHandle.get(HANDLES.fresh1!) as Record<string, unknown>).customer_silent),
      ).toBe(false)
    })
  })

  it("customerSilentDays reports the real days-since-last-inbound age per row", async () => {
    await withSystemDb("search-silent-days", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "awaiting_customer",
        silentForDays: 7,
        limit: 50,
      } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const stale14 = camel.find((c) => c.handle === HANDLES.stale14)!
      const fresh2 = camel.find((c) => c.handle === HANDLES.fresh2)!
      // FLOOR of the days difference — robust to clock-tick jitter: 14d-silent reads ~14, 2d-silent ~2.
      expect(stale14.customerSilentDays).toBeGreaterThanOrEqual(13)
      expect(stale14.customerSilentDays).toBeLessThanOrEqual(15)
      expect(fresh2.customerSilentDays).toBeGreaterThanOrEqual(1)
      expect(fresh2.customerSilentDays).toBeLessThanOrEqual(3)
    })
  })

  it("the camelCase projection surfaces customerSilent + customerSilentDays so the tick RENDERS the boolean (no in-context staleness math)", async () => {
    await withSystemDb("search-silent-camel", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "awaiting_customer",
        silentForDays: 7,
        limit: 50,
      } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const stale9 = camel.find((c) => c.handle === HANDLES.stale9)!
      const fresh1 = camel.find((c) => c.handle === HANDLES.fresh1)!
      expect(stale9.customerSilent).toBe(true)
      expect(fresh1.customerSilent).toBe(false)
    })
  })

  it("a custom silentForDays window re-discriminates: silentForDays:10 makes the 9-day ticket FRESH", async () => {
    await withSystemDb("search-silent-window", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "awaiting_customer",
        silentForDays: 10,
        limit: 50,
      } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      // 14d-silent is still >= 10 (stale); 9d-silent is now < 10 (fresh) — the threshold drives the set.
      expect(camel.find((c) => c.handle === HANDLES.stale14)!.customerSilent).toBe(true)
      expect(camel.find((c) => c.handle === HANDLES.stale9)!.customerSilent).toBe(false)
    })
  })

  it("a ticket with NO inbound customer message maps customerSilent + customerSilentDays to undefined (never a misleading false-stale / 0)", async () => {
    await withSystemDb("search-silent-noinbound", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "awaiting_customer",
        silentForDays: 7,
        limit: 50,
      } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const noInbound = camel.find((c) => c.handle === HANDLES.noinbound)!
      expect(noInbound.lastInboundAt).toBeNull()
      expect(noInbound.customerSilent).toBeUndefined()
      expect(noInbound.customerSilentDays).toBeUndefined()
    })
  })
})
