// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 BE-2] Search permission filter + permission-affecting mutations
// ---------------------------------------------------------------------------
// Spec refs: S3, S5, §3.1.5.
//
// Verifies that:
//   - The Meili `filter` clause honors `read_scope` and dimension grants
//     ("team") so each actor only sees the tickets they're authorized for.
//   - Permission-affecting mutations (team change, dimension revoke, scope
//     revoke) propagate to search within the S5 budget.
//   - A user with zero authorized read scopes triggers the empty-scope
//     short-circuit (200 with empty result set, no 500).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes, login } from "@liaison/test-helpers"
import { MeiliSearch } from "meilisearch"
import { ks, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

function meiliClient(): MeiliSearch {
  return new MeiliSearch({
    host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
    apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
  })
}

const POLL_TICK_MS = 200
const INDEX_POLL_BUDGET_MS = 30_000
const MUTATION_POLL_BUDGET_MS = 5_000

async function pollUntil(
  fn: () => Promise<boolean>,
  budgetMs: number,
  tickMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (err) {
      last = err
    }
    await Bun.sleep(tickMs)
  }
  throw new Error(`pollUntil(${label}) timed out after ${budgetMs}ms; last error: ${String(last)}`)
}

async function enqueueIndexerEvent(
  env: WorkerEnv,
  orgId: string,
  actorId: string,
  entity: string,
  action: string,
  entityId: string,
): Promise<void> {
  const payload = {
    app: "tickets",
    entity,
    action,
    entityId,
    orgId,
    actorId,
    actorType: "user",
    timestamp: new Date().toISOString(),
  }
  // Use postgres.js's `sql.json()` so the jsonb column receives the payload
  // as a real JSON object (matching the production queueEvent path). Raw
  // `JSON.stringify(payload)::jsonb` round-trips the value as a *string*
  // containing JSON, not a JSON object — downstream consumers then read
  // `event.app` as undefined and drop the event silently.
  const tableName = `${env.schemaPrefix}kernel`
  await env.db.sql`
    INSERT INTO ${env.db.sql(tableName)}.pending_events (org_id, payload)
    VALUES (${orgId}, ${env.db.sql.json(payload as any)})
  `
}

async function searchTicketsAs(
  env: WorkerEnv,
  token: string,
): Promise<{ status: number; ids: string[]; body: any }> {
  const res = await api(env.serverUrl, `/api/search/page?q=usb&limit=50&app=tickets`, { token })
  if (res.status !== 200) {
    return { status: res.status, ids: [], body: res.body }
  }
  const hits: any[] = res.body?.data ?? []
  return {
    status: res.status,
    ids: hits.map((h: any) => (h.entity_id ?? h.id) as string),
    body: res.body,
  }
}

