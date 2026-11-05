// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { type SlaReportError, type SlaReportResult, slaReport } from "~/apps/tickets/sla-report"
import { extractRows, type PrivilegedDb } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

// The privileged db satisfies the runtime SqlClient contract (raw .execute);
// narrow its query-builder type to the interface slaReport consumes.
const sqlDb = db as unknown as PrivilegedDb

/** Narrow the union — fail loudly if an error envelope came back. */
function ok(out: SlaReportResult | SlaReportError): SlaReportResult {
  if ("error" in out) throw new Error(`expected success, got error: ${out.error.code}`)
  return out
}

interface SlaTicketSpec {
  /** ticket opened this many days ago (and its SLA clock started then). */
  daysAgo: number
  /** assignee email or null (unassigned). */
  assignee: string | null
  /**
   * sla_deadline expressed in HOURS from NOW: negative = a deadline already in
   * the past (breached when answered late / unanswered), positive = future
   * (met). Absolute-to-now so the breach set is unambiguous regardless of age.
   */
  deadlineHoursFromNow: number
  /**
   * first_response_at in HOURS from NOW: negative = answered that many hours ago,
   * null = never answered. The margin is firstResponse − deadline.
   */
  firstResponseHoursFromNow: number | null
  status: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
  subject: string
}

/**
 * Self-contained SLA-report fixture. Three agents, a known spread of tickets
 * across the window with deterministic deadlines + first-response times so the
 * breach set, margins, per-agent counts, and attainment rate are all EXACT.
 */
async function withSlaFixture<T>(
  specs: SlaTicketSpec[],
  fn: (f: { orgId: string; agents: Record<string, string> }) => Promise<T>,
): Promise<T> {
  const slug = `sla-report-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'SLA Report Org', ${slug}) RETURNING id
    `),
  )
  const orgId = org.id
  await ensureAppsForOrg(orgId, {})

  const agents: Record<string, string> = {}
  for (const name of ["Avery", "Bjorn", "Cleo"]) {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`${name.toLowerCase()}-${slug}@test.com`}, ${name}, 'active', 'hash', 1, 1) RETURNING id
      `),
    )
    agents[name] = u.id
  }

  await withSystemDb("sla-report-fixture", async (tx) => {
    let seq = 0
    for (const s of specs) {
      const handle = `slar-${slug}-${seq}`
      const replyToken = `SLAR${slug.slice(-6)}${seq.toString().padStart(4, "0")}`
      const assigneeId = s.assignee ? agents[s.assignee] : null
      const frClause =
        s.firstResponseHoursFromNow === null
          ? drizzleSql`NULL`
          : drizzleSql`now() + (${s.firstResponseHoursFromNow} * interval '1 hour')`
      seq++
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds,
          sla_deadline, sla_active_started_at, sla_elapsed_seconds, message_count,
          assigned_to, first_response_at,
          last_inbound_at, last_message_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, ${s.subject}, ${s.status}, 'normal', 'email', 'internal',
          ${replyToken}, 3600,
          now() + (${s.deadlineHoursFromNow} * interval '1 hour'),
          now() - (${s.daysAgo} * interval '1 day'), 0, 1,
          ${assigneeId}, ${frClause},
          now() - (${s.daysAgo} * interval '1 day'), now() - (${s.daysAgo} * interval '1 day'),
          now() - (${s.daysAgo} * interval '1 day'), now()
        )
      `)
    }
  })

  return fn({ orgId, agents })
}

