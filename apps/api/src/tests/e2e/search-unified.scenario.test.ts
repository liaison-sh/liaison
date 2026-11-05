// SPDX-License-Identifier: FSL-1.1-ALv2
// Unified-search retarget (spec §3.1-§3.6) end-to-end coverage: real Postgres +
// real Meili + real indexer, exercising the full contract that the unit-tier
// tests (search.freetext.test.ts, search.scale.test.ts) can no longer assert
// once free-text matching became Meili's job rather than SQL ILIKE.
//
// Covers, in ONE scenario world (kept minimal for boot cost) except the
// deliberately isolated Meili-down sub-case (its own tiny second world):
//   a. Nachumi-shaped fixture: contact + subject-silent tickets, found via
//      /api/search, /api/search/page, and the tickets:search tool; recall
//      parity between the inbox tool and /search/page.
//   b. Freshness on the inbound path: a fresh term appended via the durable
//      `message:create` event (the same event appendInboundToTicket queues)
//      becomes searchable within budget.
//   c. Sensitivity negative: a low-clearance user gets zero hits (and no body
//      leak) on a restricted ticket; a granted user matches.
//   d. Team-scoped positive via the NAMESPACED `tickets:team` grant key,
//      proving the expand-to-bare mapping end to end through the tool.
//   e. Meili-down degradation: SEARCH_UNAVAILABLE envelope / 503, empty-query
//      tickets:search still works.
//   f. Body-cap: a term near the end of the 30KB newest-first budget is
//      found; a term beyond the cap (oldest, truncated-away text) is not.
//
// SUBSTITUTION NOTE (b): there is no exported hook to call
// `appendInboundToTicket` directly from a scenario test (it is a private
// function in apps/tickets/inbound.ts; the real inbound paths are Gmail
// push / IMAP fixtures, which are heavyweight OIDC+HTTP fixture setups
// exercised elsewhere in tickets-email-inbound.scenario.test.ts). This test
// instead drives the SAME durable event the function queues
// (`{app:'tickets', entity:'message', action:'create', data:{ticketId}}`,
// inserted into `pending_events` — mirroring the existing
// `enqueueIndexerEvent` helper pattern used by search-permissions.scenario.
// test.ts) after inserting the message row directly. This exercises the
// exact re-index trigger and freshness budget the inbound path relies on,
// without re-deriving Gmail/IMAP wire fixtures.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes, login } from "@liaison/test-helpers"
import { MeiliSearch } from "meilisearch"
import { ks, seedInbox, seedTicket, seedTicketMessages, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

const POLL_TICK_MS = 200
const INDEX_POLL_BUDGET_MS = 30_000
const FRESHNESS_BUDGET_MS = 5_000

function meiliClient(host?: string): MeiliSearch {
  return new MeiliSearch({
    host: host ?? process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
    apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
  })
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  budgetMs: number,
  tickMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + budgetMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v !== null) return v
    } catch (err) {
      last = err
    }
    await Bun.sleep(tickMs)
  }
  throw new Error(`pollUntil(${label}) timed out after ${budgetMs}ms; last error: ${String(last)}`)
}

/** Enqueue the generic manifest-driven `{app:'tickets', entity:'ticket',
 *  action:'create'}` durable event so a directly-SQL-seeded ticket (which
 *  bypasses createTicket's own queueEvent call) still gets indexed — mirrors
 *  search-permissions.scenario.test.ts's `enqueueIndexerEvent` helper. */
async function enqueueTicketCreateEvent(
  env: WorkerEnv,
  orgId: string,
  actorId: string,
  ticketId: string,
): Promise<void> {
  const payload = {
    app: "tickets",
    entity: "ticket",
    action: "create",
    entityId: ticketId,
    orgId,
    actorId,
    actorType: "system",
    timestamp: new Date().toISOString(),
  }
  const tableName = `${env.schemaPrefix}kernel`
  await env.db.sql`
    INSERT INTO ${env.db.sql(tableName)}.pending_events (org_id, payload)
    VALUES (${orgId}, ${env.db.sql.json(payload as any)})
  `
}