describe("Search permission filter", () => {
  let env: WorkerEnv
  let world: TestWorld
  let userA: { id: string; email: string; password: string; token: string }
  let userB: { id: string; email: string; password: string; token: string }
  const usPassword = "ABCdef12!"
  const ticketIds: { alpha: string[]; beta: string[] } = { alpha: [], beta: [] }
  let userBRoleId: string

  beforeAll(async () => {
    const result = await setupScenario({ seed: 702, org: { name: "Search Perms Org" } })
    env = result.env
    world = result.world

    const aCreated = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Alice Alpha",
        scopes: ["tickets:tickets:read"],
        // `sensitivity` joined `team` in the ticket entity's dimensionFields
        // (unified-search). A searcher with NO sensitivity grant now defaults
        // to the lowest band (RLS COALESCE-0 parity in
        // expandTicketSearchDimensionGrants) — the explicit grant here just
        // keeps these tests exercising TEAM gating only.
        dimensions: { team: ["support-us"], sensitivity: ["internal"] },
        schemaPrefix: env.schemaPrefix,
        password: usPassword,
      },
    )
    const bCreated = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Bob Beta",
        scopes: ["tickets:tickets:read"],
        // See Alice's comment: base sensitivity grant so team gating stays
        // the only variable under test.
        dimensions: { team: ["support-eu"], sensitivity: ["internal"] },
        schemaPrefix: env.schemaPrefix,
        password: usPassword,
      },
    )
    userA = { id: aCreated.id, email: aCreated.email, password: usPassword, token: aCreated.token }
    userB = { id: bCreated.id, email: bCreated.email, password: usPassword, token: bCreated.token }

    const roleRows = await env.db.sql.unsafe(
      `SELECT r.id FROM ${ks(env)}.roles r
        JOIN ${ks(env)}.user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [userB.id],
    )
    userBRoleId = roleRows[0]?.id
    if (!userBRoleId) throw new Error("userB role not found")

    for (let i = 0; i < 3; i++) {
      const t = await seedTicket(env, {
        orgId: world.org.id,
        subject: `Alpha ticket ${i + 1} — usb hardware`,
        team: "support-us",
      })
      ticketIds.alpha.push(t.id)
      await enqueueIndexerEvent(env, world.org.id, world.admin.id, "ticket", "create", t.id)
    }
    for (let i = 0; i < 2; i++) {
      const t = await seedTicket(env, {
        orgId: world.org.id,
        subject: `Beta ticket ${i + 1} — usb hardware`,
        team: "support-eu",
      })
      ticketIds.beta.push(t.id)
      await enqueueIndexerEvent(env, world.org.id, world.admin.id, "ticket", "create", t.id)
    }
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("filters tickets by read_scope + team dimension grant", async () => {
    // Wait for the durable indexer to ingest all 5 tickets — poll Meili
    // directly (the admin role doesn't have an explicit team dim grant, so
    // an API search would be filtered out by the team rule).
    const indexName = `${env.meiliIndexPrefix}liaison_search`
    const allIds = new Set([...ticketIds.alpha, ...ticketIds.beta])
    await pollUntil(
      async () => {
        const search = await meiliClient()
          .index(indexName)
          .search("usb", { limit: 50, filter: `entity_type = "ticket"` })
          .catch(() => null)
        if (!search) return false
        const seen = new Set(search.hits.map((h: any) => h.entity_id))
        return [...allIds].every((id) => seen.has(id))
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "indexer ingestion",
    )
    // Readiness is the server's own lazy probe (drift.ts isSearchReady, at most
    // every few seconds): on a server whose index was created empty at boot it
    // turns on a moment after the documents land, and a search before that
    // answers 503. Wait for the server to serve search before asserting what
    // it filters.
    await pollUntil(
      async () => (await searchTicketsAs(env, world.admin.token)).status === 200,
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "search readiness",
    )

    const a = await searchTicketsAs(env, userA.token)
    expect(a.status).toBe(200)
    expect(a.ids.sort()).toEqual([...ticketIds.alpha].sort())
    for (const id of ticketIds.beta) expect(a.ids).not.toContain(id)

    const b = await searchTicketsAs(env, userB.token)
    expect(b.status).toBe(200)
    expect(b.ids.sort()).toEqual([...ticketIds.beta].sort())
    for (const id of ticketIds.alpha) expect(b.ids).not.toContain(id)
  }, 60_000)

  it("re-indexes when a ticket's team dimension changes", async () => {
    // Move one beta ticket to alpha team. Emit the indexer event so the
    // durable consumer re-upserts the document with the new dimension.
    const moveId = ticketIds.beta[0]!
    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets SET team = 'support-us', updated_at = now() WHERE id = $1`,
      [moveId],
    )
    await enqueueIndexerEvent(env, world.org.id, world.admin.id, "ticket", "update", moveId)

    // userB now sees only 1 beta ticket; userA sees 4.
    await pollUntil(
      async () => {
        const b = await searchTicketsAs(env, userB.token)
        if (b.status !== 200) return false
        return !b.ids.includes(moveId) && b.ids.length === 1
      },
      MUTATION_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "team-move propagation to userB",
    )

    const a = await searchTicketsAs(env, userA.token)
    expect(a.status).toBe(200)
    expect(a.ids).toContain(moveId)
    expect(a.ids.length).toBe(4)
  }, 30_000)

  it("revoking the team dimension grant hides the gated tickets", async () => {
    // Drop userB's team grant. Re-login so the JWT carries the new
    // dimensionGrants (the old token's grants are baked in).
    await env.db.sql.unsafe(
      `DELETE FROM ${ks(env)}.role_dimension_grants WHERE role_id = $1 AND dimension_key = 'team'`,
      [userBRoleId],
    )
    const renewed = await login(env.serverUrl, userB.email, userB.password)
    userB.token = renewed.accessToken

    const b = await searchTicketsAs(env, userB.token)
    expect(b.status).toBe(200)
    // With no team grants, the permission filter narrows to docs missing the
    // `team` field — none of our seeded tickets, so userB sees zero hits.
    for (const id of [...ticketIds.alpha, ...ticketIds.beta]) {
      expect(b.ids).not.toContain(id)
    }
  }, 30_000)

  it("revoking the read scope short-circuits to an empty result set (no 500)", async () => {
    // Strip the tickets:tickets:read scope from userB's role and re-login.
    await env.db.sql.unsafe(
      `DELETE FROM ${ks(env)}.role_scope_grants WHERE role_id = $1 AND scope = 'tickets:tickets:read'`,
      [userBRoleId],
    )
    const renewed = await login(env.serverUrl, userB.email, userB.password)
    userB.token = renewed.accessToken

    const b = await searchTicketsAs(env, userB.token)
    expect(b.status).toBe(200)
    expect(b.ids).toEqual([])
  }, 30_000)

  it("a member with read scope but NO dimension grants still finds default-sensitivity tickets", async () => {
    // Regression: production tickets default to sensitivity='internal' with no
    // team, and a plain member (read scope, zero dimension grants) can open
    // them in the list view — search must find them too. Before the
    // lowest-band default in expandTicketSearchDimensionGrants, the Meili
    // filter degenerated to `(NOT sensitivity EXISTS)` and such members got
    // zero hits for every ticket.
    const cCreated = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Carol Nogrants",
        scopes: ["tickets:tickets:read"],
        schemaPrefix: env.schemaPrefix,
        password: usPassword,
      },
    )
    const gamma = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Gamma ticket — usb hardware",
      // no team, sensitivity defaults to 'internal' — the prod shape
    })
    await enqueueIndexerEvent(env, world.org.id, world.admin.id, "ticket", "create", gamma.id)

    await pollUntil(
      async () => {
        const c = await searchTicketsAs(env, cCreated.token)
        return c.status === 200 && c.ids.includes(gamma.id)
      },
      INDEX_POLL_BUDGET_MS,
      POLL_TICK_MS,
      "no-grant member finds internal ticket",
    )

    // Team-gated tickets stay hidden: no membership grant, no access.
    const c = await searchTicketsAs(env, cCreated.token)
    for (const id of [...ticketIds.alpha, ...ticketIds.beta]) {
      expect(c.ids).not.toContain(id)
    }
  }, 60_000)
})
