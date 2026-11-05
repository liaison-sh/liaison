// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: tickets:search returns a server-computed `ageDays` per row (whole days open, the same
// figure backlogHealth.oldest reports). An agent asked to flag tickets 'aging past N days' compares
// ageDays > N directly instead of doing fragile in-context date arithmetic over createdAt — which a
// weak routine tick mis-computed (flagging equal-age tickets inconsistently, or claiming every ticket
// was created 'today'), the aging-discrimination failure the liam-weekly-eu-language-backlog runtime
// gate caught. These tests pin that the field is present and matches floor((now − createdAt)/1 day).
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { toCamelTicket } from "~/apps/tickets/projection"
import { searchTickets } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"

let orgId: string
let inboxId: string
const HANDLES: Record<string, string> = {}

async function seedTicket(handleKey: string, ageDays: number): Promise<void> {
  const id = crypto.randomUUID()
  const handle = `age-${handleKey}-${Math.floor(Math.random() * 1e10)}`
  HANDLES[handleKey] = handle
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-age-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Age test', 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId},
        now() - (interval '1 day' * ${ageDays}), now() - (interval '1 day' * ${ageDays}),
        now() - (interval '1 day' * ${ageDays}), now() - (interval '1 day' * ${ageDays})
      )
    `)
  })
}

beforeAll(async () => {
  const slug = `search-age-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-age-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Age', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  await seedTicket("aged", 7) // 7 days old → aging past 3
  await seedTicket("fresh", 1) // 1 day old → not aging
})

