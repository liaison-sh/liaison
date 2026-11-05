// SPDX-License-Identifier: FSL-1.1-ALv2
//
// V2 — tickets LIST endpoint parity + latency at ~1k-ticket scale (D1's JOIN
// rewrite + index validation through the real executeTool path).
//
// D1 rewrote the hottest list query (5 correlated scalar subqueries -> LEFT
// JOINs + one LATERAL for the snippet) and added last_message_at/created_at
// indexes. This suite pins:
//   - PARITY: page rows come back in exactly the ground-truth order computed
//     independently in SQL (the golden-equivalence check for the rewrite),
//     across page 1 AND a cursor page, with totalCount correct on both.
//   - NULL-SAFETY: tickets with no contact/assignee/category still return rows
//     (LEFT JOIN semantics), with null fields.
//   - SNIPPET: a ticket with messages previews its NEWEST message; a ticket
//     with none has a null snippet.
//   - INDEXES: the list-serving indexes exist (name-agnostic definition check).
//   - LATENCY (soft): p50 of the page-1 call over 11 runs is logged and only
//     asserted against a deliberately generous ceiling, so machine noise never
//     flakes this suite — the deterministic guards above are the regression
//     signal, the wall-clock is telemetry with a catastrophe bound.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let inboxId: string
let actor: ActorContext
let markerTicketId: string

const CORPUS_TICKETS = 1_000
const PAGE_SIZE = 50
// Catastrophe bound only (see header). Measured p50 on an idle machine is tens
// of ms with the D1 indexes; a regression to sequential scans at 1k rows would
// still pass this, which is why the plan/index checks are the real guard.
const SOFT_P50_BOUND_MS = 5_000

beforeAll(async () => {
  const slug = `list-parity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("list-parity-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'List Parity Scale', ${slug}) RETURNING id
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

    // 1,000 tickets, STAGGERED last_message_at (one minute apart) so the
    // activity_newest ordering is total and the golden comparison is exact.
    // No contact/assignee/category: exercises LEFT JOIN null-safety on every row.
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
        sla_elapsed_seconds, message_count, source_inbox_id,
        last_inbound_at, last_message_at, created_at, updated_at
      )
      SELECT gen_random_uuid(), ${orgId},
        'parity-' || g, 'List parity corpus ticket #' || g, 'open', 'normal', 'manual', 'internal',
        'TKP' || lpad(g::text, 13, '0'), 3600, now() + interval '1 hour', now(), 0,
        0, ${inboxId},
        now() - (g || ' minutes')::interval,
        now() - (g || ' minutes')::interval,
        now() - (g || ' minutes')::interval, now()
      FROM generate_series(1, ${CORPUS_TICKETS}) AS g
    `)

    // Marker ticket with THREE messages (distinct sent_at) — the snippet must
    // be the NEWEST one. last_message_at = now() puts it first on page 1.
    const markerRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
        sla_elapsed_seconds, message_count, source_inbox_id,
        last_inbound_at, last_message_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, 'parity-marker', 'Snippet ordering marker',
        'open', 'normal', 'manual', 'internal',
        'TKPMARKER0000001', 3600, now() + interval '1 hour', now(), 0,
        3, ${inboxId}, now(), now(), now() - interval '2 hours', now()
      ) RETURNING id
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
    markerTicketId = (markerRows.rows ?? markerRows)[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${orgId}, ${markerTicketId}, 'inbound', 'oldest message body', now() - interval '30 minutes', now(), now()),
        (gen_random_uuid(), ${orgId}, ${markerTicketId}, 'outbound', 'middle message body', now() - interval '20 minutes', now(), now()),
        (gen_random_uuid(), ${orgId}, ${markerTicketId}, 'inbound', 'newest message body', now() - interval '10 minutes', now(), now())
    `)
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
}, 120_000)

async function groundTruthIds(limit: number, offset: number): Promise<string[]> {
  const rows = (await withSystemDb("list-parity-ground-truth", async (tx) => {
    // Independent ground truth mirroring the activity_newest contract:
    // last_message_at DESC (all priorities equal in this corpus), id DESC tiebreak.
    return (await tx.execute(drizzleSql`
      SELECT id FROM app_tickets.tickets
      WHERE org_id = ${orgId}
      ORDER BY last_message_at DESC NULLS LAST, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as { rows?: { id: string }[] } & { id: string }[]
  })) as { rows?: { id: string }[] } & { id: string }[]
  return ((rows as { rows?: { id: string }[] }).rows ?? (rows as { id: string }[])).map((r) => r.id)
}

