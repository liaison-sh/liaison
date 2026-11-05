// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 5 camelCase shape adapter for `tickets:search`. Verifies the
// app-tool path returns camelCase columns, sets `unread`/`readByCount`/
// `readByRecent`, and respects the org-global read-state semantics.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let secondUserId: string
let inboxId: string
let actor: ActorContext
let secondActor: ActorContext

async function seedTicket(opts: {
  subject: string
  status?: string
  priority?: string
  inbound?: boolean
  lastOutboundAt?: ReturnType<typeof drizzleSql> | null
  followupAt?: ReturnType<typeof drizzleSql> | string | null
  updatedAt?: ReturnType<typeof drizzleSql>
  closedReason?: string | null
  mergedInto?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `ticket-${Math.floor(Math.random() * 1e9)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  const inbound = opts.inbound !== false
  await withSystemDb("search-camelcase-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id,
        last_inbound_at, last_outbound_at, last_message_at, followup_at,
        closed_reason, merged_into_ticket_id,
        created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${opts.subject}, ${opts.status ?? "open"},
        ${opts.priority ?? "normal"}, 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        ${inboxId},
        ${inbound ? drizzleSql`now() - interval '5 minutes'` : drizzleSql`NULL`},
        ${opts.lastOutboundAt ?? null},
        now() - interval '5 minutes',
        ${opts.followupAt ?? null},
        ${opts.closedReason ?? null}, ${opts.mergedInto ?? null},
        now(), ${opts.updatedAt ?? drizzleSql`now()`}
      )
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${id}, 'inbound', 'hi', now() - interval '5 minutes', now(), now())
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `search-camelcase-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-camelcase-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Camel', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u1-${slug}@test.com`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (userRows.rows ?? userRows)[0].id
    const u2 = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u2-${slug}@test.com`}, 'B', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    secondUserId = (u2.rows ?? u2)[0].id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'In', ${`in-${slug}@x.test`}, 'internal', true, now(), now())
      RETURNING id
    `)) as any
    inboxId = (inboxRows.rows ?? inboxRows)[0].id
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
  secondActor = { ...actor, userId: secondUserId } as ActorContext
})

