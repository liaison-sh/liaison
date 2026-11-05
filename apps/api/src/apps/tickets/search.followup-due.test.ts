// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (vip-mailbox-followup-scheduler-routine, BL-275): tickets:search(followup=scheduled)
// returns EVERY ticket with a scheduled follow-up (followupAt set) — BOTH the DUE ones (followupAt
// already in the past) AND the NOT-YET-DUE ones (followupAt in the future). The server computes
// DUE-ness per row as a `followupDue` boolean (followup_at <= now()) so the flash-lite routine tick
// RENDERS the discrimination instead of comparing the followupAt ISO timestamp to "now" in-context
// (which a weak tick mis-computes — the l710 lesson: move the discrimination server-side, the tick
// copies a boolean). A row with no scheduled follow-up returns NULL → undefined (never a misleading
// `false`). These tests pin: (1) followup=scheduled returns past+future follow-ups, (2) each row's
// followupDue boolean is true for past-due and false for future, (3) the camelCase projection surfaces
// it, (4) a no-followup row maps to undefined. FAILS-WITHOUT the server field (the tick would have no
// boolean to copy) / PASSES-WITH.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { toCamelTicket } from "~/apps/tickets/projection"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let inboxId: string
const HANDLES: Record<string, string> = {}

/** Seed an awaiting_followup ticket whose followup_at is `offsetDays` from now (negative = past = DUE,
 *  positive = future = NOT yet due, null = no scheduled follow-up). `status` overrides the derived
 *  status for the undated-awaiting_followup case (waiting on an unknown-date event, e.g. a restock). */
async function seedFollowup(
  handleKey: string,
  offsetDays: number | null,
  status?: "open" | "awaiting_followup",
): Promise<void> {
  const id = crypto.randomUUID()
  const handle = `fupdue-${handleKey}-${Math.floor(Math.random() * 1e10)}`
  HANDLES[handleKey] = handle
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-fupdue-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, followup_at, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Followup due test',
        ${(status ?? (offsetDays === null ? "open" : "awaiting_followup")) === "open" ? drizzleSql`'open'` : drizzleSql`'awaiting_followup'`},
        'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        NULL, 0, 1, ${inboxId},
        ${offsetDays === null ? drizzleSql`NULL` : drizzleSql`now() + (interval '1 day' * ${offsetDays})`},
        now() - interval '5 days', now() - interval '5 days', now() - interval '10 days', now()
      )
    `)
  })
}

beforeAll(async () => {
  const slug = `search-fupdue-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-fupdue-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Followup Due', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  await seedFollowup("due", -2) // followup 2 days in the PAST → DUE
  await seedFollowup("future", 3) // followup 3 days in the FUTURE → not yet due
  await seedFollowup("nofollowup", null) // open ticket, no scheduled follow-up
  // awaiting_followup with NO date: waiting on an unknown-date event (e.g. a restock).
  await seedFollowup("undated", null, "awaiting_followup")
})

// Regression: a ticket manually set to awaiting_followup with NO followup_at (the team is waiting
// on an event with an unknown date, e.g. a product restock) must STILL appear in the Follow-ups
// view. The smartFilter used to also require followup_at IS NOT NULL, which silently hid such
// tickets from the very section meant to remind the team to check on them.
describe("searchTickets — smartFilter 'follow-ups' is status-only (undated follow-ups included)", () => {
  it("returns awaiting_followup tickets whether or not a follow-up date is scheduled", async () => {
    await withSystemDb("search-fup-smartfilter", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        smartFilter: "follow-ups",
        limit: 50,
      } as never)
      const handles = new Set(res.items.map((r) => String((r as Record<string, unknown>).handle)))
      expect(handles.has(HANDLES.due!)).toBe(true)
      expect(handles.has(HANDLES.future!)).toBe(true)
      expect(handles.has(HANDLES.undated!)).toBe(true)
      // Non-awaiting_followup tickets stay out regardless of followup_at.
      expect(handles.has(HANDLES.nofollowup!)).toBe(false)
    })
  })
})

