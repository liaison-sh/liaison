// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  type BacklogHealthError,
  type BacklogHealthResult,
  backlogHealth,
} from "~/apps/tickets/backlog-health"
import { extractRows, type PrivilegedDb } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

// The privileged db satisfies the runtime SqlClient contract (raw .execute);
// narrow its query-builder type to the interface backlogHealth consumes.
const sqlDb = db as unknown as PrivilegedDb

/** Narrow the union — fail loudly if an error envelope came back. */
function ok(out: BacklogHealthResult | BacklogHealthError): BacklogHealthResult {
  if ("error" in out) throw new Error(`expected success, got error: ${out.error.code}`)
  return out
}

/**
 * Self-contained backlog-health fixture: one org, two categories, and a known
 * spread of tickets across statuses, ages, and assignment — so the aggregate's
 * counts, age buckets, and oldest pick are EXACT and assertable.
 */
async function withBacklogFixture<T>(
  fn: (f: { orgId: string; catFirmwareId: string; catSetupId: string }) => Promise<T>,
): Promise<T> {
  const slug = `backlog-health-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Backlog Health Org', ${slug}) RETURNING id
    `),
  )
  const orgId = org.id
  await ensureAppsForOrg(orgId, {})

  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`bh-${slug}@test.com`}, 'BH Tester', 'active', 'hash', 1, 1) RETURNING id
    `),
  )
  const assigneeId = user.id

  let catFirmwareId = ""
  let catSetupId = ""
  await withSystemDb("backlog-health-fixture", async (tx) => {
    const [firmware] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.categories (id, org_id, name, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'Firmware', 1, now(), now()) RETURNING id
      `),
    )
    const [setup] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.categories (id, org_id, name, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'Setup', 2, now(), now()) RETURNING id
      `),
    )
    catFirmwareId = firmware.id
    catSetupId = setup.id

    // [status, daysAgo, categoryId|null, assigned, subject]
    const rows: Array<{
      status: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
      daysAgo: number
      categoryId: string | null
      assigned: boolean
      subject: string
    }> = [
      // Firmware — the bunch (4 live + 1 closed that must NOT count)
      { status: "open", daysAgo: 2, categoryId: catFirmwareId, assigned: true, subject: "fw a" },
      { status: "open", daysAgo: 10, categoryId: catFirmwareId, assigned: false, subject: "fw b" },
      {
        status: "awaiting_customer",
        daysAgo: 5,
        categoryId: catFirmwareId,
        assigned: true,
        subject: "fw c",
      },
      {
        status: "awaiting_followup",
        daysAgo: 20,
        categoryId: catFirmwareId,
        assigned: true,
        subject: "fw d",
      },
      {
        status: "closed",
        daysAgo: 3,
        categoryId: catFirmwareId,
        assigned: true,
        subject: "fw closed",
      },
      // Setup (2 live)
      { status: "open", daysAgo: 1, categoryId: catSetupId, assigned: false, subject: "setup a" },
      {
        status: "awaiting_customer",
        daysAgo: 40,
        categoryId: catSetupId,
        assigned: true,
        subject: "setup oldest",
      },
      // Uncategorized (1 live)
      { status: "open", daysAgo: 8, categoryId: null, assigned: false, subject: "uncat a" },
    ]

    let seq = 0
    for (const r of rows) {
      const handle = `bh-${slug}-${seq}`
      const replyToken = `BHT${slug.slice(-6)}${seq.toString().padStart(4, "0")}`
      seq++
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds, sla_deadline,
          sla_active_started_at, sla_elapsed_seconds, message_count,
          category_id, assigned_to, last_inbound_at, last_message_at,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, ${r.subject}, ${r.status}, 'normal', 'manual', 'internal',
          ${replyToken}, 3600, now() + interval '1 hour',
          now(), 0, 1,
          ${r.categoryId}, ${r.assigned ? assigneeId : null},
          now() - (${r.daysAgo} * interval '1 day'), now() - (${r.daysAgo} * interval '1 day'),
          now() - (${r.daysAgo} * interval '1 day'), now()
        )
      `)
    }
  })

  return fn({ orgId, catFirmwareId, catSetupId })
}

