// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets:search orders the inbox by the last MESSAGE (inbound OR outbound) --
// last_message_at -- which is the same key the row's "last activity" date shows,
// so list order and the visible timestamp always agree. `activity_newest`
// (DESC) is the inbox default; `activity_oldest` (ASC) is the longest-untouched
// -first order "Needs attention" uses. This proves the modes order by
// last_message_at (NOT created_at, NOT last_inbound_at) and paginate correctly.
//
// It also proves the "Needs attention" smartFilter is keyed on message DIRECTION:
// a ticket where WE replied last (last message outbound = "awaiting customer") is
// EXCLUDED, whatever its status; a ticket where the customer wrote last is included.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let inboxId: string
let actor: ActorContext

function rows<T>(r: unknown): T[] {
  const x = r as { rows?: T[] } & T[]
  return x.rows ?? x
}

/**
 * Seed one OPEN ticket with independent timestamps (all in "days ago"; null →
 * NULL column). `lastMessage` is the sort key; `createdDaysAgo` and `inbound` are
 * set to a DIFFERENT order so a correct result can only come from last_message_at.
 */
async function seedTicket(opts: {
  createdDaysAgo: number
  inbound: number | null
  outbound: number | null
  lastMessage: number
  subject: string
  status?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `sa-${Math.floor(Math.random() * 1e12)}`
  const replyToken = `SA${Math.floor(Math.random() * 1e16)}`
  const daysAgo = (n: number | null) =>
    n === null ? null : drizzleSql`now() - (${n} * interval '1 day')`
  await withSystemDb("sort-activity-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_outbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${opts.subject}, ${opts.status ?? "open"}, 'normal', 'manual', 'internal',
        ${replyToken}, 14400, now() + interval '1 hour',
        now() - (${opts.createdDaysAgo} * interval '1 day'), 0, 1, ${inboxId},
        ${daysAgo(opts.inbound)}, ${daysAgo(opts.outbound)}, ${daysAgo(opts.lastMessage)},
        now() - (${opts.createdDaysAgo} * interval '1 day'), now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `sort-activity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("sort-activity-fixture", async (tx) => {
    orgId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Sort Activity', ${slug}) RETURNING id`),
    )[0]!.id
    inboxId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id`),
    )[0]!.id
    const userId = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'Caller', 'active', 'h', 1, 1) RETURNING id`),
    )[0]!.id
    actor = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read"],
      dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
    } as ActorContext
  })
  await ensureAppsForOrg(orgId, {})

  //   last_message  last_inbound  last_outbound  created   -> last message direction
  // A     1d            1d            null         10d       inbound  (customer wrote last)
  // B     3d            10d           3d            2d       outbound (WE replied last = awaiting customer)
  // C     6d            6d            null          6d       inbound
  // D     8d            null          8d            4d       outbound (no inbound at all)
  await seedTicket({
    createdDaysAgo: 10,
    inbound: 1,
    outbound: null,
    lastMessage: 1,
    subject: "A last activity 1d",
  })
  await seedTicket({
    createdDaysAgo: 2,
    inbound: 10,
    outbound: 3,
    lastMessage: 3,
    subject: "B last activity 3d",
  })
  await seedTicket({
    createdDaysAgo: 6,
    inbound: 6,
    outbound: null,
    lastMessage: 6,
    subject: "C last activity 6d",
  })
  await seedTicket({
    createdDaysAgo: 4,
    inbound: null,
    outbound: 8,
    lastMessage: 8,
    subject: "D last activity 8d",
  })
})

const subjects = (res: { items: Array<Record<string, unknown>> }) =>
  res.items.map((r) => String(r.subject))