// The canonical scenario fixture shape: ~9 tickets in the last 7 days, with a
// known breach set across 3 agents so the rate + per-agent split is exact.
// Breached = answered late (firstResponse after deadline) OR past deadline & unanswered.
const SCENARIO_SPECS: SlaTicketSpec[] = [
  // Avery — 2 breaches + 1 on-time
  {
    daysAgo: 6,
    assignee: "Avery",
    deadlineHoursFromNow: -9,
    firstResponseHoursFromNow: -4, // answered 4h ago, deadline 9h ago → 5h late
    status: "closed",
    subject: "Avery late A",
  },
  {
    daysAgo: 5,
    assignee: "Avery",
    deadlineHoursFromNow: -6,
    firstResponseHoursFromNow: -4, // 2h late
    status: "awaiting_customer",
    subject: "Avery late B",
  },
  {
    daysAgo: 4,
    assignee: "Avery",
    deadlineHoursFromNow: 40, // future deadline → not breached
    firstResponseHoursFromNow: -2, // answered before deadline
    status: "closed",
    subject: "Avery on-time",
  },
  // Bjorn — 1 breach (still unanswered, past deadline) + 1 on-time
  {
    daysAgo: 3,
    assignee: "Bjorn",
    deadlineHoursFromNow: -50,
    firstResponseHoursFromNow: null, // never answered → ongoing breach
    status: "open",
    subject: "Bjorn unanswered breach",
  },
  {
    daysAgo: 2,
    assignee: "Bjorn",
    deadlineHoursFromNow: 70, // future → not breached
    firstResponseHoursFromNow: -1,
    status: "awaiting_customer",
    subject: "Bjorn on-time",
  },
  // Cleo — 1 breach + 1 on-time
  {
    daysAgo: 1,
    assignee: "Cleo",
    deadlineHoursFromNow: -4,
    firstResponseHoursFromNow: -1, // 3h late
    status: "open",
    subject: "Cleo late",
  },
  {
    daysAgo: 1,
    assignee: "Cleo",
    deadlineHoursFromNow: 90, // future → not breached
    firstResponseHoursFromNow: -2,
    status: "open",
    subject: "Cleo on-time",
  },
  // Unassigned — 1 breach
  {
    daysAgo: 2,
    assignee: null,
    deadlineHoursFromNow: -5,
    firstResponseHoursFromNow: null, // unanswered, past deadline → ongoing breach
    status: "open",
    subject: "Unassigned breach",
  },
  // An OLD ticket OUTSIDE the 7-day window that breached — must NOT count in the 7d window.
  {
    daysAgo: 30,
    assignee: "Avery",
    deadlineHoursFromNow: -1,
    firstResponseHoursFromNow: 100,
    status: "closed",
    subject: "Old out-of-window breach",
  },
]

