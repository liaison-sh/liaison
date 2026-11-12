// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #8: CSAT post-resolution survey admin ops + RLS.
// Proves: csatRequest dispatches one pending survey per CLOSED ticket (and skips open / not-found /
// already-surveyed), csatSummary aggregates recorded responses with averageScore=null until any
// customer responds (the honest-pending invariant the agent must report), csatList returns records,
// empty ticketIds is invalid_params, and the write is RLS-gated by tickets:tickets:write.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { ConsoleEmailProvider, getEmailProvider, setEmailProvider } from "~/infra/email"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let closedTicketId: string
let openTicketId: string
let rlsTicketId: string

async function insertTicket(status: string, handle: string): Promise<string> {
  return withSystemDb("csat-fixture-tk", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token,
        sla_target_seconds, sla_deadline, sla_elapsed_seconds, message_count,
        closed_reason, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${handle}, ${`Test ${handle}`}, ${status}, 'normal', 'email', 'internal', ${handle.toUpperCase()},
        28800, now(), 0, 1,
        ${status === "closed" ? "resolved" : null}, now() - interval '3 days', now() - interval '1 day'
      ) RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
}

beforeAll(async () => {
  const slug = `csat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("csat-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Csat Test', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
  })
  await ensureAppsForOrg(orgId, {})
  closedTicketId = await insertTicket("closed", `csat-closed-${slug.slice(-8)}`)
  openTicketId = await insertTicket("open", `csat-open-${slug.slice(-8)}`)
  rlsTicketId = await insertTicket("closed", `csat-rls-${slug.slice(-8)}`)
})

// team/sensitivity grants let the actor SEE the tickets (the RLS-generated tickets dimension
// filter reads the PREFIXED keys tickets:team/tickets:sensitivity — executeTool prefix-maps for
// you, but withRlsContext sets app.current_dimensions verbatim, so pre-prefix here). The write
// SCOPE difference is what gates csatRequest's INSERT (writer vs reader).
const TICKET_DIMS = { "tickets:team": ["*"], "tickets:sensitivity": ["restricted"] }
function writer() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: TICKET_DIMS,
  }
}
function reader() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: TICKET_DIMS,
  }
}

describe("csat survey admin ops (BL-169 #8)", () => {
  it("csatRequest dispatches one pending survey for a CLOSED ticket; csatList + csatSummary reflect it (no score yet)", async () => {
    const res = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatRequest",
        { ticketIds: [closedTicketId] },
        {
          actorType: "user",
          userId,
          scopes: writer().scopes,
        },
      ),
    )) as { dispatched?: number; surveys?: Array<Record<string, unknown>> }
    expect(res.dispatched).toBe(1)
    expect(res.surveys?.[0]?.status).toBe("pending")

    const list = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatList",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as Array<Record<string, unknown>>
    expect(list.some((r) => r.ticket_id === closedTicketId)).toBe(true)

    const summary = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatSummary",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as {
      total?: number
      pending?: number
      responded?: number
      declined?: number
      averageScore: number | null
      rows: unknown[]
    }
    expect(summary.total).toBeGreaterThanOrEqual(1)
    expect(summary.pending).toBeGreaterThanOrEqual(1)
    expect(summary.responded).toBe(0)
    expect(summary.averageScore).toBeNull() // the honest-pending invariant — no fabricated score
    // The surveys by response status as rows, for a dashboard block.
    expect(summary.rows).toEqual([
      { key: "responded", value: 0 },
      { key: "pending", value: summary.pending },
      { key: "declined", value: summary.declined },
    ])
  })

  it("skips a non-closed ticket (surveying an open ticket is premature)", async () => {
    const res = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatRequest",
        { ticketIds: [openTicketId] },
        {
          actorType: "user",
          userId,
          scopes: writer().scopes,
        },
      ),
    )) as { dispatched?: number; skipped?: number; skippedDetail?: Array<{ reason: string }> }
    expect(res.dispatched).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.skippedDetail?.[0]?.reason).toContain("not_closed")
  })

  it("does not double-survey an already-surveyed ticket", async () => {
    const res = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatRequest",
        { ticketIds: [closedTicketId] },
        {
          actorType: "user",
          userId,
          scopes: writer().scopes,
        },
      ),
    )) as { dispatched?: number; skipped?: number; skippedDetail?: Array<{ reason: string }> }
    expect(res.dispatched).toBe(0)
    expect(res.skippedDetail?.[0]?.reason).toBe("already_surveyed")
  })

  it("requires a non-empty ticketIds array", async () => {
    const res = (await withRlsContext(writer(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatRequest",
        {},
        { actorType: "user", userId, scopes: writer().scopes },
      ),
    )) as { error?: { code?: string } }
    expect(res.error?.code).toBe("invalid_params")
  })

  it("write is RLS-gated by tickets:tickets:write — a read-only actor cannot dispatch", async () => {
    await expect(
      withRlsContext(reader(), (tx) =>
        runAdminOp(
          tx as never,
          orgId,
          "csatRequest",
          { ticketIds: [rlsTicketId] },
          {
            actorType: "user",
            userId,
            scopes: reader().scopes,
          },
        ),
      ),
    ).rejects.toThrow()
  })

  // --- BL-194 — week-over-week TREND + customer DELIVERY ---------------------

  it("csatSummary trend is EMPTY until any survey is answered (the honest no-trend invariant)", async () => {
    const summary = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatSummary",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as { trend: unknown[]; responded: number; averageScore: number | null }
    // All dispatched surveys are still pending (none answered), so there is NO trend to report —
    // this is exactly what the trend-denial scenarios (sofia-csat-trend, priya-vip-satisfaction-trend)
    // rely on the agent saying honestly.
    expect(summary.responded).toBe(0)
    expect(summary.averageScore).toBeNull()
    expect(Array.isArray(summary.trend)).toBe(true)
    expect(summary.trend).toEqual([])
  })

  it("csatSummary returns a week-bucketed trend once responses are recorded", async () => {
    // The public ingest flips a survey to responded via its token; here we flip it directly to
    // assert the aggregate the agent reads back.
    await withSystemDb("csat-trend-respond", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.ticket_csat
        SET status = 'responded', score = 5, responded_at = now()
        WHERE org_id = ${orgId} AND ticket_id = ${closedTicketId}::uuid
      `)
    })
    const summary = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatSummary",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as {
      trend: Array<{ weekStart: string; responses: number; averageScore: number | null }>
      responded: number
      averageScore: number | null
    }
    expect(summary.responded).toBeGreaterThanOrEqual(1)
    expect(summary.averageScore).toBe(5)
    expect(summary.trend.length).toBeGreaterThanOrEqual(1)
    expect(summary.trend.reduce((n, b) => n + b.responses, 0)).toBeGreaterThanOrEqual(1)
    expect(summary.trend.every((b) => typeof b.weekStart === "string")).toBe(true)
    expect(summary.trend.some((b) => b.averageScore === 5)).toBe(true)
  })

  it("csatRequest DELIVERS the tokenized survey email to a contact with an address", async () => {
    const prev = getEmailProvider()
    const probe = new ConsoleEmailProvider()
    setEmailProvider(probe)
    try {
      const stamp = Date.now()
      const { ticketId, email } = await withSystemDb("csat-delivery-fixture", async (tx) => {
        const c = (await tx.execute(drizzleSql`
          INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}, ${`csat-cust-${stamp}`}, 'Dana Customer', ${`dana-${stamp}@cust.test`}, now(), now())
          RETURNING id, email
        `)) as any
        const contact = (c.rows ?? c)[0]
        const t = (await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token, contact_id,
            sla_target_seconds, sla_deadline, sla_elapsed_seconds, message_count, closed_reason, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${`csat-deliv-${stamp}`}, 'Delivery test', 'closed', 'normal', 'email', 'internal', ${`DELIV${stamp}`}, ${contact.id},
            28800, now(), 0, 1, 'resolved', now() - interval '2 days', now() - interval '1 day'
          ) RETURNING id
        `)) as any
        return { ticketId: (t.rows ?? t)[0].id as string, email: contact.email as string }
      })
      const res = (await withRlsContext(writer(), (tx) =>
        runAdminOp(
          tx as never,
          orgId,
          "csatRequest",
          { ticketIds: [ticketId] },
          { actorType: "user", userId, scopes: writer().scopes },
        ),
      )) as { dispatched?: number; emailed?: number }
      expect(res.dispatched).toBe(1)
      expect(res.emailed).toBe(1)
      const survey = probe.sent.find((m) => m.to === email)
      expect(survey).toBeDefined()
      // The link carries the per-survey token under the org-scoped public ingest path.
      expect(survey?.text).toContain(`/csat/${orgId}/`)
      expect(survey?.html).toContain(`/csat/${orgId}/`)
    } finally {
      setEmailProvider(prev)
    }
  })
  it("csatRequest falls back to the first inbound sender when the ticket links no contact", async () => {
    // Intake never creates a contact (modules/contacts): the customer's address
    // is on their inbound message, and the survey still reaches them.
    const prev = getEmailProvider()
    const probe = new ConsoleEmailProvider()
    setEmailProvider(probe)
    try {
      const stamp = Date.now()
      const email = `nocontact-${stamp}@cust.test`
      const ticketId = await withSystemDb("csat-nocontact-fixture", async (tx) => {
        const t = (await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token,
            sla_target_seconds, sla_deadline, sla_elapsed_seconds, message_count, closed_reason, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${`csat-noc-${stamp}`}, 'No contact', 'closed', 'normal', 'email', 'internal', ${`NOC${stamp}`},
            28800, now(), 0, 1, 'resolved', now() - interval '2 days', now() - interval '1 day'
          ) RETURNING id
        `)) as any
        const id = (t.rows ?? t)[0].id as string
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, sent_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}, ${id}, 'inbound', ${email}, now() - interval '2 days', now(), now())`)
        return id
      })
      const res = (await withRlsContext(writer(), (tx) =>
        runAdminOp(
          tx as never,
          orgId,
          "csatRequest",
          { ticketIds: [ticketId] },
          { actorType: "user", userId, scopes: writer().scopes },
        ),
      )) as { dispatched?: number; emailed?: number }
      expect(res.dispatched).toBe(1)
      expect(res.emailed).toBe(1)
      expect(probe.sent.find((m) => m.to === email)).toBeDefined()
    } finally {
      setEmailProvider(prev)
    }
  })
})