/** Enqueue a `{app:'kernel', entity:'contact', action:'create'}` durable
 *  event so a directly-SQL-seeded contact (bypassing the contacts service's
 *  own queueEvent call) is indexed as a searchable/mentionable kernel
 *  built-in (searchable-entities.ts's KERNEL_BUILTINS "contact" entry). */
async function enqueueContactCreateEvent(
  env: WorkerEnv,
  orgId: string,
  actorId: string,
  contactId: string,
): Promise<void> {
  const payload = {
    app: "kernel",
    entity: "contact",
    action: "create",
    entityId: contactId,
    orgId,
    actorId,
    actorType: "system",
    timestamp: new Date().toISOString(),
  }
  const tableName = `${env.schemaPrefix}kernel`
  await env.db.sql`
    INSERT INTO ${env.db.sql(tableName)}.pending_events (org_id, payload)
    VALUES (${orgId}, ${env.db.sql.json(payload as any)})
  `
}

async function enqueueMessageCreateEvent(
  env: WorkerEnv,
  orgId: string,
  actorId: string,
  ticketId: string,
): Promise<void> {
  const payload = {
    app: "tickets",
    entity: "message",
    action: "create",
    entityId: crypto.randomUUID(),
    data: { ticketId },
    orgId,
    actorId,
    actorType: "system",
    timestamp: new Date().toISOString(),
  }
  const tableName = `${env.schemaPrefix}kernel`
  await env.db.sql`
    INSERT INTO ${env.db.sql(tableName)}.pending_events (org_id, payload)
    VALUES (${orgId}, ${env.db.sql.json(payload as any)})
  `
}

async function callToolHttp(
  env: WorkerEnv,
  token: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await api(env.serverUrl, `/api/apps/tools/${toolName}`, {
    method: "POST",
    token,
    body: { params },
  })
  return { status: res.status, body: res.body }
}