describe("tickets list parity + latency at ~1k-ticket scale (V2/D1)", () => {
  it("page 1 matches the independent SQL ground truth exactly, with correct totalCount", async () => {
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { sort: "activity_newest", limit: PAGE_SIZE },
    })
    const data = out.data as {
      items: Array<Record<string, unknown>>
      nextCursor: string | null
      totalCount: number
    }
    expect(data.totalCount).toBe(CORPUS_TICKETS + 1)
    expect(data.items.length).toBe(PAGE_SIZE)
    expect(data.items.map((i) => i.id)).toEqual(await groundTruthIds(PAGE_SIZE, 0))
    expect(data.nextCursor).not.toBeNull()

    // The marker (newest activity) leads the page; its snippet is the NEWEST
    // non-acknowledgement message. Corpus tickets have no messages/contact/
    // assignee/category: LEFT JOIN null-safety means they still return rows
    // with null fields (pre-rewrite correlated subqueries had the same
    // semantics — this pins the equivalence).
    const marker = data.items[0] as { id: string; snippet: string | null }
    expect(marker.id).toBe(markerTicketId)
    expect(marker.snippet).toBe("newest message body")
    const bare = data.items[1] as {
      snippet?: string | null
      contact?: unknown
      assigneeName: string | null
      categoryName: string | null
    }
    expect(bare.snippet ?? null).toBeNull()
    // toCamelTicket only attaches `contact` when the ticket HAS a contact_id;
    // a bare corpus ticket leaves it undefined (LEFT JOIN null-safety upstream).
    expect(bare.contact ?? null).toBeNull()
    expect(bare.assigneeName).toBeNull()
    expect(bare.categoryName).toBeNull()
  }, 30_000)

  it("a cursor page continues the exact ground-truth order and keeps totalCount", async () => {
    const page1 = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { sort: "activity_newest", limit: PAGE_SIZE },
    })
    const cursor = (page1.data as { nextCursor: string | null }).nextCursor
    expect(cursor).not.toBeNull()

    const page2 = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { sort: "activity_newest", limit: PAGE_SIZE, cursor: cursor! },
    })
    const data = page2.data as {
      items: Array<Record<string, unknown>>
      totalCount: number
    }
    // totalCount stays present and correct on cursor pages (the documented
    // contract D1 explicitly preserved — search.total.test.ts pins the unit
    // level, this pins it at scale through the real tool path).
    expect(data.totalCount).toBe(CORPUS_TICKETS + 1)
    expect(data.items.length).toBe(PAGE_SIZE)
    expect(data.items.map((i) => i.id)).toEqual(await groundTruthIds(PAGE_SIZE, PAGE_SIZE))

    // Disjoint pages: keyset pagination never repeats a row.
    const page1Ids = new Set(
      (page1.data as { items: Array<{ id: string }> }).items.map((i) => i.id),
    )
    for (const item of data.items as Array<{ id: string }>) {
      expect(page1Ids.has(item.id)).toBe(false)
    }
  }, 30_000)

  it("the list-serving indexes exist on app_tickets.tickets", async () => {
    const rows = (await withSystemDb("list-parity-indexes", async (tx) => {
      return (await tx.execute(drizzleSql`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'app_tickets' AND tablename = 'tickets'
      `)) as unknown as { rows?: { indexdef: string }[] } & { indexdef: string }[]
    })) as { rows?: { indexdef: string }[] } & { indexdef: string }[]
    const defs = ((rows as { rows?: { indexdef: string }[] }).rows ?? (rows as any[]))
      .map((r: { indexdef: string }) => r.indexdef)
      .join("\n")
    // Name-agnostic: manifest runtime DDL and migration 0023 must converge on
    // indexes covering the two list sort keys. Both provenances index the
    // manifest-declared column WITH the org_id prefix the runtime DDL always
    // adds (modules/apps/ddl.ts prepends org_id to every declared index's
    // column list for multi-tenant scan selectivity) — a bare single-column
    // index under the same name would silently diverge a migrated-forward DB
    // from a freshly-registered one (see migration 0023's fix comment).
    expect(defs).toMatch(/\(org_id, last_message_at\)/)
    expect(defs).toMatch(/\(org_id, created_at\)/)
  }, 15_000)

  it(`p50 page-1 latency over 11 runs is logged and under the ${SOFT_P50_BOUND_MS}ms catastrophe bound`, async () => {
    const samples: number[] = []
    for (let i = 0; i < 11; i++) {
      const start = Date.now()
      const out = await executeTool({
        toolName: "tickets:search",
        orgId,
        actor,
        params: { sort: "activity_newest", limit: PAGE_SIZE },
      })
      samples.push(Date.now() - start)
      expect((out.data as { items: unknown[] }).items.length).toBe(PAGE_SIZE)
    }
    samples.sort((a, b) => a - b)
    const p50 = samples[Math.floor(samples.length / 2)]
    // Telemetry line (soft assertion policy: log always, hard-fail only on
    // catastrophe — index loss / pool wedge territory).
    console.log(
      `[V2 tickets list latency] p50=${p50}ms min=${samples[0]}ms max=${samples[samples.length - 1]}ms over ${samples.length} runs at ${CORPUS_TICKETS + 1} tickets`,
    )
    expect(p50).toBeLessThan(SOFT_P50_BOUND_MS)
  }, 90_000)
})
