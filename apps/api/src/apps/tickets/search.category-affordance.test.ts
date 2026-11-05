// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression for the cross-app daily-exception-triage affordance
// (ops-daily-exception-triage-cross-app-works): tickets:search must let a caller
// scope to a category by NAME ("Shipping") and must surface each ticket's
// categoryName, so an agent can isolate "shipping tickets at SLA risk" without a
// category-UUID lookup. Without this fix the only category filter was categoryId
// (a UUID the agent never has) and the projection exposed only the opaque
// categoryId — so a slaApproaching sweep could not tell which results were
// shipping-related, the exact rubric-relevant grounding for the triage list.
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let inboxId: string
let shippingCatId: string
let billingCatId: string
let actor: ActorContext

async function seedTicket(opts: {
  subject: string
  categoryId: string | null
  /** slaApproaching iff deadlineHours small AND firstResponded === false. */
  deadlineHours: number
  firstResponded: boolean
}): Promise<string> {
  const id = crypto.randomUUID()
  const handle = `cataff-${Math.floor(Math.random() * 1e9)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  await withSystemDb("cat-affordance-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
        sla_elapsed_seconds, message_count, source_inbox_id, category_id,
        first_response_at, last_inbound_at, last_outbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${handle}, ${opts.subject}, 'open', 'high', 'manual', 'internal',
        ${replyToken}, 86400, now() + (interval '1 hour' * ${opts.deadlineHours}),
        now() - interval '8 hours', 0, 1, ${inboxId}, ${opts.categoryId},
        ${opts.firstResponded ? drizzleSql`now() - interval '6 hours'` : drizzleSql`NULL`},
        now() - interval '8 hours',
        ${opts.firstResponded ? drizzleSql`now() - interval '6 hours'` : drizzleSql`NULL`},
        now() - interval '8 hours', now() - interval '8 hours', now()
      )
    `)
  })
  return id
}

beforeAll(async () => {
  const slug = `cat-affordance-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("cat-affordance-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Cat Affordance', ${slug}) RETURNING id
    `)) as { rows?: { id: string }[] } & { id: string }[]
    orgId = (orgRows.rows ?? orgRows)[0].id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u1-${slug}@test.com`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as { rows?: { id: string }[] } & { id: string }[]
    userId = (userRows.rows ?? userRows)[0].id
    const inboxRows = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, gen_random_uuid(), 'In', ${`in-${slug}@x.test`}, 'internal', true, now(), now())
      RETURNING id
    `)) as { rows?: { id: string }[] } & { id: string }[]
    inboxId = (inboxRows.rows ?? inboxRows)[0].id
    const shipCat = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.categories (id, org_id, parent_id, name, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, NULL, 'Shipping', 60, now(), now()) RETURNING id
    `)) as { rows?: { id: string }[] } & { id: string }[]
    shippingCatId = (shipCat.rows ?? shipCat)[0].id
    const billCat = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.categories (id, org_id, parent_id, name, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, NULL, 'Billing', 61, now(), now()) RETURNING id
    `)) as { rows?: { id: string }[] } & { id: string }[]
    billingCatId = (billCat.rows ?? billCat)[0].id
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

describe("tickets.search category-name affordance (daily-exception-triage)", () => {
  it("filters by category NAME (case-insensitive) and surfaces categoryName", async () => {
    const shipApproaching = await seedTicket({
      subject: "Stuck in Japan customs #EMB-2026-00731",
      categoryId: shippingCatId,
      deadlineHours: 1.5,
      firstResponded: false,
    })
    const billApproaching = await seedTicket({
      subject: "Double charged INV-2026-0444",
      categoryId: billingCatId,
      deadlineHours: 2,
      firstResponded: false,
    })

    // Filter by NAME with mixed case — resolves to the Shipping category UUID.
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { category: "shipping", limit: 50 },
    })
    const items = (out.data as { items: Array<{ id: string; categoryName: string | null }> }).items
    const ids = items.map((r) => r.id)
    expect(ids).toContain(shipApproaching)
    expect(ids).not.toContain(billApproaching)
    // The projection now carries the human-readable category name.
    const row = items.find((r) => r.id === shipApproaching)
    expect(row?.categoryName).toBe("Shipping")
  })

  it("category=Shipping + slaApproaching isolates the at-risk shipping tickets only", async () => {
    // shipping + approaching (the target), shipping + NOT approaching (answered),
    // billing + approaching (wrong category). Only the first must come back.
    const shipApproaching = await seedTicket({
      subject: "Delivery failed #EMB-2026-00748",
      categoryId: shippingCatId,
      deadlineHours: 2,
      firstResponded: false,
    })
    const shipAnswered = await seedTicket({
      subject: "Thanks order arrived #EMB-2026-00701",
      categoryId: shippingCatId,
      deadlineHours: 20,
      firstResponded: true,
    })
    const billApproaching = await seedTicket({
      subject: "Refund duplicate INV-2026-0455",
      categoryId: billingCatId,
      deadlineHours: 2,
      firstResponded: false,
    })

    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { category: "Shipping", slaApproaching: true, limit: 50 },
    })
    const ids = (out.data as { items: Array<{ id: string }> }).items.map((r) => r.id)
    expect(ids).toContain(shipApproaching)
    expect(ids).not.toContain(shipAnswered)
    expect(ids).not.toContain(billApproaching)
  })

  it("an unknown category name returns zero matches (never silently drops the filter)", async () => {
    // Seed a shipping ticket so a dropped filter would surface it.
    await seedTicket({
      subject: "Some shipping ticket",
      categoryId: shippingCatId,
      deadlineHours: 2,
      firstResponded: false,
    })
    const out = await executeTool({
      toolName: "tickets:search",
      orgId,
      actor,
      params: { category: "NoSuchCategory", limit: 50 },
    })
    const items = (out.data as { items: unknown[] }).items
    expect(items.length).toBe(0)
  })
})