async function seedContact(
  env: WorkerEnv,
  orgId: string,
  opts: { name: string; email: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const handle = `ct-${Math.floor(Math.random() * 1e12)}`
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.contacts (id, org_id, handle, email, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [id, orgId, handle, opts.email, opts.name],
  )
  return { id }
}

async function indexNameFor(env: WorkerEnv): Promise<string> {
  return `${env.meiliIndexPrefix}liaison_search`
}

describe("[unified-search] Nachumi-shaped fixture, freshness, sensitivity, team-scope, degradation, body-cap", () => {
  let env: WorkerEnv
  let world: TestWorld
  let inboxId: string
  let nachumiContactId: string
  let nachumiTicketA: string
  let nachumiTicketB: string
  let restrictedTicketId: string
  let teamTicketId: string
  let capTicketFoundId: string
  let capTicketNotFoundTerm: string

  beforeAll(async () => {
    const result = await setupScenario({ seed: 720, org: { name: "Unified Search Org" } })
    env = result.env
    world = result.world

    const inbox = await seedInbox(env, { orgId: world.org.id, name: "Unified search inbox" })
    inboxId = inbox.id

    // (a) Nachumi-shaped fixture: contact + 2 tickets whose SUBJECTS never
    // mention the name; body carries a distinctive term.
    const contact = await seedContact(env, world.org.id, {
      name: "Nachumi Eliyahu",
      email: "nachumi@example.com",
    })
    nachumiContactId = contact.id
    await enqueueContactCreateEvent(env, world.org.id, world.admin.id, nachumiContactId)
    const tA = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Order status question",
      contactId: nachumiContactId,
      sourceInboxId: inboxId,
    })
    nachumiTicketA = tA.id
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: nachumiTicketA,
      messages: [
        { kind: "inbound", textBody: "Hi, checking on my order, it mentions a zorblatt part." },
      ],
    })
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, nachumiTicketA)
    const tB = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Return request",
      contactId: nachumiContactId,
      sourceInboxId: inboxId,
    })
    nachumiTicketB = tB.id
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: nachumiTicketB,
      messages: [
        { kind: "inbound", textBody: "Following up again — still waiting on the zorblatt fix." },
      ],
    })
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, nachumiTicketB)

    // (c) Sensitivity negative fixture: a restricted ticket with a probe term
    // in the body.
    const restricted = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Confidential escalation",
      sensitivity: "restricted",
      team: "support-secure",
      sourceInboxId: inboxId,
    })
    restrictedTicketId = restricted.id
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: restrictedTicketId,
      messages: [
        { kind: "inbound", textBody: "The probe term is quixotrope for this escalation." },
      ],
    })
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, restrictedTicketId)

    // (d) Team-scoped positive fixture.
    const teamTicket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "EU support routing question",
      team: "support-eu-alpha",
      sourceInboxId: inboxId,
    })
    teamTicketId = teamTicket.id
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: teamTicketId,
      messages: [{ kind: "inbound", textBody: "Team-scoped body term: floxinated widget." }],
    })
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, teamTicketId)

    // (f) Body-cap fixture: newest-first budget is 30,000 bytes. Seed one
    // OLD (truncated-away) message with a unique term, then enough padding
    // messages, then a NEW message whose unique term sits near the END of
    // the 30KB budget (i.e. still within it since it's newest-first).
    const capTicket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Body cap boundary ticket",
      sourceInboxId: inboxId,
    })
    capTicketFoundId = capTicket.id
    capTicketNotFoundTerm = "unreachabletermxyzoutsidebudget"
    // BODY_BYTE_BUDGET (search-enrichment.ts) is 30,000 bytes; enrichment
    // joins messages newest-first with "\n" and truncates the JOINED string
    // to that budget. Use a wide margin on both sides so this isn't sensitive
    // to newline/whitespace-byte-counting off-by-few: ~20 padding messages of
    // 2,000 bytes each (~40,000 bytes total) guarantee the OLDEST message
    // (appended LAST in the newest-first join, so it's what gets truncated
    // away) sits well past the 30KB cutoff, while the findable term (FIRST in
    // the join, tiny) sits well within it.
    const padding = "x".repeat(2_000)
    const PADDING_MESSAGES = 20
    const messages: Array<{ kind: "inbound"; textBody: string; sentAtOffsetSeconds: number }> = []
    // Oldest message (most negative offset = sent first = truncated away first
    // since enrichment reads ORDER BY sent_at DESC and truncates newest-first).
    messages.push({
      kind: "inbound",
      textBody: `${capTicketNotFoundTerm} ${padding}`,
      sentAtOffsetSeconds: -100_000,
    })
    // Padding messages sent progressively more recently, pushing the oldest
    // message's term well past the 30KB newest-first cutoff.
    for (let i = PADDING_MESSAGES; i >= 1; i--) {
      messages.push({
        kind: "inbound",
        textBody: padding,
        sentAtOffsetSeconds: -i * 100,
      })
    }
    // Newest message: distinctive findable term, well within budget.
    messages.push({
      kind: "inbound",
      textBody: "findableboundarytermabc present in the newest message",
      sentAtOffsetSeconds: -10,
    })
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: capTicketFoundId,
      messages,
    })
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, capTicketFoundId)

    // Wait for the initial full-org indexing pass to ingest every seeded
    // ticket AND the contact before any sub-test polls for a specific one.
    const indexName = await indexNameFor(env)
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search("", { limit: 1, filter: `entity_type = "ticket"` })
          .catch(() => null)
        if (!search) return null
        return search.estimatedTotalHits >= 5 ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "initial ticket indexing",
    )
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search("", { limit: 1, filter: `entity_type = "contact"` })
          .catch(() => null)
        if (!search) return null
        return search.estimatedTotalHits >= 1 ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "initial contact indexing",
    )
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("(a) nachumi: contact and both subject-silent tickets are found via /api/search, /api/search/page, and tickets:search; body-term search finds both via /search/page; inbox tool set matches /search/page set", async () => {
    // /api/search (global) — grouped response with contacts[] + entities[].
    const globalRes = await pollUntil(
      async () => {
        const res = await api(env.serverUrl, `/api/search?q=nachumi&limit=20`, {
          token: world.admin.token,
        })
        if (res.status !== 200) return null
        const contactHit = (res.body?.data?.contacts ?? []).find(
          (c: any) => c.id === nachumiContactId,
        )
        const entityIds = (res.body?.data?.entities ?? []).map((e: any) => e.id)
        if (
          contactHit &&
          entityIds.includes(nachumiTicketA) &&
          entityIds.includes(nachumiTicketB)
        ) {
          return res.body.data
        }
        return null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "global search nachumi",
    )
    expect(globalRes.contacts.some((c: any) => c.id === nachumiContactId)).toBe(true)

    // /api/search/page — flat hits array, entity-scoped to tickets.
    const pageRes = await api(
      env.serverUrl,
      `/api/search/page?q=nachumi&limit=20&entityType=ticket`,
      { token: world.admin.token },
    )
    expect(pageRes.status).toBe(200)
    const pageIds = (pageRes.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(pageIds).toContain(nachumiTicketA)
    expect(pageIds).toContain(nachumiTicketB)

    // tickets:search tool — same query, real actor via HTTP tool route.
    const toolRes = await callToolHttp(env, world.admin.token, "tickets:search", {
      q: "nachumi",
      limit: 50,
    })
    expect(toolRes.status).toBe(200)
    const toolIds = (toolRes.body.data.items as any[]).map((t) => t.id)
    expect(toolIds).toContain(nachumiTicketA)
    expect(toolIds).toContain(nachumiTicketB)

    // Body-term search ("zorblatt") via /search/page.
    const bodyRes = await api(
      env.serverUrl,
      `/api/search/page?q=zorblatt&limit=20&entityType=ticket`,
      { token: world.admin.token },
    )
    expect(bodyRes.status).toBe(200)
    const bodyIds = (bodyRes.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(bodyIds).toContain(nachumiTicketA)
    expect(bodyIds).toContain(nachumiTicketB)

    // Recall parity: the inbox tool's ticket set == /search/page ticket set
    // for the same query.
    expect(new Set(toolIds)).toEqual(new Set(pageIds))
  }, 60_000)

  it("(g) dedupe: fragment tickets of ONE conversation (same contact, Re:-chained subjects) collapse to a single hit on /search/page and the palette, while the inbox tool still lists every real row", async () => {
    // Mirrors the prod artifact that motivated dedupe: a mail sync/import can
    // fragment one email conversation into N ticket rows ("Re: Request to
    // Return ORDER #2936" x4). Human-facing surfaces must show ONE result
    // however many fragments (or messages) exist; the inbox work list must
    // NOT hide real rows.
    const convTerm = "murbleflax"
    const contact = await seedContact(env, world.org.id, {
      name: "Dedupe Dana",
      email: "dedupe.dana@example.com",
    })
    const subjects = [
      "Warranty claim for pad unit",
      "Re: Warranty claim for pad unit",
      "RE: re: Warranty claim for pad unit",
      "Re[2]: warranty claim   for pad unit",
    ]
    const fragmentIds: string[] = []
    for (const subject of subjects) {
      const t = await seedTicket(env, {
        orgId: world.org.id,
        subject,
        contactId: contact.id,
        sourceInboxId: inboxId,
      })
      fragmentIds.push(t.id)
      await seedTicketMessages(env, {
        orgId: world.org.id,
        ticketId: t.id,
        messages: [{ kind: "inbound", textBody: `Conversation fragment mentioning ${convTerm}.` }],
      })
      await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, t.id)
    }

    // Wait until ALL fragments are indexed — the inbox tool has no dedupe, so
    // it converges to the full set.
    const toolIds = await pollUntil(
      async () => {
        const res = await callToolHttp(env, world.admin.token, "tickets:search", {
          q: convTerm,
          limit: 50,
        })
        if (res.status !== 200) return null
        const ids = (res.body?.data?.items ?? []).map((t: any) => t.id)
        return fragmentIds.every((id) => ids.includes(id)) ? ids : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "dedupe fragments indexed (inbox tool full set)",
    )
    expect(new Set(toolIds)).toEqual(new Set(fragmentIds))

    // /search/page: exactly ONE hit for the whole conversation.
    const pageRes = await api(
      env.serverUrl,
      `/api/search/page?q=${convTerm}&limit=20&entityType=ticket`,
      { token: world.admin.token },
    )
    expect(pageRes.status).toBe(200)
    const pageHits = (pageRes.body.data as any[]).filter((h) =>
      fragmentIds.includes(h.entity_id ?? h.id),
    )
    expect(pageHits.length).toBe(1)

    // Palette (/api/search): at most one of the fragments in the entities bucket.
    const globalRes = await api(env.serverUrl, `/api/search?q=${convTerm}&limit=20`, {
      token: world.admin.token,
    })
    expect(globalRes.status).toBe(200)
    const paletteFragmentHits = ((globalRes.body?.data?.entities ?? []) as any[]).filter((e) =>
      fragmentIds.includes(e.id),
    )
    expect(paletteFragmentHits.length).toBe(1)
  }, 60_000)

  it("(b) freshness: an inbound-shaped message appended via the durable message:create event becomes searchable within budget", async () => {
    const freshTerm = `freshinbound${Date.now()}`
    const [row] = await env.db.sql.unsafe(
      `INSERT INTO ${ts(env)}.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'inbound', $3, now(), now(), now())
       RETURNING id`,
      [world.org.id, nachumiTicketA, `A fresh inbound reply mentioning ${freshTerm}.`],
    )
    expect(row?.id).toBeTruthy()

    const start = Date.now()
    await enqueueMessageCreateEvent(env, world.org.id, world.admin.id, nachumiTicketA)

    await pollUntil(
      async () => {
        const res = await api(
          env.serverUrl,
          `/api/search/page?q=${freshTerm}&limit=10&entityType=ticket`,
          { token: world.admin.token },
        )
        if (res.status !== 200) return null
        const ids = (res.body.data as any[]).map((h) => h.entity_id ?? h.id)
        return ids.includes(nachumiTicketA) ? true : null
      },
      FRESHNESS_BUDGET_MS + 4_000,
      POLL_TICK_MS,
      "freshness re-index",
    )
    const elapsedMs = Date.now() - start
    expect(elapsedMs).toBeLessThanOrEqual(FRESHNESS_BUDGET_MS + 4_000)
  }, 30_000)

  it("(c) sensitivity negative: a low-clearance user gets zero hits (and no body leak) on the restricted ticket across /search, /search/page, and /mentions; a granted user matches", async () => {
    const probeTerm = "quixotrope"
    // Wait for the restricted ticket to be indexed at all (verified via Meili
    // directly, filtered to entity_type, since the admin actor used to poll
    // has no explicit sensitivity/team grant and would otherwise be gated
    // out by its OWN permission filter rather than by indexing lag).
    const indexName = await indexNameFor(env)
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search(probeTerm, { limit: 5, filter: `entity_type = "ticket"` })
          .catch(() => null)
        if (!search) return null
        return search.hits.some((h: any) => h.entity_id === restrictedTicketId) ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "restricted ticket indexing",
    )

    const lowUser = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Low Clearance",
        // kernel:threads:read is required by the /api/mentions route mount
        // (app.ts: authMw, orgLimiter, requireScope("kernel:threads:read")) —
        // independent of the tickets read scope that gates the ticket doc itself.
        scopes: ["tickets:tickets:read", "kernel:threads:read"],
        dimensions: { "tickets:team": ["support-secure"], "tickets:sensitivity": ["internal"] },
        schemaPrefix: env.schemaPrefix,
        password: "LowClear1!",
      },
    )
    const highUser = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "High Clearance",
        scopes: ["tickets:tickets:read", "kernel:threads:read"],
        dimensions: { "tickets:team": ["support-secure"], "tickets:sensitivity": ["restricted"] },
        schemaPrefix: env.schemaPrefix,
        password: "HighClear1!",
      },
    )

    // Low-clearance: zero hits everywhere, and the restricted body text never
    // leaks into the response body.
    const lowGlobal = await api(env.serverUrl, `/api/search?q=${probeTerm}&limit=20`, {
      token: lowUser.token,
    })
    expect(lowGlobal.status).toBe(200)
    const lowGlobalEntityIds = (lowGlobal.body.data.entities ?? []).map((e: any) => e.id)
    expect(lowGlobalEntityIds).not.toContain(restrictedTicketId)

    const lowPage = await api(
      env.serverUrl,
      `/api/search/page?q=${probeTerm}&limit=20&entityType=ticket`,
      { token: lowUser.token },
    )
    expect(lowPage.status).toBe(200)
    const lowPageIds = (lowPage.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(lowPageIds).not.toContain(restrictedTicketId)
    // No snippet leak: the restricted body text never appears anywhere in
    // the low-clearance response body.
    expect(JSON.stringify(lowPage.body)).not.toContain(probeTerm)

    const lowMentions = await api(
      env.serverUrl,
      `/api/mentions?q=${probeTerm}&limit=20&type=entity`,
      { token: lowUser.token },
    )
    expect(lowMentions.status).toBe(200)
    const lowMentionIds = (lowMentions.body.data as any[]).map((m: any) => m.id)
    expect(lowMentionIds).not.toContain(restrictedTicketId)

    // High-clearance: matches on all three surfaces.
    const highPage = await api(
      env.serverUrl,
      `/api/search/page?q=${probeTerm}&limit=20&entityType=ticket`,
      { token: highUser.token },
    )
    expect(highPage.status).toBe(200)
    const highPageIds = (highPage.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(highPageIds).toContain(restrictedTicketId)

    const highMentions = await api(
      env.serverUrl,
      `/api/mentions?q=${probeTerm}&limit=20&type=entity`,
      { token: highUser.token },
    )
    expect(highMentions.status).toBe(200)
    const highMentionIds = (highMentions.body.data as any[]).map((m: any) => m.id)
    expect(highMentionIds).toContain(restrictedTicketId)
  }, 60_000)

  it("(d) team-scoped positive: a user granted the NAMESPACED tickets:team key finds the ticket via tickets:search (proves the namespaced-to-bare mapping)", async () => {
    const teamTerm = "floxinated"
    const indexName = await indexNameFor(env)
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search(teamTerm, { limit: 5, filter: `entity_type = "ticket"` })
          .catch(() => null)
        if (!search) return null
        return search.hits.some((h: any) => h.entity_id === teamTicketId) ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "team ticket indexing",
    )

    const teamUser = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Team Scoped User",
        scopes: ["tickets:tickets:read"],
        // Namespaced grant key, mirroring the real grant tooling (tools.ts /
        // jobs.ts both emit "tickets:team"/"tickets:sensitivity" — NOT the
        // bare "team"/"sensitivity" the Meili doc field uses). This proves
        // expandTicketSearchDimensionGrants's namespaced->bare merge works
        // end to end through the HTTP tool route, not just at the unit level.
        dimensions: { "tickets:team": ["support-eu-alpha"], "tickets:sensitivity": ["internal"] },
        schemaPrefix: env.schemaPrefix,
        password: "TeamScope1!",
      },
    )

    const toolRes = await callToolHttp(env, teamUser.token, "tickets:search", {
      q: teamTerm,
      limit: 20,
    })
    expect(toolRes.status).toBe(200)
    const ids = (toolRes.body.data.items as any[]).map((t) => t.id)
    expect(ids).toContain(teamTicketId)
  }, 60_000)

  it("(f) body-cap: a term near the end of the 30KB newest-first budget is found; a term beyond the cap (oldest, truncated-away text) is not", async () => {
    const indexName = await indexNameFor(env)
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search("findableboundarytermabc", { limit: 5, filter: `entity_type = "ticket"` })
          .catch(() => null)
        if (!search) return null
        return search.hits.some((h: any) => h.entity_id === capTicketFoundId) ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "body-cap ticket indexing",
    )

    const foundRes = await api(
      env.serverUrl,
      `/api/search/page?q=findableboundarytermabc&limit=10&entityType=ticket`,
      { token: world.admin.token },
    )
    expect(foundRes.status).toBe(200)
    const foundIds = (foundRes.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(foundIds).toContain(capTicketFoundId)

    const notFoundRes = await api(
      env.serverUrl,
      `/api/search/page?q=${capTicketNotFoundTerm}&limit=10&entityType=ticket`,
      { token: world.admin.token },
    )
    expect(notFoundRes.status).toBe(200)
    const notFoundIds = (notFoundRes.body.data as any[]).map((h) => h.entity_id ?? h.id)
    expect(notFoundIds).not.toContain(capTicketFoundId)
  }, 60_000)
})