describe("tickets.backlogHealth", () => {
  it("returns EXACT status counts over the whole live backlog, excluding closed", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      const out = ok(await backlogHealth(sqlDb, orgId))
      // 8 seeded, 1 closed → 7 live. open: fw a, fw b, setup a, uncat a = 4.
      expect(out.byStatus.open).toBe(4)
      expect(out.byStatus.awaitingCustomer).toBe(2) // fw c, setup oldest
      expect(out.byStatus.awaitingFollowup).toBe(1) // fw d
      expect(out.byStatus.totalOpen).toBe(7)
      expect(out.authoritative).toBe(true)
    })
  })

  it("groups by category — Firmware is the bunch, uncategorized surfaces as a row", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      const out = ok(await backlogHealth(sqlDb, orgId))
      const firmware = out.byCategory.find((c) => c.categoryName === "Firmware")
      const setup = out.byCategory.find((c) => c.categoryName === "Setup")
      const uncat = out.byCategory.find((c) => c.categoryName === "Uncategorized")
      // Firmware live (excludes the closed one): fw a, fw b, fw c, fw d = 4.
      expect(firmware?.open).toBe(4)
      expect(setup?.open).toBe(2)
      expect(uncat?.open).toBe(1)
      // Sorted by count desc → Firmware first (the bunch).
      expect(out.byCategory[0]?.categoryName).toBe("Firmware")
    })
  })

  it("buckets by age and names the single oldest open ticket authoritatively", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      const out = ok(await backlogHealth(sqlDb, orgId))
      // Oldest live ticket is 'setup oldest' at 40 days (the closed 3d one excluded).
      expect(out.oldest[0]?.subject).toBe("setup oldest")
      expect(out.oldest[0]?.ageDays).toBe(40)
      // Age buckets: 0-7d = fw a(2), fw c(5), setup a(1) = 3; 7-14d = fw b(10), uncat a(8) = 2;
      // 14-30d = fw d(20) = 1; 30d+ = setup oldest(40) = 1.
      const bucket = (b: string) => out.byAge.find((x) => x.bucket === b)?.open
      expect(bucket("0-7d")).toBe(3)
      expect(bucket("7-14d")).toBe(2)
      expect(bucket("14-30d")).toBe(1)
      expect(bucket("30d+")).toBe(1)
    })
  })

  it("counts unassigned open tickets", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      const out = ok(await backlogHealth(sqlDb, orgId))
      // Unassigned live: fw b, setup a, uncat a = 3.
      expect(out.unassignedOpen).toBe(3)
    })
  })

  it("rejects an unknown team with a loud error instead of authoritative zeros", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      // The seeded tickets carry no team, so ANY team filter is unknown. The
      // tool MUST NOT return authoritative:true with all-zeros (the bug that
      // let the agent declare it broken and fabricate a total) — it errors.
      const out = await backlogHealth(sqlDb, orgId, { team: "support-eu" })
      expect("error" in out).toBe(true)
      if ("error" in out) {
        expect(out.error.code).toBe("unknown_team")
        expect(out.error.message).toContain("support-eu")
      }
    })
  })

  it("scopes to a real team and reports scopedTeam", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      // Tag one live ticket with a team so it becomes a known team.
      await withSystemDb("backlog-health-team-tag", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE app_tickets.tickets SET team = 'support-eu'
          WHERE org_id = ${orgId} AND status <> 'closed'
            AND id = (SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND status <> 'closed' LIMIT 1)
        `)
      })
      const out = await backlogHealth(sqlDb, orgId, { team: "support-eu" })
      expect("error" in out).toBe(false)
      if (!("error" in out)) {
        expect(out.scopedTeam).toBe("support-eu")
        expect(out.byStatus.totalOpen).toBe(1)
      }
    })
  })

  it("isolates by org — a second org's backlog never bleeds in", async () => {
    await withBacklogFixture(async ({ orgId }) => {
      // A second fixture org exists concurrently; assert THIS org's totals are
      // exactly its own (RLS/org-scoped GROUP BY, not a global tally).
      await withBacklogFixture(async () => {
        const out = ok(await backlogHealth(sqlDb, orgId))
        expect(out.byStatus.totalOpen).toBe(7)
      })
    })
  })

  it("the base fixture (no SLA pressure) reports bySla all-zero — present, not absent", async () => {
    // Regression: the field is always present so a war-room/briefing read can
    // distinguish a real 0 from 'not measured'. The base fixture's tickets all
    // carry a far-future deadline → neither approaching nor breached.
    await withBacklogFixture(async ({ orgId }) => {
      const out = ok(await backlogHealth(sqlDb, orgId))
      expect(out.bySla).toBeDefined()
      expect(out.bySla.approaching).toBe(0)
      expect(out.bySla.breached).toBe(0)
      expect(out.bySla.approachingTop).toEqual([])
      expect(out.bySla.breachedTop).toEqual([])
    })
  })

  it("bySla reports EXACT approaching + breached counts with named exemplars (SLA-fire regression — closes the warroom fabricated-negative)", async () => {
    // Seed 1 APPROACHING (unanswered, deadline within the last 25% of the window),
    // 2 BREACHED (one recorded breach, one past-deadline), and 1 HEALTHY (answered,
    // far-future deadline). Asserts bySla matches the SAME predicates as
    // tickets:search slaApproaching/slaBreached, so a single backlogHealth read
    // truthfully answers 'any SLA breaches / what's at risk' — the fabricated
    // negative the modular-expo war-room briefing hit when the agent inferred
    // 0 breaches from the ABSENCE of an SLA field.
    const slug = `bh-sla-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Backlog SLA Org', ${slug}) RETURNING id
      `),
    )
    const orgId = org.id
    await ensureAppsForOrg(orgId, {})

    // sla fragment = (sla_deadline, sla_breached_at, first_response_at); sla_paused_at always NULL.
    // sla_target_seconds 3600 → approaching window = the last 900s before the deadline.
    const tix: Array<{ key: string; subject: string; sla: ReturnType<typeof drizzleSql> }> = [
      {
        key: "approaching",
        subject: "SLA approaching — unanswered, deadline in 5 min",
        sla: drizzleSql`now() + interval '5 minutes', NULL, NULL`,
      },
      {
        key: "breached_recorded",
        subject: "SLA breached — recorded breach timestamp",
        sla: drizzleSql`now() - interval '2 hours', now() - interval '1 hour', NULL`,
      },
      {
        key: "breached_pastdeadline",
        subject: "SLA breached — deadline already past, not paused",
        sla: drizzleSql`now() - interval '30 minutes', NULL, NULL`,
      },
      {
        key: "healthy",
        subject: "Healthy — answered, far-future deadline",
        sla: drizzleSql`now() + interval '10 hours', NULL, now() - interval '20 hours'`,
      },
    ]
    await withSystemDb("backlog-health-sla-fixture", async (tx) => {
      let seq = 0
      for (const t of tix) {
        const handle = `${slug}-${t.key}`
        const replyToken = `BHS${slug.slice(-6)}${seq.toString().padStart(4, "0")}`
        seq++
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_breached_at, first_response_at,
            sla_paused_at, sla_active_started_at, sla_elapsed_seconds, message_count,
            last_inbound_at, last_message_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${handle}, ${t.subject}, 'open', 'high', 'manual', 'internal',
            ${replyToken}, 3600, ${t.sla},
            NULL, now(), 0, 1,
            now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now()
          )
        `)
      }
    })

    const out = ok(await backlogHealth(sqlDb, orgId))
    // Exactly 1 approaching, 2 breached. Healthy is in neither; the approaching
    // one is NOT double-counted as breached (the sets are disjoint).
    expect(out.bySla.approaching).toBe(1)
    expect(out.bySla.breached).toBe(2)
    expect(out.bySla.approachingTop).toHaveLength(1)
    expect(out.bySla.approachingTop[0]?.handle).toBe(`${slug}-approaching`)
    expect(out.bySla.breachedTop).toHaveLength(2)
    const breachedHandles = out.bySla.breachedTop.map((t) => t.handle).sort()
    expect(breachedHandles).toEqual(
      [`${slug}-breached_pastdeadline`, `${slug}-breached_recorded`].sort(),
    )
  })

  it("serializes the SLA counts in the HEAD — bySla survives a 2000-char head-truncation of the tool output (field-order regression)", async () => {
    // The chaos judge head-truncates each serialized tool output at ~2000 chars
    // (LIAISON_CHAOS_JUDGE_TOOLOUT_CAP default), and a weak agent model attends to
    // the head. backlogHealth's authoritative SLA counts live in `bySla`; if they
    // serialize AFTER the bulky arrays (byCategory / byAge / oldest), a backlog with
    // a healthy spread of open tickets pushes `bySla` past the cap and it is
    // guillotined off — so the consumer "sees no SLA field" and treats the count as
    // unmeasured/fabricated (exactly the black-friday war-room failure). This
    // asserts the COMPACT counts (byStatus + bySla) lead the object so the SLA lane
    // is always visible in the head, regardless of how many oldest/category rows
    // trail behind. Fails if a future edit reorders bySla after the lists.
    const slug = `bh-head-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Backlog Head Org', ${slug}) RETURNING id
      `),
    )
    const orgId = org.id
    await ensureAppsForOrg(orgId, {})

    // 12 open tickets with realistically long subjects (so `oldest` + `byCategory`
    // serialize to well over 2000 chars), 2 of them SLA-approaching.
    await withSystemDb("backlog-health-head-fixture", async (tx) => {
      for (let i = 0; i < 12; i++) {
        const handle = `${slug}-t${i}`
        const replyToken = `BHH${slug.slice(-6)}${i.toString().padStart(4, "0")}`
        const approaching = i < 2
        const slaDeadline = approaching
          ? drizzleSql`now() + interval '5 minutes'`
          : drizzleSql`now() + interval '10 hours'`
        const firstResp = approaching ? drizzleSql`NULL` : drizzleSql`now() - interval '20 hours'`
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_breached_at, first_response_at,
            sla_paused_at, sla_active_started_at, sla_elapsed_seconds, message_count,
            last_inbound_at, last_message_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${handle},
            ${`Black Friday order ${i} — customer reports a moderately long subject line describing a firmware or shipping problem that pads the serialized payload`},
            'open', 'high', 'manual', 'internal',
            ${replyToken}, 3600, ${slaDeadline}, NULL, ${firstResp},
            NULL, now(), 0, 1,
            now() - (interval '1 day' * ${i + 1}), now() - (interval '1 day' * ${i + 1}),
            now() - (interval '1 day' * ${i + 1}), now()
          )
        `)
      }
    })

    const out = ok(await backlogHealth(sqlDb, orgId))
    expect(out.bySla.approaching).toBe(2)

    // The exact head-truncation the chaos judge applies (opus-bridge capTranscriptToolEvents
    // default cap = 2000). The bulky payload must exceed the cap for the test to be meaningful.
    const HEAD_CAP = 2000
    const serialized = JSON.stringify(out)
    expect(serialized.length).toBeGreaterThan(HEAD_CAP)
    const head = serialized.slice(0, HEAD_CAP)
    // bySla — the authoritative SLA lane — must be fully present in the head.
    expect(head).toContain('"bySla"')
    expect(head).toContain('"approaching":2')
    const headParsablePrefix = head.indexOf('"bySla"')
    expect(headParsablePrefix).toBeGreaterThan(-1)
    expect(headParsablePrefix).toBeLessThan(HEAD_CAP - 200)
  })
})