describe("tickets:search activity_newest / activity_oldest", () => {
  it("activity_newest orders by last_message_at, newest first (NOT created_at, NOT last_inbound_at)", async () => {
    await withSystemDb("sort-activity-newest", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_newest",
        limit: 10,
      } as never)
      expect(subjects(res)).toEqual([
        "A last activity 1d",
        "B last activity 3d",
        "C last activity 6d",
        "D last activity 8d",
      ])
    })
  })

  it("activity_oldest orders by last_message_at, oldest (longest-untouched) first", async () => {
    await withSystemDb("sort-activity-oldest", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_oldest",
        limit: 10,
      } as never)
      expect(subjects(res)).toEqual([
        "D last activity 8d",
        "C last activity 6d",
        "B last activity 3d",
        "A last activity 1d",
      ])
    })
  })

  it("activity_newest paginates correctly through the keyset cursor", async () => {
    await withSystemDb("sort-activity-page", async (tx) => {
      const page1 = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_newest",
        limit: 2,
      } as never)
      expect(subjects(page1)).toEqual(["A last activity 1d", "B last activity 3d"])
      expect(page1.nextCursor).toBeTruthy()

      const page2 = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_newest",
        limit: 2,
        cursor: page1.nextCursor,
      } as never)
      expect(subjects(page2)).toEqual(["C last activity 6d", "D last activity 8d"])
    })
  })

  it("activity_oldest paginates correctly (ascending keyset)", async () => {
    await withSystemDb("sort-activity-page-asc", async (tx) => {
      const page1 = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_oldest",
        limit: 2,
      } as never)
      expect(subjects(page1)).toEqual(["D last activity 8d", "C last activity 6d"])
      const page2 = await searchTickets(tx as never, orgId, {
        smartFilter: "all-open",
        sort: "activity_oldest",
        limit: 2,
        cursor: page1.nextCursor,
      } as never)
      expect(subjects(page2)).toEqual(["B last activity 3d", "A last activity 1d"])
    })
  })
})

describe("tickets:search activity_* sorts pass the tool input schema (manifest ↔ impl parity)", () => {
  // Regression: the inbox UI sends sort='activity_newest'/'activity_oldest' through
  // the tickets:search TOOL, which validates params against the manifest enum. The
  // searchTickets() unit tests bypass that schema, so a manifest that lists only
  // oldest/newest/recently_updated silently rejects the UI's request ("Invalid
  // parameters ... sort must be one of ...") and the inbox renders EMPTY. Exercise
  // the real tool bridge so the enum and the implementation can never drift again.
  it("accepts sort='activity_newest' through executeTool (not a validation error)", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "all-open", sort: "activity_newest", limit: 10 },
    })
    const data = out.data as { items: Array<{ subject: string }> }
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items[0]?.subject).toBe("A last activity 1d")
  })

  it("accepts sort='activity_oldest' through executeTool", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "all-open", sort: "activity_oldest", limit: 10 },
    })
    const data = out.data as { items: Array<{ subject: string }> }
    expect(data.items[0]?.subject).toBe("D last activity 8d")
  })
})

describe("tickets:search smartFilter='needs-attention' is keyed on message direction", () => {
  it("includes only tickets whose LAST message is inbound; excludes 'we replied last' (awaiting customer)", async () => {
    await withSystemDb("needs-attention-direction", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "needs-attention",
        limit: 10,
      } as never)
      const got = subjects(res).sort()
      // A + C: customer wrote last -> ball in our court. B: WE replied last
      // (awaiting customer) -> excluded. D: no inbound ever -> excluded.
      expect(got).toEqual(["A last activity 1d", "C last activity 6d"])
    })
  })

  it("excludes awaiting_followup even when the last message is inbound (setFollowup moves it to Follow-ups)", async () => {
    // Regression: setting a follow-up flips status to awaiting_followup but the
    // customer still has the last word (last message inbound). Direction alone
    // would keep it in "Needs attention now" AND in "Follow-ups" -- the explicit
    // deferral must win. It resurfaces via status change: followupCron reopens it
    // when due, and a new inbound message clears the follow-up and reopens.
    await seedTicket({
      createdDaysAgo: 5,
      inbound: 2,
      outbound: null,
      lastMessage: 2,
      subject: "E followup scheduled",
      status: "awaiting_followup",
    })
    await withSystemDb("needs-attention-followup", async (tx) => {
      const attention = await searchTickets(tx as never, orgId, {
        smartFilter: "needs-attention",
        limit: 10,
      } as never)
      expect(subjects(attention).sort()).toEqual(["A last activity 1d", "C last activity 6d"])

      const followups = await searchTickets(tx as never, orgId, {
        smartFilter: "follow-ups",
        limit: 10,
      } as never)
      expect(subjects(followups)).toContain("E followup scheduled")

      // The sidebar badge uses the same predicate via countOnly -- it must agree
      // with the list, not over-count deferred tickets.
      const count = await searchTickets(tx as never, orgId, {
        smartFilter: "needs-attention",
        countOnly: true,
        limit: 10,
      } as never)
      expect(count.totalCount).toBe(2)
    })
  })
})
