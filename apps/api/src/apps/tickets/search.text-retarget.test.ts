// SPDX-License-Identifier: FSL-1.1-ALv2
// Unit coverage for the tickets:search free-text retarget (unified-search spec
// §3.5) that is purely testable WITHOUT a live Meili: the mandatory empty-id
// short-circuit (never emits `T.id IN ()`) and the id-join actually restricts
// the returned rows to the resolved id set. Uses the injectable resolver seam
// (`TicketsSearchTestAccess.setMatchResolver`) instead of mocking Meili — the real
// Meili-backed path is covered by the scenario tier (search.freetext.test.ts
// et al.), per the existing-suite convention (colocated tx-double tests stay
// free of live-Meili dependencies).
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  searchTickets,
  type TicketSearchActor,
  TicketSearchUnavailableError,
  TicketsSearchTestAccess,
} from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let userId: string
let inboxId: string
let ticketA: string
let ticketB: string

const actor: TicketSearchActor = {
  userId: "",
  scopes: ["tickets:tickets:read"],
  dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  roleIds: [],
}

async function seedTicket(subject: string): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `retarget-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-retarget-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${subject}, 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId}, now() - interval '5 minutes', now() - interval '5 minutes', now(), now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `search-retarget-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-retarget-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Retarget', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u1-${slug}@test.com`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    userId = (userRows.rows ?? userRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  actor.userId = userId
  ticketA = await seedTicket("Ticket A")
  ticketB = await seedTicket("Ticket B")
})

afterEach(() => {
  TicketsSearchTestAccess.setMatchResolver(null)
})

describe("searchTickets — free-text retarget id-join (spec §3.5)", () => {
  it("empty resolved id list short-circuits WITHOUT running the page query (never emits IN ())", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => [])
    await withSystemDb("search-retarget-empty", async (tx) => {
      const res = await searchTickets(
        tx as never,
        orgId,
        { q: "nomatch", limit: 10 } as never,
        actor,
      )
      expect(res).toEqual({ items: [], nextCursor: null, totalCount: 0 })
    })
  })

  it("empty resolved id list short-circuits countOnly too", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => [])
    await withSystemDb("search-retarget-empty-count", async (tx) => {
      const res = await searchTickets(
        tx as never,
        orgId,
        { q: "nomatch", countOnly: true } as never,
        actor,
      )
      expect(res.totalCount).toBe(0)
      expect(res.items).toEqual([])
    })
  })

  it("restricts the page + total to the resolved id set (id-join)", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => [ticketA])
    await withSystemDb("search-retarget-restrict", async (tx) => {
      const res = await searchTickets(
        tx as never,
        orgId,
        { q: "anything", limit: 10 } as never,
        actor,
      )
      expect(res.items.map((r) => (r as { id: string }).id)).toEqual([ticketA])
      expect(res.totalCount).toBe(1)
    })
  })

  it("resolved ids outside the relational filters are still excluded by those filters", async () => {
    // The id-join is ANDed with every other condition — a resolved id for a
    // ticket that doesn't match an additional relational filter must not leak
    // through.
    TicketsSearchTestAccess.setMatchResolver(async () => [ticketA, ticketB])
    await withSystemDb("search-retarget-and", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET status = 'closed', updated_at = now() WHERE id = ${ticketB}`,
      )
    })
    await withSystemDb("search-retarget-and-run", async (tx) => {
      const res = await searchTickets(
        tx as never,
        orgId,
        { q: "anything", status: "open", limit: 10 } as never,
        actor,
      )
      expect(res.items.map((r) => (r as { id: string }).id)).toEqual([ticketA])
    })
  })

  it("a non-empty query with no actor context fails loudly instead of resolving against empty grants", async () => {
    await withSystemDb("search-retarget-no-actor", async (tx) => {
      await expect(
        searchTickets(tx as never, orgId, { q: "anything", limit: 10 } as never),
      ).rejects.toThrow(/actor/i)
    })
  })

  it("propagates SEARCH_UNAVAILABLE as a TicketSearchUnavailableError when resolution fails", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => {
      throw new Error("meili down")
    })
    await withSystemDb("search-retarget-unavailable", async (tx) => {
      await expect(
        searchTickets(tx as never, orgId, { q: "anything", limit: 10 } as never, actor),
      ).rejects.toBeInstanceOf(TicketSearchUnavailableError)
    })
  })

  it("empty q never touches the resolver — pure relational listing is unaffected", async () => {
    let called = false
    TicketsSearchTestAccess.setMatchResolver(async () => {
      called = true
      return []
    })
    await withSystemDb("search-retarget-empty-q", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { limit: 10 } as never)
      expect(res.items.length).toBeGreaterThan(0)
    })
    expect(called).toBe(false)
  })
})
