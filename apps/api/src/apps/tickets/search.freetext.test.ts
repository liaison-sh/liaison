// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression (BL-213): tickets:search free-text matching. The manifest documents
// `q`/`query` as "free-text search across subject and body", and the old
// implementation had two bugs: (a) it read only `query` (ignoring the
// documented-primary `q`), and (b) it did a single whole-string substring match
// on subject+handle ONLY, so multi-word queries required the words contiguous
// in the subject and never matched body/contact text.
//
// MIGRATION NOTE (unified-search retarget, spec §3.5): free-text matching now
// goes entirely through the shared search executor (`resolveTicketMatches`)
// against the real Meili-backed index — SQL ILIKE substring matching is
// intentionally GONE (see search.ts's deletion of the old ILIKE/AND-OR-recall
// logic). This unit-tier file cannot boot a live Meili (it runs under the
// "unit" suite, no Meili in that harness), so it no longer asserts actual
// text-matching semantics (scattered terms, partial-term recall, tokenized
// AND/OR fallback) — those are Meili's job now and are inherently untestable
// without a live index. What THIS file still validates at the unit tier,
// using the `TicketsSearchTestAccess.setMatchResolver` injection seam:
//   - the documented-primary `q` param (not just `query`) reaches the resolver
//   - the resolver's returned id set is what actually gets returned (the SQL
//     id-join contract), for both a subject-shaped and a body/contact-shaped
//     resolution
// Genuine end-to-end text-matching coverage (scattered terms, body-only
// matches, contact email/name matches, partial-term recall) now lives in the
// scenario tier: apps/api/src/tests/e2e/search-unified.scenario.test.ts,
// which drives a real Postgres + real Meili + real indexer.
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
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
  subject: string
  body: string
  contactId?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `ft-${opts.key}-${Math.floor(Math.random() * 1e9)}`
  handles[opts.key] = id
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("search-freetext-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, contact_id,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${opts.subject}, 'open', 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour', ${opts.contactId ?? null},
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

async function seedContact(email: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `ct-${Math.floor(Math.random() * 1e12)}`
  await withSystemDb("search-freetext-contact", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.contacts (id, org_id, handle, email, name, created_at, updated_at)
      VALUES (${id}, ${orgId}, ${handle}, ${email}, ${name}, now(), now())
    `)
  })
  return id
}

async function searchIds(params: Record<string, unknown>): Promise<string[]> {
  const out = await executeTool({ toolName: "tickets:search", orgId, actor, params })
  return ((out.data as { items: { id: string }[] }).items ?? []).map((r) => r.id)
}

beforeAll(async () => {
  const slug = `search-freetext-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("search-freetext-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Search FT', ${slug}) RETURNING id
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

  // Two handshake tickets — kept as background rows the resolver's injected id
  // set can select a subset of, exercising the id-join restricting to exactly
  // the resolved ids (not "everything matching some relational filter").
  await seed({
    key: "handshake1",
    subject: "Editor handshake failure — Kestrel 6 won't connect to the Editor app",
    body: "The Editor app can't complete the handshake; it times out on connect.",
  })
  await seed({
    key: "handshake2",
    subject: "Editor won't sync — handshake keeps failing",
    body: "Every time I open the Editor it fails the handshake and never syncs.",
  })
  // A body-only term ticket: no text-matching claim is made about it here
  // (Meili's job now) — it exists as a distinct background row for the
  // id-join restriction tests.
  await seed({
    key: "presetBody",
    subject: "Presets unusable after the v2.4 update",
    body: "Every saved preset is garbled and won't load since the firmware update.",
  })
  // An unrelated ticket that must NOT appear when the resolver excludes it.
  await seed({
    key: "unrelated",
    subject: "Shipping label won't print",
    body: "The packing slip printer is jammed.",
  })

  // Contact-identity-linked ticket — subject/body never mention the contact,
  // kept as a background row for the id-join tests (real contact-identity
  // matching coverage is in the scenario tier).
  const returnContact = await seedContact("wanda.maximoff@avengers.test", "Wanda Maximoff")
  await seed({
    key: "contactOnly",
    subject: "Request to return my order",
    body: "Hi, I'd like to return the unit. Please send return instructions. Thank you.",
    contactId: returnContact,
  })
})

afterEach(() => {
  TicketsSearchTestAccess.setMatchResolver(null)
})

describe("tickets.search free-text (BL-213) — id-join contract via injected resolver", () => {
  it("the documented-primary `q` param reaches the resolver (was silently ignored)", async () => {
    let receivedQ: string | undefined
    TicketsSearchTestAccess.setMatchResolver(async ({ q }) => {
      receivedQ = q
      return [handles.handshake1, handles.handshake2]
    })
    const ids = await searchIds({ q: "handshake", limit: 50 })
    expect(receivedQ).toBe("handshake")
    expect(ids).toContain(handles.handshake1)
    expect(ids).toContain(handles.handshake2)
    expect(ids).not.toContain(handles.unrelated)
  })

  it("`query` (the inbox-UI alias) also reaches the resolver", async () => {
    let receivedQ: string | undefined
    TicketsSearchTestAccess.setMatchResolver(async ({ q }) => {
      receivedQ = q
      return [handles.handshake1, handles.handshake2]
    })
    const ids = await searchIds({ query: "Editor handshake", limit: 50 })
    expect(receivedQ).toBe("Editor handshake")
    expect(ids).toContain(handles.handshake1)
    expect(ids).toContain(handles.handshake2)
    expect(ids).not.toContain(handles.unrelated)
  })

  it("only the resolver's returned ids are returned — a resolved set restricted to ONE ticket excludes its siblings", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => [handles.presetBody])
    const ids = await searchIds({ q: "garbled", limit: 50 })
    expect(ids).toEqual([handles.presetBody])
    expect(ids).not.toContain(handles.handshake1)
  })

  it("a resolved id set spanning subject- and contact-linked tickets restricts to exactly that set", async () => {
    // Simulates what Meili WOULD return for a contact-identity query (the
    // nachumi_e@me.com report: a ticket found by its linked contact's email,
    // even though the subject/body never quote it) — asserts the SQL layer
    // returns exactly the resolved set, not a superset/subset.
    TicketsSearchTestAccess.setMatchResolver(async () => [handles.contactOnly])
    const ids = await searchIds({ q: "wanda.maximoff@avengers.test", limit: 50 })
    expect(ids).toEqual([handles.contactOnly])
    expect(ids).not.toContain(handles.unrelated)
  })

  it("an empty resolved id set returns zero rows, not every ticket", async () => {
    TicketsSearchTestAccess.setMatchResolver(async () => [])
    const ids = await searchIds({ q: "nomatch-anywhere", limit: 50 })
    expect(ids).toEqual([])
  })
})