describe("[unified-search] Meili-down degradation", () => {
  let env: WorkerEnv
  let world: TestWorld
  let ticketId: string

  beforeAll(async () => {
    // SUBSTITUTION NOTE: an unreachable Meili HOST at BOOT is not a
    // degradation scenario at all — `runPhase10Boot`'s `detectDrift()` call
    // is on the startup critical path (apps/api/src/infra/boot-phase10.ts)
    // and its uncaught error crashes the process (apps/api/src/index.ts's
    // top-level catch -> process.exit(1)), by design (fail fast on a
    // mis-configured deployment). So a bad MEILISEARCH_HOST from boot cannot
    // exercise the runtime SEARCH_UNAVAILABLE envelope — it just kills the
    // server before it ever answers a request. The real degradation path is
    // a Meili that was healthy AT BOOT (isSearchReady() flips true) and then
    // fails mid-run — exactly search-drift.scenario.test.ts's delete-the-
    // index-out-from-under-the-running-server pattern, reused here without
    // its subsequent restart (this sub-case wants the index to STAY missing
    // and prove the query-time 503/SEARCH_UNAVAILABLE envelope, not drift
    // recovery).
    // Its own server: this case deletes the live index and leaves it deleted.
    // On a shared lane the next files' writes then auto-created the index with
    // no primary key, every later write on that lane failed, and a later file's
    // search answered 503 (search-permissions).
    const result = await setupScenario({
      seed: 721,
      org: { name: "Meili Down Org" },
      ownServer: true,
    })
    env = result.env
    world = result.world

    const inbox = await seedInbox(env, { orgId: world.org.id, name: "Down inbox" })
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Ticket seeded before Meili goes down",
      sourceInboxId: inbox.id,
    })
    ticketId = t.id
    await enqueueTicketCreateEvent(env, world.org.id, world.admin.id, ticketId)

    // Confirm the index is live/populated before breaking it, mirroring
    // search-drift.scenario.test.ts's "initial indexing" wait.
    const indexName = await indexNameFor(env)
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search("", { limit: 1, filter: `entity_type = "ticket"` })
          .catch(() => null)
        return search && search.estimatedTotalHits >= 1 ? true : null
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "pre-outage indexing",
    )

    // Delete the index out from under the running server — the same
    // mechanism search-drift.scenario.test.ts uses, but WITHOUT a restart
    // afterward: the running process still believes isSearchReady() (no
    // drift sweep has run to notice), so the next query hits Meili, gets an
    // index-not-found error, and surfaces MeiliUnavailableError /
    // TicketSearchUnavailableError through the real query-time path.
    const meili = meiliClient()
    const deleteTask = await meili.deleteIndex(indexName).catch(() => null)
    if (deleteTask && (deleteTask as { taskUid?: number }).taskUid != null) {
      await meili.tasks.waitForTask((deleteTask as { taskUid: number }).taskUid)
    }
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("tickets:search with a non-empty query returns the SEARCH_UNAVAILABLE envelope; /api/search returns 503; empty-query tickets:search still works (pure SQL)", async () => {
    const toolRes = await callToolHttp(env, world.admin.token, "tickets:search", {
      q: "anything",
      limit: 10,
    })
    expect(toolRes.status).toBe(503)
    expect(toolRes.body?.error?.code).toBe("SEARCH_UNAVAILABLE")

    const globalRes = await api(env.serverUrl, `/api/search?q=anything&limit=10`, {
      token: world.admin.token,
    })
    expect(globalRes.status).toBe(503)
    expect(globalRes.body?.error?.code).toBe("SEARCH_UNAVAILABLE")

    // Empty-query listing never touches the resolver — pure relational
    // listing, unaffected by Meili being down.
    const emptyQueryRes = await callToolHttp(env, world.admin.token, "tickets:search", {
      limit: 10,
    })
    expect(emptyQueryRes.status).toBe(200)
    const ids = (emptyQueryRes.body.data.items as any[]).map((t) => t.id)
    expect(ids).toContain(ticketId)
  }, 30_000)
})