describe("tickets.slaReport", () => {
  it("computes EXACT breach count + attainment rate over the 7-day window (excludes out-of-window)", async () => {
    await withSlaFixture(SCENARIO_SPECS, async ({ orgId }) => {
      const out = ok(await slaReport(sqlDb, orgId))
      expect(out.authoritative).toBe(true)
      expect(out.windowDays).toBe(7)
      // 8 in-window (the 30d-old one excluded), 5 breached (Avery×2, Bjorn×1, Cleo×1, unassigned×1).
      expect(out.totalInWindow).toBe(8)
      expect(out.breachedCount).toBe(5)
      expect(out.metCount).toBe(3)
      // 3/8 met = 37.5%
      expect(out.attainmentRatePct).toBe(37.5)
    })
  })

  it("computes per-agent breach counts with names, including an unassigned bucket", async () => {
    await withSlaFixture(SCENARIO_SPECS, async ({ orgId }) => {
      const out = ok(await slaReport(sqlDb, orgId))
      const byName = (n: string | null) =>
        out.perAgent.find((r) => r.assigneeName === n)?.breachCount ?? 0
      expect(byName("Avery")).toBe(2)
      expect(byName("Bjorn")).toBe(1)
      expect(byName("Cleo")).toBe(1)
      // unassigned breach → a row with null name
      const unassigned = out.perAgent.find((r) => r.assignee === null)
      expect(unassigned?.breachCount).toBe(1)
      expect(unassigned?.assigneeName).toBeNull()
      // Descending order → Avery (2) is first.
      expect(out.perAgent[0]?.assigneeName).toBe("Avery")
    })
  })

  it("surfaces every breached ticket with its breach margin (how late first response was)", async () => {
    await withSlaFixture(SCENARIO_SPECS, async ({ orgId }) => {
      const out = ok(await slaReport(sqlDb, orgId))
      expect(out.breachedTickets.length).toBe(5)
      // Avery late A: deadline = open+4h, first response = open+9h → 5h late.
      const averyA = out.breachedTickets.find((t) => t.subject === "Avery late A")
      expect(averyA?.breachMarginHours).toBeCloseTo(5, 1)
      expect(averyA?.stillUnanswered).toBe(false)
      expect(averyA?.assigneeName).toBe("Avery")
      // Cleo late: deadline open+1h, first response open+4h → 3h late.
      const cleo = out.breachedTickets.find((t) => t.subject === "Cleo late")
      expect(cleo?.breachMarginHours).toBeCloseTo(3, 1)
      // Bjorn unanswered: never answered, deadline ~3d ago → margin is ongoing (large) & stillUnanswered.
      const bjorn = out.breachedTickets.find((t) => t.subject === "Bjorn unanswered breach")
      expect(bjorn?.stillUnanswered).toBe(true)
      expect(bjorn?.firstResponseAt).toBeNull()
      expect(bjorn?.breachMarginSeconds).toBeGreaterThan(0)
      // Most-overdue first → the unanswered multi-day breaches outrank the few-hours-late ones.
      expect(out.breachedTickets[0]?.breachMarginSeconds).toBeGreaterThanOrEqual(
        out.breachedTickets[1]?.breachMarginSeconds ?? 0,
      )
      // An on-time ticket never appears in the breach list.
      expect(out.breachedTickets.some((t) => t.subject === "Avery on-time")).toBe(false)
    })
  })

  it("returns attainmentRatePct=null (not a fabricated rate) when the window is empty", async () => {
    await withSlaFixture([], async ({ orgId }) => {
      const out = ok(await slaReport(sqlDb, orgId))
      expect(out.totalInWindow).toBe(0)
      expect(out.breachedCount).toBe(0)
      expect(out.attainmentRatePct).toBeNull()
      expect(out.breachedTickets).toEqual([])
      expect(out.perAgent).toEqual([])
    })
  })

  it("honors a custom windowDays — a wider window pulls in the old breach", async () => {
    await withSlaFixture(SCENARIO_SPECS, async ({ orgId }) => {
      const out = ok(await slaReport(sqlDb, orgId, { windowDays: 60 }))
      // Now the 30d-old breached ticket is in-window → 9 total, 6 breached.
      expect(out.windowDays).toBe(60)
      expect(out.totalInWindow).toBe(9)
      expect(out.breachedCount).toBe(6)
    })
  })

  it("rejects an out-of-range windowDays with a loud error (no silent clamp)", async () => {
    await withSlaFixture([], async ({ orgId }) => {
      const tooBig = await slaReport(sqlDb, orgId, { windowDays: 9999 })
      expect("error" in tooBig).toBe(true)
      if ("error" in tooBig) expect(tooBig.error.code).toBe("invalid_window")
      const zero = await slaReport(sqlDb, orgId, { windowDays: 0 })
      expect("error" in zero).toBe(true)
      const frac = await slaReport(sqlDb, orgId, { windowDays: 1.5 })
      expect("error" in frac).toBe(true)
    })
  })

  it("isolates by org — a second org's breaches never bleed in", async () => {
    await withSlaFixture(SCENARIO_SPECS, async ({ orgId }) => {
      // A second fixture org exists concurrently; assert THIS org's totals are
      // exactly its own (org-scoped aggregate, not a global tally).
      await withSlaFixture(SCENARIO_SPECS, async () => {
        const out = ok(await slaReport(sqlDb, orgId))
        expect(out.totalInWindow).toBe(8)
        expect(out.breachedCount).toBe(5)
      })
    })
  })
})
