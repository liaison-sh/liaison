// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression (Acme QA, 2026-09-22): tickets.search with `q:"ticket-4637"`
// (the ticket's handle, how people and agents name a ticket) timed out every
// time ("HTTP 500 App execution timed out") while `q:"4637"` worked. The handle
// went to Meili, whose tokenizer splits it into `ticket` + `4637`; `ticket` is
// in every ticket's indexed handle, so the executor resolved the WHOLE org
// (4 747 of 4 747 tickets on the box) and the page query over that IN-list ran
// past the sandbox budget. A handle now resolves by exact key on the
// (org_id, handle) unique index and never reaches the text resolver.
//
// The injected resolver below reproduces the live Meili behaviour for a
// handle-shaped query: it returns every ticket of the org.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { TicketsSearchTestAccess } from "~/apps/tickets/search"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let inboxId: string
let actor: ActorContext

const handles: Record<string, string> = {}

async function seed(opts: {
  key: string
  handle: string
  subject: string
  body: string
}): Promise<string> {
  const id = crypto.randomUUID()
  const handle = opts.handle
  handles[opts.key] = id
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-handle-key-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, contact_id,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${opts.subject}, 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour', null,
        now(), 0, 1, ${inboxId}, now() - interval '5 minutes', now() - interval '5 minutes', now(), now()
      )
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${id}, 'inbound', ${opts.body}, now() - interval '5 minutes', now(), now())
    `)
  })
  return id
}

async function searchIds(params: Record<string, unknown>): Promise<string[]> {
  const out = await executeTool({ toolName: "tickets:search", orgId, actor, params })
  return ((out.data as { items: { id: string }[] }).items ?? []).map((r) => r.id)
}

const seq = 900_000_000 + Math.floor(Math.random() * 1e8)
const targetHandle = `ticket-${seq}`
let resolverCalls: string[] = []

beforeAll(async () => {
  const slug = `search-handle-key-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-handle-key-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search Key', ${slug}) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0]!.id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u1-${slug}@test.com`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    userId = (userRows.rows ?? userRows)[0]!.id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'In', ${`in-${slug}@x.test`}, 'internal', true, now(), now())
      RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext

  await seed({
    key: "target",
    handle: targetHandle,
    subject: "Bank account won't connect",
    body: "BBVA link fails.",
  })
  await seed({ key: "sibling", handle: `ticket-${seq + 1}`, subject: "Other", body: "Unrelated." })
  await seed({
    key: "sibling2",
    handle: `ticket-${seq}0`,
    subject: "Prefix twin",
    body: "Shares the digits.",
  })
})

beforeEach(() => {
  resolverCalls = []
  TicketsSearchTestAccess.setMatchResolver(async ({ q }) => {
    resolverCalls.push(q)
    return Object.values(handles)
  })
})

afterEach(() => {
  TicketsSearchTestAccess.setMatchResolver(null)
})

describe("tickets.search by ticket handle", () => {
  it("q = the handle returns exactly that ticket, without the text resolver", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { q: targetHandle, limit: 50 },
    })
    const data = out.data as { items: { id: string; handle: string }[]; totalCount: number }
    expect(data.items.map((r) => r.id)).toEqual([handles.target!])
    expect(data.items[0]?.handle).toBe(targetHandle)
    expect(data.totalCount).toBe(1)
    expect(resolverCalls).toEqual([])
  })

  it("the handle match is case-insensitive and trims", async () => {
    const ids = await searchIds({ q: `  ${targetHandle.toUpperCase()} ` })
    expect(ids).toEqual([handles.target!])
    expect(resolverCalls).toEqual([])
  })

  it("an unknown handle returns an empty page, not the whole org", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { q: `ticket-${seq + 7}` },
    })
    const data = out.data as { items: unknown[]; totalCount: number }
    expect(data.items).toEqual([])
    expect(data.totalCount).toBe(0)
    expect(resolverCalls).toEqual([])
  })

  // TIC-04 (S20): the ticket uuid names the ticket as surely as its handle
  // (tickets:get resolves it). Meili holds no searchable uuid, so a uuid query
  // must resolve by key too, never by full text.
  it("q = the ticket uuid returns exactly that ticket, without the text resolver", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { q: `  ${handles.target!.toUpperCase()} ` },
    })
    const data = out.data as { items: { id: string }[]; totalCount: number }
    expect(data.items.map((r) => r.id)).toEqual([handles.target!])
    expect(data.totalCount).toBe(1)
    expect(resolverCalls).toEqual([])
  })

  it("an unknown uuid returns an empty page without the text resolver", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { q: crypto.randomUUID() },
    })
    const data = out.data as { items: unknown[]; totalCount: number }
    expect(data.items).toEqual([])
    expect(data.totalCount).toBe(0)
    expect(resolverCalls).toEqual([])
  })

  it("the handle composes with relational filters", async () => {
    expect(await searchIds({ q: targetHandle, status: "closed" })).toEqual([])
  })

  it("any other query still goes through the text resolver", async () => {
    const ids = await searchIds({ q: String(seq), limit: 50 })
    expect(resolverCalls).toEqual([String(seq)])
    expect(ids).toContain(handles.target!)
    expect(ids).toContain(handles.sibling!)
  })
})