describe("tickets.search.camelcase-projection", () => {
  it("returns camelCase fields with unread=true and readByCount=0 for fresh ticket", async () => {
    const ticketId = await seedTicket({ subject: "Fresh row" })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { limit: 50 },
    })
    const row = (out.data as any).items.find((r: any) => r.id === ticketId)
    expect(row).toBeTruthy()
    expect(row.handle).toMatch(/^ticket-\d+$/)
    expect(row.subject).toBe("Fresh row")
    expect(row.unread).toBe(true)
    expect(row.readByCount).toBe(0)
    expect(row.readByRecent).toEqual([])
    expect(row.slaDeadline).toBeTruthy()
    expect(row.lastInboundAt).toBeTruthy()
    // No snake_case keys leak through.
    for (const k of Object.keys(row)) expect(k.includes("_")).toBe(false)
  })

  it("tickets.read-state.org-global-on-new-agent — unread=false for second user once first marks read", async () => {
    const ticketId = await seedTicket({ subject: "Org global" })
    await executeTool({
      toolName: "tickets:markRead",
      orgId,
      actor,
      params: { ticketId },
    })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor: secondActor,
      params: { limit: 50 },
    })
    const row = (out.data as any).items.find((r: any) => r.id === ticketId)
    expect(row.unread).toBe(false)
    expect(row.readByCount).toBeGreaterThanOrEqual(1)
    expect(row.readByRecent.length).toBeGreaterThanOrEqual(1)
    expect(row.readByRecent[0]).toMatchObject({
      userId: expect.any(String),
      readAt: expect.any(String),
    })
  })

  it("tickets.read-state.flips-on-new-inbound — new inbound after read flips back to unread", async () => {
    const ticketId = await seedTicket({ subject: "Flip" })
    await executeTool({
      toolName: "tickets:markRead",
      orgId,
      actor,
      params: { ticketId },
    })
    // append a newer inbound
    await withSystemDb("flip-append", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets SET last_inbound_at = now(), last_message_at = now() WHERE id = ${ticketId}
      `)
    })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { limit: 50 },
    })
    const row = (out.data as any).items.find((r: any) => r.id === ticketId)
    expect(row.unread).toBe(true)
  })

  it("returns unread=false, readByCount=0, readByRecent=[] when last_inbound_at is null", async () => {
    const ticketId = await seedTicket({ subject: "No inbound", inbound: false })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { limit: 50 },
    })
    const row = (out.data as any).items.find((r: any) => r.id === ticketId)
    expect(row.unread).toBe(false)
    expect(row.readByCount).toBe(0)
    expect(row.readByRecent).toEqual([])
  })

  it("[SC3] implements the spec smart-filter predicates", async () => {
    const needs = await seedTicket({ subject: "Needs attention smart", priority: "urgent" })
    const awaiting = await seedTicket({
      subject: "Awaiting customer smart",
      status: "awaiting_customer",
    })
    const followup = await seedTicket({
      subject: "Scheduled follow-up smart",
      status: "awaiting_followup",
      followupAt: drizzleSql`now() + interval '2 days'`,
    })
    const oldClosed = await seedTicket({
      subject: "Old closed smart",
      status: "closed",
      closedReason: "resolved",
      updatedAt: drizzleSql`now() - interval '40 days'`,
    })
    const target = await seedTicket({ subject: "Merge target smart" })
    const mergedClosed = await seedTicket({
      subject: "Merged closed smart",
      status: "closed",
      closedReason: "merged",
      mergedInto: target,
    })

    const needsOut = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "needs-attention", limit: 50 },
    })
    const needsRow = (needsOut.data as any).items.find((row: any) => row.id === needs)
    expect(needsRow?.urgencyRank).toBeGreaterThanOrEqual(200)

    const awaitingOut = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "awaiting-customer", limit: 50 },
    })
    expect((awaitingOut.data as any).items.map((row: any) => row.id)).toContain(awaiting)

    const followupOut = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "follow-ups", limit: 50 },
    })
    expect((followupOut.data as any).items.map((row: any) => row.id)).toContain(followup)

    const closedOut = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "closed", limit: 50 },
    })
    const closedIds = (closedOut.data as any).items.map((row: any) => row.id)
    expect(closedIds).toContain(mergedClosed)
    expect(closedIds).not.toContain(oldClosed)

    const allOpenOut = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { smartFilter: "all-open", limit: 50 },
    })
    const allOpenIds = (allOpenOut.data as any).items.map((row: any) => row.id)
    expect(allOpenIds).toContain(target)
    expect(allOpenIds).not.toContain(mergedClosed)
  })

  // BL-245: slaBreached filter — the directly-supported query for an open ticket "aging past SLA"
  // (the grounded signal a VIP relationship-risk readout cites). slaApproaching=true does NOT match an
  // already-breached ticket (it requires first_response_at IS NULL and a deadline merely NEARING), so a
  // breached ticket we have already replied to was previously only reachable by eyeballing slaDeadline.
  // slaBreached=true returns it; a not-breached ticket (future deadline) is excluded.
  it("slaBreached=true returns only tickets past their SLA deadline (the 'aging past SLA' filter)", async () => {
    const breached = crypto.randomUUID()
    const notBreached = crypto.randomUUID()
    await withSystemDb("sla-breached-seed", async (tx) => {
      // Breached: deadline 6h ago, sla_breached_at set, AND first_response_at set (we replied) — so it is
      // invisible to slaApproaching but must surface under slaBreached.
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          sla_breached_at, first_response_at, message_count, source_inbox_id,
          last_inbound_at, last_message_at, created_at, updated_at
        ) VALUES (
          ${breached}, ${orgId}, ${`brk-${breached.slice(0, 8)}`}, 'VIP breached past SLA', 'open', 'high',
          'manual', 'internal', ${`RT${breached.slice(0, 12)}`}, 14400, now() - interval '6 hours',
          now() - interval '10 hours', 36000, now() - interval '6 hours', now() - interval '7 hours', 1,
          ${inboxId}, now() - interval '10 hours', now() - interval '6 hours', now() - interval '10 hours', now()
        )
      `)
      // Not breached: deadline 1h in the FUTURE, no breach timestamp.
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
        ) VALUES (
          ${notBreached}, ${orgId}, ${`okk-${notBreached.slice(0, 8)}`}, 'Healthy within SLA', 'open', 'normal',
          'manual', 'internal', ${`RT${notBreached.slice(0, 12)}`}, 14400, now() + interval '1 hour',
          now(), 0, 1, ${inboxId}, now() - interval '5 minutes', now() - interval '5 minutes', now(), now()
        )
      `)
    })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { slaBreached: true, limit: 50 },
    })
    const ids = (out.data as any).items.map((r: any) => r.id)
    expect(ids).toContain(breached)
    expect(ids).not.toContain(notBreached)
    // The breached row carries the slaBreachedAt timestamp the readout cites.
    const row = (out.data as any).items.find((r: any) => r.id === breached)
    expect(row.slaBreachedAt).toBeTruthy()
  })
})
