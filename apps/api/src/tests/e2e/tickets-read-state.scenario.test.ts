// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { ks, seedInbox, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

interface TestActor {
  id: string
  email: string
  token: string
  name: string
  scopes: string[]
}

const READ_WRITE_SCOPES = [
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:inboxes:read",
  "tickets:messages:read",
  "tickets:messages:write",
  "kernel:contacts:read",
  "kernel:contacts:write",
]

const DEFAULT_ORG_SETTINGS = {
  fileSizeLimitMb: 50,
  storageQuotaGb: 10,
  auditRetentionDays: 90,
  rateLimitPerMinute: 100000,
  tickets: {
    sla: {
      targets: { low: 86400, normal: 28800, high: 7200, urgent: 3600 },
      businessHours: {
        timezone: "UTC",
        weekly: {
          mon: [["09:00", "18:00"]],
          tue: [["09:00", "18:00"]],
          wed: [["09:00", "18:00"]],
          thu: [["09:00", "18:00"]],
          fri: [["09:00", "18:00"]],
          sat: [],
          sun: [],
        },
        holidays: [],
      },
    },
  },
}

async function makeActor(
  url: string,
  env: WorkerEnv,
  world: TestWorld,
  opts: { name: string; scopes: string[] },
): Promise<TestActor> {
  const created = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name: opts.name,
    scopes: opts.scopes,
    dimensions: { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })
  return {
    id: created.id,
    email: created.email,
    token: created.token,
    name: created.name,
    scopes: opts.scopes,
  }
}

async function seedContact(
  env: WorkerEnv,
  orgId: string,
  createdBy: string,
): Promise<{ id: string }> {
  const id = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.contacts (id, org_id, handle, email, name, external_ids, created_by)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
    [
      id,
      orgId,
      `@contact-${id.slice(0, 8)}`,
      `contact-${id.slice(0, 8)}@test.local`,
      `Contact ${id.slice(0, 8)}`,
      createdBy,
    ],
  )
  return { id }
}