// Ticket display ids (S19/S20): with the org segmenting by audience, the
// display form finds the ticket (a stale segment too), and search/get OUTPUT
// the display form, computed from the ticket's current audience.
describe("tickets.search and get with segmented ids", () => {
  beforeAll(async () => {
    await withSystemDb("search-handle-key-segment", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}',
          COALESCE(settings->'tickets', '{}'::jsonb) || '{"idSegment":{"by":"audience","codes":{"b2b":"B2B","b2c":"B2C"}}}'::jsonb, true)
        WHERE id = ${orgId}
      `)
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET audience = 'b2b' WHERE id = ${handles.target!}`,
      )
    })
  })

  afterAll(async () => {
    await withSystemDb("search-handle-key-segment-off", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations SET settings = settings #- '{tickets,idSegment}' WHERE id = ${orgId}
      `)
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET audience = NULL WHERE id = ${handles.target!}`,
      )
    })
  })

  it("q = the display form (or a stale one) returns the ticket, carrying the display handle", async () => {
    for (const q of [`ticket-B2B-${seq}`, `ticket-b2c-${seq}`, targetHandle]) {
      const out = await executeTool({ toolName: "tickets:search", orgId, actor, params: { q } })
      const data = out.data as { items: { id: string; handle: string }[] }
      expect(data.items.map((r) => r.id)).toEqual([handles.target!])
      expect(data.items[0]?.handle).toBe(`ticket-B2B-${seq}`)
    }
    expect(resolverCalls).toEqual([])
  })

  it("reclassifying re-segments the id, never the number (tool result + get)", async () => {
    const set = await executeTool({
      toolName: "tickets:setAudience",
      orgId,
      actor,
      params: { ticketId: handles.target!, audience: "b2c" },
    })
    expect((set.data as { handle?: string }).handle).toBe(`ticket-B2C-${seq}`)
    const got = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: `ticket-B2B-${seq}` },
    })
    expect((got.data as { ticket: { handle: string } }).ticket.handle).toBe(`ticket-B2C-${seq}`)
    await executeTool({
      toolName: "tickets:setAudience",
      orgId,
      actor,
      params: { ticketId: handles.target!, audience: "b2b" },
    })
  })

  it("create returns the display handle", async () => {
    // Segment by team for this case: a ticket filed for team Ops is born OPS.
    const setSeg = (seg: string) =>
      withSystemDb("search-handle-key-seg", (tx) =>
        tx.execute(drizzleSql`
          UPDATE kernel.organizations
          SET settings = jsonb_set(settings, '{tickets,idSegment}', ${seg}::jsonb, true)
          WHERE id = ${orgId}
        `),
      )
    await setSeg('{"by":"team","codes":{"Ops":"OPS"}}')
    try {
      const out = await executeTool({
        toolName: "tickets:create",
        orgId,
        actor,
        params: { subject: "Segmented create", team: "Ops" },
      })
      expect((out.data as { ticketHandle: string }).ticketHandle).toMatch(/^ticket-OPS-\d+$/)
    } finally {
      await setSeg('{"by":"audience","codes":{"b2b":"B2B","b2c":"B2C"}}')
    }
  })

  it("get by any form returns the display handle", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId: `ticket-B2C-${seq}` },
    })
    const data = out.data as { ticket: { id: string; handle: string } }
    expect(data.ticket.id).toBe(handles.target!)
    expect(data.ticket.handle).toBe(`ticket-B2B-${seq}`)
  })
})