describe("searchTickets — followup=scheduled returns DUE + NOT-YET-DUE follow-ups", () => {
  it("followup:'scheduled' returns BOTH the past-due and the future (not-yet-due) follow-ups", async () => {
    await withSystemDb("search-fupdue-scope", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        followup: "scheduled",
        limit: 50,
      } as never)
      const handles = new Set(res.items.map((r) => String((r as Record<string, unknown>).handle)))
      expect(handles.has(HANDLES.due!)).toBe(true)
      expect(handles.has(HANDLES.future!)).toBe(true)
      // The ticket with NO scheduled follow-up is excluded (followup_at IS NULL).
      expect(handles.has(HANDLES.nofollowup!)).toBe(false)
    })
  })
})

// The decisive server-side discrimination for the vip-mailbox-followup-scheduler runtime gate: a tick
// that read followup:'scheduled' and judged due-ness in-context INVERTED the pick (drafted the future-
// dated items, skipped the due ones). followup:'due' returns ONLY the past-due follow-ups, so the tick
// acts on EXACTLY the due set and cannot mis-pick. FAILS-WITHOUT the 'due' filter / PASSES-WITH.
describe("searchTickets — followup=due returns ONLY the past-due (DUE NOW) follow-ups", () => {
  it("followup:'due' returns the past-due follow-up and EXCLUDES the future (not-yet-due) one", async () => {
    await withSystemDb("search-fupdue-only", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        followup: "due",
        limit: 50,
      } as never)
      const handles = new Set(res.items.map((r) => String((r as Record<string, unknown>).handle)))
      // The DUE (past followup_at) one is returned; the FUTURE one and the no-followup one are NOT.
      expect(handles.has(HANDLES.due!)).toBe(true)
      expect(handles.has(HANDLES.future!)).toBe(false)
      expect(handles.has(HANDLES.nofollowup!)).toBe(false)
      // Every returned row is genuinely due (followupDue true) — the server did the discrimination.
      for (const r of res.items) {
        expect(Boolean((r as Record<string, unknown>).followup_due)).toBe(true)
      }
    })
  })
})

describe("searchTickets — server-computed `followupDue` boolean", () => {
  it("each scheduled-follow-up row carries followupDue = (followup_at <= now()) — server does the discrimination", async () => {
    await withSystemDb("search-fupdue-bool", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        followup: "scheduled",
        limit: 50,
      } as never)
      const byHandle = new Map<string, Record<string, unknown>>()
      for (const r of res.items) byHandle.set(String((r as Record<string, unknown>).handle), r)
      // Past-due → true; future → false (the raw column comes back as `t`/`f` or boolean per driver).
      expect(Boolean((byHandle.get(HANDLES.due!) as Record<string, unknown>).followup_due)).toBe(
        true,
      )
      expect(Boolean((byHandle.get(HANDLES.future!) as Record<string, unknown>).followup_due)).toBe(
        false,
      )
    })
  })

  it("the camelCase projection surfaces followupDue so the tick RENDERS the boolean (no ISO date math)", async () => {
    await withSystemDb("search-fupdue-camel", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        followup: "scheduled",
        limit: 50,
      } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const due = camel.find((c) => c.handle === HANDLES.due)!
      const future = camel.find((c) => c.handle === HANDLES.future)!
      expect(due.followupDue).toBe(true)
      expect(future.followupDue).toBe(false)
      // Both still carry the raw followupAt for display / fallback.
      expect(typeof due.followupAt).toBe("string")
      expect(typeof future.followupAt).toBe("string")
    })
  })

  it("a row with NO scheduled follow-up maps followupDue to undefined (never a misleading `false`)", async () => {
    await withSystemDb("search-fupdue-null", async (tx) => {
      // Read the no-followup ticket via an open-status search (it's excluded from followup=scheduled).
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 50 } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const noFup = camel.find((c) => c.handle === HANDLES.nofollowup)!
      expect(noFup.followupAt).toBeNull()
      expect(noFup.followupDue).toBeUndefined()
    })
  })
})