async function seedLangTicket(handleKey: string, language: string | null): Promise<void> {
  const id = crypto.randomUUID()
  const handle = `lang-${handleKey}-${Math.floor(Math.random() * 1e10)}`
  HANDLES[handleKey] = handle
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-lang-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity, language,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, 'Lang test', 'open', 'normal', 'manual', 'internal', ${language},
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1, ${inboxId}, now(), now(), now(), now()
      )
    `)
  })
}

describe("searchTickets — server-side language filter (EU-language scope without in-context detection)", () => {
  it("filters by language code(s) — language:['fr','de','it'] excludes the English (en/NULL) noise", async () => {
    await seedLangTicket("fr", "fr")
    await seedLangTicket("de", "DE") // case-insensitive
    await seedLangTicket("it", "it")
    await seedLangTicket("en", "en")
    await seedLangTicket("untagged", null)
    await withSystemDb("search-lang-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        language: ["fr", "de", "it"],
        limit: 100,
      } as never)
      const handles = new Set(res.items.map((r) => String((r as Record<string, unknown>).handle)))
      expect(handles.has(HANDLES.fr!)).toBe(true)
      expect(handles.has(HANDLES.de!)).toBe(true) // 'DE' matched case-insensitively
      expect(handles.has(HANDLES.it!)).toBe(true)
      // English and untagged tickets are EXCLUDED — the EU-language scope is exact.
      expect(handles.has(HANDLES.en!)).toBe(false)
      expect(handles.has(HANDLES.untagged!)).toBe(false)
      // Each returned row carries its language for display.
      for (const r of res.items) {
        const lang = (r as Record<string, unknown>).language
        if (lang != null) expect(["fr", "de", "it"]).toContain(String(lang).toLowerCase())
      }
    })
  })

  it("a single language code also filters", async () => {
    await withSystemDb("search-lang-single", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { language: "fr", limit: 100 } as never)
      const handles = new Set(res.items.map((r) => String((r as Record<string, unknown>).handle)))
      expect(handles.has(HANDLES.fr!)).toBe(true)
      expect(handles.has(HANDLES.de!)).toBe(false)
    })
  })
})

describe("searchTickets — server-computed ageDays per row", () => {
  it("returns ageDays = whole days since createdAt on each row", async () => {
    await withSystemDb("search-age-run", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 50 } as never)
      const byHandle = new Map<string, Record<string, unknown>>()
      for (const r of res.items) byHandle.set(String((r as Record<string, unknown>).handle), r)
      const aged = byHandle.get(HANDLES.aged!)!
      const fresh = byHandle.get(HANDLES.fresh!)!
      expect(Number((aged as Record<string, unknown>).age_days)).toBe(7)
      expect(Number((fresh as Record<string, unknown>).age_days)).toBe(1)
    })
  })

  it("the camelCase projection surfaces ageDays so the agent can compare ageDays > N", async () => {
    await withSystemDb("search-age-camel", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 50 } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      const aged = camel.find((c) => c.handle === HANDLES.aged)!
      const fresh = camel.find((c) => c.handle === HANDLES.fresh)!
      expect(aged.ageDays).toBe(7)
      expect(fresh.ageDays).toBe(1)
      // The aging discrimination the agent does: ageDays > 3.
      expect((aged.ageDays ?? 0) > 3).toBe(true)
      expect((fresh.ageDays ?? 0) > 3).toBe(false)
    })
  })
})

describe("searchTickets — server-computed `aging` boolean (default threshold 3)", () => {
  it("each row carries aging = (ageDays > 3) by default — the server does the discrimination", async () => {
    await withSystemDb("search-aging-default", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 50 } as never)
      const byHandle = new Map<string, Record<string, unknown>>()
      for (const r of res.items) byHandle.set(String((r as Record<string, unknown>).handle), r)
      // 7-day ticket → aging true; 1-day ticket → aging false. (Boolean comes back from PG as `t`/`f`
      // or boolean depending on driver; Boolean(...) on the raw is the projection's contract.)
      expect(Boolean((byHandle.get(HANDLES.aged!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((byHandle.get(HANDLES.fresh!) as Record<string, unknown>).aging)).toBe(false)
    })
  })

  it("the camelCase projection surfaces `aging` so the agent RENDERS the boolean (no in-context compare)", async () => {
    await withSystemDb("search-aging-camel", async (tx) => {
      const res = await searchTickets(tx as never, orgId, { status: "open", limit: 50 } as never)
      const camel = res.items.map((r) => toCamelTicket(r as Record<string, unknown>))
      expect(camel.find((c) => c.handle === HANDLES.aged)!.aging).toBe(true)
      expect(camel.find((c) => c.handle === HANDLES.fresh)!.aging).toBe(false)
    })
  })

  it("agingThresholdDays moves the boundary — threshold 5: 7d aging, 1d not; threshold 10: neither aging", async () => {
    await withSystemDb("search-aging-threshold", async (tx) => {
      const at5 = await searchTickets(tx as never, orgId, {
        status: "open",
        limit: 50,
        agingThresholdDays: 5,
      } as never)
      const m5 = new Map(at5.items.map((r) => [String((r as Record<string, unknown>).handle), r]))
      expect(Boolean((m5.get(HANDLES.aged!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((m5.get(HANDLES.fresh!) as Record<string, unknown>).aging)).toBe(false)

      const at10 = await searchTickets(tx as never, orgId, {
        status: "open",
        limit: 50,
        agingThresholdDays: 10,
      } as never)
      const m10 = new Map(at10.items.map((r) => [String((r as Record<string, unknown>).handle), r]))
      // 7d is NOT older than 10d → not aging; 1d obviously not.
      expect(Boolean((m10.get(HANDLES.aged!) as Record<string, unknown>).aging)).toBe(false)
      expect(Boolean((m10.get(HANDLES.fresh!) as Record<string, unknown>).aging)).toBe(false)
    })
  })

  it("agingThresholdDays 0 flags every open ticket (any age > 0 days) — boundary is inclusive-exclusive at >threshold", async () => {
    await withSystemDb("search-aging-zero", async (tx) => {
      const res = await searchTickets(tx as never, orgId, {
        status: "open",
        limit: 50,
        agingThresholdDays: 0,
      } as never)
      const m = new Map(res.items.map((r) => [String((r as Record<string, unknown>).handle), r]))
      // Both the 7d and 1d tickets have ageDays > 0 → aging.
      expect(Boolean((m.get(HANDLES.aged!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((m.get(HANDLES.fresh!) as Record<string, unknown>).aging)).toBe(true)
    })
  })

  it("a non-finite / negative agingThresholdDays is clamped (defaults to 3, never injects) — no crash, sane boolean", async () => {
    await withSystemDb("search-aging-bad", async (tx) => {
      // NaN → default 3 (7d aging, 1d not). Negative → clamped to 0 (everything aging). Either way no throw.
      const nanRes = await searchTickets(tx as never, orgId, {
        status: "open",
        limit: 50,
        agingThresholdDays: Number.NaN,
      } as never)
      const mNan = new Map(
        nanRes.items.map((r) => [String((r as Record<string, unknown>).handle), r]),
      )
      expect(Boolean((mNan.get(HANDLES.aged!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((mNan.get(HANDLES.fresh!) as Record<string, unknown>).aging)).toBe(false)
    })
  })
})

// The liam-weekly-eu-language-backlog routine TICK reproduction (journey liam_week_support S1,
// journey 17/20): the tick authors tickets:search with smartFilter='all-open' + language=['fr','de','it']
// + assignedTo=<liam> + agingThresholdDays=3, expecting the WHOLE non-closed EU-language backlog (open
// AND awaiting_customer AND awaiting_followup). A journey run's tick digest OMITTED the OPEN status group
// entirely (dropping 2 of the 4 seeded aging tickets → routine-execution gate override). This pins that
// the EXACT query combination returns the open-status tickets — a query bug (all-open + language +
// assignedTo silently dropping the open group) would be caught HERE, isolating it from the model's tick
// rendering.
describe("searchTickets — all-open + language + assignedTo returns EVERY non-closed status (liam-weekly-eu-language-backlog tick)", () => {
  let backlogOrgId: string
  let backlogInboxId: string
  const assignee = crypto.randomUUID()
  const BH: Record<string, string> = {}

  async function seedBacklogTicket(
    key: string,
    status: "open" | "awaiting_customer" | "awaiting_followup" | "closed",
    language: string,
    ageDays: number,
  ): Promise<void> {
    const id = crypto.randomUUID()
    const handle = `bh-${key}-${Math.floor(Math.random() * 1e10)}`
    BH[key] = handle
    const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
    const followupClause =
      status === "awaiting_followup" ? drizzleSql`now() + interval '2 days'` : drizzleSql`NULL`
    await withSystemDb("search-backlog-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, language,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, source_inbox_id, assigned_to, followup_at,
          last_inbound_at, last_message_at, created_at, updated_at
        ) VALUES (
          ${id}, ${backlogOrgId}, ${handle}, 'Backlog test', ${status}, 'normal', 'manual', 'internal', ${language},
          ${replyToken}, 3600, now() + interval '1 hour', now(), 0,
          1, ${backlogInboxId}, ${assignee}, ${followupClause},
          now() - (interval '1 day' * ${ageDays}), now() - (interval '1 day' * ${ageDays}),
          now() - (interval '1 day' * ${ageDays}), now() - (interval '1 day' * ${ageDays})
        )
      `)
    })
  }

  beforeAll(async () => {
    const slug = `search-backlog-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await withSystemDb("search-backlog-fixture", async (tx) => {
      const orgRows = (await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Search Backlog', ${slug}) RETURNING id
      `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
      backlogOrgId = (orgRows.rows ?? orgRows)[0]!.id
      const inboxRows = (await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${backlogOrgId}, gen_random_uuid(), 'Inbox', ${`in-${slug}@x.test`}, 'internal', true, now(), now()) RETURNING id
      `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
      backlogInboxId = (inboxRows.rows ?? inboxRows)[0]!.id
    })
    // Mirror liamEuBacklogSlice: aging (>3d) OPEN + awaiting_followup, fresh (<3d) awaiting_customer, and
    // an English + a non-assignee decoy that must be EXCLUDED.
    await seedBacklogTicket("open-fr-aging", "open", "fr", 6) // must appear + aging
    await seedBacklogTicket("open-fr-aging2", "open", "fr", 7) // must appear + aging
    await seedBacklogTicket("awc-it-fresh", "awaiting_customer", "it", 2) // must appear, not aging
    await seedBacklogTicket("awf-de-aging", "awaiting_followup", "de", 9) // must appear + aging
    await seedBacklogTicket("open-en-decoy", "open", "en", 5) // EN → excluded by language
  })

  it("all-open + language:['fr','de','it'] + assignedTo returns the OPEN status tickets (the dropped group), plus awaiting_customer + awaiting_followup, and flags the >3d ones", async () => {
    await withSystemDb("search-backlog-run", async (tx) => {
      const res = await searchTickets(tx as never, backlogOrgId, {
        smartFilter: "all-open",
        language: ["fr", "de", "it"],
        assignedTo: assignee,
        agingThresholdDays: 3,
        limit: 100,
      } as never)
      const m = new Map(res.items.map((r) => [String((r as Record<string, unknown>).handle), r]))
      // THE REGRESSION: the OPEN status group must be present (the tick dropped it).
      expect(m.has(BH["open-fr-aging"]!)).toBe(true)
      expect(m.has(BH["open-fr-aging2"]!)).toBe(true)
      // ... alongside the other non-closed statuses.
      expect(m.has(BH["awc-it-fresh"]!)).toBe(true)
      expect(m.has(BH["awf-de-aging"]!)).toBe(true)
      // The English decoy is excluded by the language filter.
      expect(m.has(BH["open-en-decoy"]!)).toBe(false)
      // Aging discrimination holds on the returned rows: the >3d ones flag, the 2d one does not.
      expect(Boolean((m.get(BH["open-fr-aging"]!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((m.get(BH["awf-de-aging"]!) as Record<string, unknown>).aging)).toBe(true)
      expect(Boolean((m.get(BH["awc-it-fresh"]!) as Record<string, unknown>).aging)).toBe(false)
      // Every returned row carries its status so the digest can group by it (all three groups present).
      const statuses = new Set(res.items.map((r) => String((r as Record<string, unknown>).status)))
      expect(statuses.has("open")).toBe(true)
      expect(statuses.has("awaiting_customer")).toBe(true)
      expect(statuses.has("awaiting_followup")).toBe(true)
    })
  })
})