// Direct-SQL foreign org — bootstrap-register only works once per server, so
// scenarios that need a second org seed it via DB writes plus the standard
// settings shape.
async function seedForeignOrg(
  env: WorkerEnv,
  label: string,
): Promise<{ id: string; slug: string }> {
  const slug = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const rows = await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.organizations (id, name, slug, settings, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb, now(), now())
     RETURNING id`,
    [`Foreign ${label}`, slug, JSON.stringify(DEFAULT_ORG_SETTINGS)],
  )
  return { id: (rows[0] as any).id as string, slug }
}

describe("Tickets Read-State E2E", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let foreignOrgId: string
  let agentA: TestActor
  let agentB: TestActor
  let noScopeUser: TestActor

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 7401,
      org: { name: "Tickets RS E2E" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    agentA = await makeActor(url, env, world, { name: "Agent A", scopes: READ_WRITE_SCOPES })
    agentB = await makeActor(url, env, world, { name: "Agent B", scopes: READ_WRITE_SCOPES })
    noScopeUser = await makeActor(url, env, world, { name: "No Scope", scopes: [] })

    const foreign = await seedForeignOrg(env, "rs-cross-org")
    foreignOrgId = foreign.id
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S1: markRead writes a ticket_reads row through the real tool dispatch path ───

  it("S1: markRead writes a ticket_reads row through the real tool dispatch path", async () => {
    const create = await api(url, "/api/apps/tools/tickets:create", {
      method: "POST",
      token: agentA.token,
      body: {
        params: {
          subject: "S1 read-state",
          priority: "normal",
          channel: "manual",
          team: "support-eu",
          initialMessage: { kind: "outbound", textBody: "outbound seed" },
        },
      },
    })
    expect(create.status).toBe(200)
    const ticketId = (create.body.data as any).ticketId as string

    const msgRows = await env.db.sql.unsafe(
      `SELECT id::text AS id FROM ${ts(env)}.messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ticketId],
    )
    expect(msgRows.length).toBe(1)
    const messageId = (msgRows[0] as any).id as string

    const r1 = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId } },
    })
    expect(r1.status).toBe(200)
    const readAt1 = (r1.body.data as any).readAt as string
    expect(typeof readAt1).toBe("string")

    const r2 = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId } },
    })
    expect(r2.status).toBe(200)
    const readAt2 = (r2.body.data as any).readAt as string
    expect(new Date(readAt2).getTime()).toBeGreaterThanOrEqual(new Date(readAt1).getTime())

    await Bun.sleep(50)
    const r3 = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId, lastReadMessageId: messageId } },
    })
    expect(r3.status).toBe(200)
    const readAt3 = (r3.body.data as any).readAt as string
    expect(new Date(readAt3).getTime()).toBeGreaterThanOrEqual(new Date(readAt2).getTime())
    expect((r3.body.data as any).lastReadMessageId).toBe(messageId)

    const reads = await env.db.sql.unsafe(
      `SELECT user_id::text AS user_id, read_at, last_read_message_id::text AS last_read_message_id
         FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1`,
      [ticketId],
    )
    expect(reads.length).toBe(1)
    const r = reads[0] as any
    expect(r.user_id).toBe(agentA.id)
    expect(new Date(r.read_at).toISOString()).toBe(new Date(readAt3).toISOString())
    expect(r.last_read_message_id).toBe(messageId)
  })

  // ─── S2: cross-org markRead returns 404 ticket_not_found, no row written ───

  it("S2: markRead for a cross-org ticket returns ticket_not_found and writes nothing", async () => {
    const foreignTicket = await seedTicket(env, {
      orgId: foreignOrgId,
      subject: "S2 foreign",
      team: "support-eu",
      lastInboundAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const cross = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId: foreignTicket.id } },
    })
    expect(cross.status).toBe(404)
    expect(cross.body.error?.code).toBe("ticket_not_found")

    const leak = await env.db.sql.unsafe(
      `SELECT COUNT(*)::text AS count FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1`,
      [foreignTicket.id],
    )
    expect(Number((leak[0] as any).count)).toBe(0)
  })

  // ─── S3: per-user monotonic, org-global unread derivation ───

  it("S3: markRead is per-user monotonic and unread derivation is org-global", async () => {
    const inbox = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id })
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S3 ticket",
      team: "support-eu",
      sourceInboxId: inbox.id,
      lastInboundAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lastMessageAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })

    const ra = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId: ticket.id } },
    })
    expect(ra.status).toBe(200)
    const agentARead = (ra.body.data as any).readAt as string

    const counts1 = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentB.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(counts1.status).toBe(200)
    const c1 = (
      (counts1.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    ).find((x) => x.inboxId === inbox.id)
    expect(c1?.unread).toBe(0)

    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets SET last_inbound_at = now(), last_message_at = now() WHERE id = $1`,
      [ticket.id],
    )

    const counts2 = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentB.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(counts2.status).toBe(200)
    const c2 = (
      (counts2.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    ).find((x) => x.inboxId === inbox.id)
    expect(c2?.unread).toBe(1)

    await Bun.sleep(50)
    const rb = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentB.token,
      body: { params: { ticketId: ticket.id } },
    })
    expect(rb.status).toBe(200)

    const reads = await env.db.sql.unsafe(
      `SELECT user_id::text AS user_id, read_at FROM ${ts(env)}.ticket_reads
         WHERE ticket_id = $1 ORDER BY read_at`,
      [ticket.id],
    )
    expect(reads.length).toBe(2)
    const aRow = (reads as any[]).find((r) => r.user_id === agentA.id)
    const bRow = (reads as any[]).find((r) => r.user_id === agentB.id)
    expect(aRow).toBeTruthy()
    expect(bRow).toBeTruthy()
    expect(new Date(aRow.read_at).toISOString()).toBe(new Date(agentARead).toISOString())
    expect(new Date(bRow.read_at).getTime()).toBeGreaterThanOrEqual(
      new Date(aRow.read_at).getTime(),
    )
  })

  // ─── S4: inboxCounts aggregates unread per inbox under RLS ───

  it("S4: inboxCounts aggregates unread per inbox under RLS, filters foreign ids", async () => {
    const ibx = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S4-X" })
    const iby = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S4-Y" })
    const ibz = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S4-Z" })

    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "T_X1",
      team: "support-eu",
      sourceInboxId: ibx.id,
      lastInboundAt: fiveMinAgo,
    })
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "T_X2",
      team: "support-eu",
      sourceInboxId: ibx.id,
      lastInboundAt: fiveMinAgo,
    })
    const t_x3 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "T_X3",
      team: "support-eu",
      sourceInboxId: ibx.id,
      lastInboundAt: fiveMinAgo,
    })
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "T_Y1",
      status: "closed",
      team: "support-eu",
      sourceInboxId: iby.id,
      lastInboundAt: fiveMinAgo,
    })
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "T_Y2",
      team: "support-eu",
      sourceInboxId: iby.id,
      lastInboundAt: null,
    })

    const markT_X3 = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId: t_x3.id } },
    })
    expect(markT_X3.status).toBe(200)

    const c1 = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [ibx.id, iby.id, ibz.id] } },
    })
    expect(c1.status).toBe(200)
    const counts = (c1.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    const byId = new Map(counts.map((c) => [c.inboxId, c.unread]))
    expect(byId.get(ibx.id)).toBe(2)
    expect(byId.get(iby.id)).toBe(0)
    expect(byId.get(ibz.id)).toBe(0)
    expect(counts.length).toBe(3)

    const c2 = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [ibx.id] } },
    })
    expect(c2.status).toBe(200)
    const counts2 = (c2.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    expect(counts2.length).toBe(1)
    expect(counts2[0]).toEqual({ inboxId: ibx.id, unread: 2 })

    const foreignInbox = await seedInbox(env, {
      orgId: foreignOrgId,
      createdBy: world.admin.id,
      name: "S4-Foreign",
    })
    const c3 = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [ibx.id, foreignInbox.id] } },
    })
    expect(c3.status).toBe(200)
    const counts3 = (c3.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    expect(counts3.length).toBe(1)
    expect(counts3[0].inboxId).toBe(ibx.id)
  })

  // ─── S5: inboxCounts flips back to unread on new inbound ───

  it("S5: inboxCounts flips back to unread when a new inbound arrives after read", async () => {
    const inbox = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S5" })
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S5 ticket",
      team: "support-eu",
      sourceInboxId: inbox.id,
      lastInboundAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })

    const mr = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId: ticket.id } },
    })
    expect(mr.status).toBe(200)

    const before = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(before.status).toBe(200)
    expect(((before.body.data as any).counts[0] as any).unread).toBe(0)

    await env.db.sql.unsafe(`UPDATE ${ts(env)}.tickets SET last_inbound_at = now() WHERE id = $1`, [
      ticket.id,
    ])

    const after = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(after.status).toBe(200)
    expect(((after.body.data as any).counts[0] as any).unread).toBe(1)
  })

  // ─── S6: listForContact ordering, NULLS LAST, merge exclusion, limit cap ───

  it("S6: listForContact returns recent non-merged tickets ordered DESC NULLS LAST", async () => {
    const c1 = await seedContact(env, world.org.id, world.admin.id)
    const c2 = await seedContact(env, world.org.id, world.admin.id)

    const t1 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S6-T1",
      team: "support-eu",
      contactId: c1.id,
      lastMessageAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    })
    const t2 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S6-T2",
      team: "support-eu",
      contactId: c1.id,
      lastMessageAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    })
    const t3 = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S6-T3",
      team: "support-eu",
      contactId: c1.id,
      lastMessageAt: null,
    })
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "S6-T4-merged",
      team: "support-eu",
      contactId: c1.id,
      mergedIntoTicketId: t2.id,
      lastMessageAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    })
    await seedTicket(env, {
      orgId: world.org.id,
      subject: "S6-T5-other",
      team: "support-eu",
      contactId: c2.id,
      lastMessageAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })

    const r = await api(url, "/api/apps/tools/tickets:listForContact", {
      method: "POST",
      token: agentA.token,
      body: { params: { contactId: c1.id } },
    })
    expect(r.status).toBe(200)
    const items = (r.body.data as any).items as Array<{
      id: string
      handle: string
      subject: string
      status: string
      lastActivityAt: string | null
    }>
    expect(items.map((i) => i.id)).toEqual([t2.id, t1.id, t3.id])
    const t1Item = items.find((i) => i.id === t1.id)!
    expect(typeof t1Item.lastActivityAt).toBe("string")
    expect(t1Item.subject).toBe("S6-T1")
    expect(t1Item.handle).toMatch(/^ticket-\d+$/)
    expect(t1Item.status).toBe("open")
    const t3Item = items.find((i) => i.id === t3.id)!
    expect(t3Item.lastActivityAt).toBeNull()
    expect(Object.keys(t1Item).sort()).toEqual(
      ["id", "handle", "subject", "status", "lastActivityAt"].sort(),
    )

    const limited = await api(url, "/api/apps/tools/tickets:listForContact", {
      method: "POST",
      token: agentA.token,
      body: { params: { contactId: c1.id, limit: 1 } },
    })
    expect(limited.status).toBe(200)
    const limitedItems = (limited.body.data as any).items as Array<{ id: string }>
    expect(limitedItems.length).toBe(1)
    expect(limitedItems[0].id).toBe(t2.id)

    const overCap = await api(url, "/api/apps/tools/tickets:listForContact", {
      method: "POST",
      token: agentA.token,
      body: { params: { contactId: c1.id, limit: 9999 } },
    })
    expect(overCap.status).toBe(200)
    expect(((overCap.body.data as any).items as any[]).length).toBe(3)

    // Cross-org: contact lives in foreign org, agentA queries it — RLS hides
    // every ticket regardless of contactId, so the result is an empty list (no
    // error code, since the contract is the empty-list shape).
    const foreignContact = await seedContact(env, foreignOrgId, world.admin.id)
    await seedTicket(env, {
      orgId: foreignOrgId,
      subject: "S6 foreign ticket",
      team: "support-eu",
      contactId: foreignContact.id,
      lastMessageAt: new Date().toISOString(),
    })
    const cross = await api(url, "/api/apps/tools/tickets:listForContact", {
      method: "POST",
      token: agentA.token,
      body: { params: { contactId: foreignContact.id } },
    })
    expect(cross.status).toBe(200)
    expect(((cross.body.data as any).items as any[]).length).toBe(0)
  })

  // ─── S7: Concurrent markRead from same user is idempotent (single row) ───

  it("S7: concurrent markRead from same user is idempotent (single row)", async () => {
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S7 ticket",
      team: "support-eu",
      lastInboundAt: new Date().toISOString(),
    })

    const [r1, r2] = await Promise.all([
      api(url, "/api/apps/tools/tickets:markRead", {
        method: "POST",
        token: agentA.token,
        body: { params: { ticketId: ticket.id } },
      }),
      api(url, "/api/apps/tools/tickets:markRead", {
        method: "POST",
        token: agentA.token,
        body: { params: { ticketId: ticket.id } },
      }),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(typeof (r1.body.data as any).readAt).toBe("string")
    expect(typeof (r2.body.data as any).readAt).toBe("string")

    const rows = await env.db.sql.unsafe(
      `SELECT COUNT(*)::text AS count FROM ${ts(env)}.ticket_reads
         WHERE ticket_id = $1 AND user_id = $2`,
      [ticket.id, agentA.id],
    )
    expect(Number((rows[0] as any).count)).toBe(1)
  })

  // ─── S8: Closed ticket — markRead succeeds but never appears in unread counts ───

  it("S8: closed ticket — markRead succeeds, ticket never appears in unread counts", async () => {
    const inbox = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S8" })
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S8 closed",
      status: "closed",
      team: "support-eu",
      sourceInboxId: inbox.id,
      lastInboundAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      closedReason: "resolved",
    })

    const before = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(before.status).toBe(200)
    expect(((before.body.data as any).counts[0] as any).unread).toBe(0)

    const mr = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: agentA.token,
      body: { params: { ticketId: ticket.id } },
    })
    expect(mr.status).toBe(200)
    expect(typeof (mr.body.data as any).readAt).toBe("string")

    const after = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(after.status).toBe(200)
    expect(((after.body.data as any).counts[0] as any).unread).toBe(0)

    const rows = await env.db.sql.unsafe(
      `SELECT COUNT(*)::text AS count FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1`,
      [ticket.id],
    )
    expect(Number((rows[0] as any).count)).toBe(1)
  })

  // ─── S9: Scope enforcement on markRead, inboxCounts, listForContact ───

  it("S9: scope enforcement returns forbidden on all three tools", async () => {
    const inbox = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S9" })
    const contact = await seedContact(env, world.org.id, world.admin.id)
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "S9 ticket",
      team: "support-eu",
      sourceInboxId: inbox.id,
      contactId: contact.id,
      lastInboundAt: new Date().toISOString(),
    })

    const mr = await api(url, "/api/apps/tools/tickets:markRead", {
      method: "POST",
      token: noScopeUser.token,
      body: { params: { ticketId: ticket.id } },
    })
    expect(mr.status).toBe(403)
    expect(mr.body.error?.code).toBe("forbidden")

    const ic = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: noScopeUser.token,
      body: { params: { inboxIds: [inbox.id] } },
    })
    expect(ic.status).toBe(403)
    expect(ic.body.error?.code).toBe("forbidden")

    const lfc = await api(url, "/api/apps/tools/tickets:listForContact", {
      method: "POST",
      token: noScopeUser.token,
      body: { params: { contactId: contact.id } },
    })
    expect(lfc.status).toBe(403)
    expect(lfc.body.error?.code).toBe("forbidden")

    const rows = await env.db.sql.unsafe(
      `SELECT COUNT(*)::text AS count FROM ${ts(env)}.ticket_reads WHERE ticket_id = $1`,
      [ticket.id],
    )
    expect(Number((rows[0] as any).count)).toBe(0)
  })

  // ─── S10: inboxCounts no-filter path surfaces empty inboxes via LEFT JOIN ───

  it("S10: inboxCounts no-filter path surfaces empty inboxes with unread=0", async () => {
    // Seed three brand-new inboxes in the primary org with NO tickets attached.
    // The LEFT JOIN in inboxCounts must surface them with unread=0 even though
    // no rows in app_tickets.tickets reference their ids.
    const ia = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S10-A" })
    const ib = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S10-B" })
    const ic = await seedInbox(env, { orgId: world.org.id, createdBy: agentA.id, name: "S10-C" })

    // Foreign-org inbox: must NOT appear under any code path for agentA.
    const isoOrg = await seedForeignOrg(env, "rs-iso-no-filter")
    const isoInbox = await seedInbox(env, {
      orgId: isoOrg.id,
      createdBy: world.admin.id,
      name: "Iso-A",
    })

    const res = await api(url, "/api/apps/tools/tickets:inboxCounts", {
      method: "POST",
      token: agentA.token,
      body: { params: {} },
    })
    expect(res.status).toBe(200)
    const counts = (res.body.data as any).counts as Array<{ inboxId: string; unread: number }>
    const byId = new Map(counts.map((c) => [c.inboxId, c.unread]))

    expect(byId.has(ia.id)).toBe(true)
    expect(byId.has(ib.id)).toBe(true)
    expect(byId.has(ic.id)).toBe(true)
    expect(byId.get(ia.id)).toBe(0)
    expect(byId.get(ib.id)).toBe(0)
    expect(byId.get(ic.id)).toBe(0)
    expect(byId.has(isoInbox.id)).toBe(false)

    // Sanity check: every visible inbox row exposes a non-negative unread
    // count, the canonical contract for the sidebar render path.
    for (const c of counts) {
      expect(c.unread).toBeGreaterThanOrEqual(0)
    }
  })
})
