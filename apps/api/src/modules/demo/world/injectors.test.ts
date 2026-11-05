// SPDX-License-Identifier: FSL-1.1-ALv2
// The world injectors (C5) and the prospect site fixture: outside a demo org
// none runs and nothing is written; in a demo org each writes its fixed live
// event once (a second run adds nothing) through the product path, whose event
// reaches the outbox for that org only; the fixture site makes no network call.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { SCENARIO_TOURS } from "@liaison/shared"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { declaredEmits } from "~/modules/apps/app-registries"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { resetDemoShopifyOverlay, worldOrdersFor } from "~/modules/demo/shopify/overlay"
import { CHAT_WORLD_CHANNEL, chatQuestionInjector } from "~/modules/demo/world/chat-question"
import {
  COMMERCE_WORLD_CUSTOMER_EMAIL,
  COMMERCE_WORLD_ORDER_NAME,
  CommerceOrderTestAccess,
  restoreCommerceWorldOrder,
  worldOrder,
  worldOrderPayload,
} from "~/modules/demo/world/commerce-order"
import { runWorldBeatOnce } from "~/modules/demo/world/registry"
import { salesEmailInjector } from "~/modules/demo/world/sales-email"
import { SUPPORT_WORLD_SUBJECT, supportTicketInjector } from "~/modules/demo/world/support-ticket"
import { demoWebFetchFixture } from "~/modules/demo/world/web-fetch-fixture"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

let priorKernelEmits: Set<string> | undefined
let demoOrg: string
let plainOrg: string
let owner: string
let plainOwner: string

async function addUser(orgId: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${id}, ${orgId}, ${`inj-${id}@test.com`}, ${name})`
  return id
}

async function counts(orgId: string) {
  const [row] = await sql`SELECT
    (SELECT count(*)::int FROM kernel.messages WHERE org_id = ${orgId}) AS messages,
    (SELECT count(*)::int FROM kernel.threads WHERE org_id = ${orgId}) AS threads,
    (SELECT count(*)::int FROM kernel.demo_world_marks WHERE org_id = ${orgId}) AS marks,
    (SELECT count(*)::int FROM kernel.pending_events WHERE org_id = ${orgId}
       AND payload->>'entity' <> 'tour') AS events`
  return row
}

beforeAll(async () => {
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  demoOrg = (await createTestOrg()).id
  await markOrgAsDemo(demoOrg, visitorMarker(24))
  plainOrg = (await minimal.secondOrg()).orgId
  owner = await addUser(demoOrg, "Visitor")
  plainOwner = await addUser(plainOrg, "Someone")
  await addUser(demoOrg, "Tobias Braun")
})

afterAll(() => {
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
})

describe("outside a demo org", () => {
  it("no scenario's world beat runs and nothing is written (every injector)", async () => {
    const before = await counts(plainOrg)
    // The developer scenario has no world beat: its agent dispatches for real.
    const withWorld = SCENARIO_TOURS.filter((t) => t.beats.some((b) => b.kind === "world"))
    expect(withWorld.map((t) => t.id)).not.toContain("kernel.scenario-dev")
    expect(withWorld).toHaveLength(SCENARIO_TOURS.length - 1)
    for (const tour of withWorld) {
      const world = tour.beats.find((b) => b.kind === "world")
      if (!world) throw new Error(`${tour.id} has no world beat`)
      await sql`INSERT INTO kernel.tour_progress (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
        VALUES (${plainOrg}, ${plainOwner}, ${tour.id}, 'active', ${world.id}, 1, '{}'::jsonb, 'demo')
        ON CONFLICT (org_id, user_id, tour_id) DO UPDATE SET beat_id = ${world.id}, status = 'active'`
      expect(await runWorldBeatOnce(plainOrg, plainOwner, tour.id)).toBe("not_demo")
    }
    expect(await counts(plainOrg)).toEqual(before)
  })
})

describe("chat-question", () => {
  it("a teammate opens the channel with the visitor and asks, once", async () => {
    const ctx = {
      orgId: demoOrg,
      ownerUserId: owner,
      tourId: "kernel.scenario-chat",
      beatId: "question",
      run: 0,
      runStartedAt: new Date(Date.now() - 60_000),
    }
    await chatQuestionInjector.injectWorldEvent(ctx)
    await chatQuestionInjector.injectWorldEvent(ctx)
    const threads = await sql`SELECT id FROM kernel.threads
      WHERE org_id = ${demoOrg} AND title = ${CHAT_WORLD_CHANNEL}`
    expect(threads).toHaveLength(1)
    const threadId = threads[0]!.id as string
    const msgs = await sql`SELECT content FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(msgs).toHaveLength(1)
    expect(String(msgs[0]!.content)).toContain("battery passports")
    // The channel is what the beat records: the steps after it open it.
    expect(await chatQuestionInjector.entityOf?.(ctx)).toBe(threadId)
    const seats =
      await sql`SELECT user_id FROM kernel.thread_participants WHERE thread_id = ${threadId}`
    expect(seats.map((s) => s.user_id)).toContain(owner)
    const events = await sql`SELECT org_id FROM kernel.pending_events
      WHERE payload->>'app' = 'kernel' AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create' AND payload->'data'->>'threadId' = ${threadId}`
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) expect(e.org_id).toBe(demoOrg)

    // The scenario started again: a new run asks again, in the same channel, once.
    await Bun.sleep(5)
    const next = { ...ctx, run: 1, runStartedAt: new Date() }
    await chatQuestionInjector.injectWorldEvent(next)
    await chatQuestionInjector.injectWorldEvent(next)
    const again = await sql`SELECT id FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(again).toHaveLength(2)
  })
})

describe("sales-email", () => {
  it("one inbound message in the shared mailbox and its mail:message:create, once", async () => {
    const accountId = crypto.randomUUID()
    await sql`INSERT INTO app_mail.accounts (
        id, org_id, connected_account_id, owner_type, owner_id, provider,
        email_address, display_name, sync_status, created_at, updated_at)
      VALUES (${accountId}, ${demoOrg}, ${crypto.randomUUID()}, 'org', NULL, 'imap',
        'support@resonantaudiolabs.example', 'Support', 'idle', now(), now())`
    const ctx = {
      orgId: demoOrg,
      ownerUserId: owner,
      tourId: "kernel.scenario-sales",
      beatId: "live-email",
      run: 0,
      runStartedAt: new Date(),
    }
    await salesEmailInjector.injectWorldEvent(ctx)
    await salesEmailInjector.injectWorldEvent(ctx)
    const msgs = await sql`SELECT from_address FROM app_mail.messages
      WHERE org_id = ${demoOrg} AND account_id = ${accountId}`
    expect(msgs).toHaveLength(1)
    const events = await sql`SELECT org_id, payload FROM kernel.pending_events
      WHERE payload->>'app' = 'mail' AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create' AND org_id = ${demoOrg}`
    expect(events).toHaveLength(1)
    const data = (events[0]!.payload as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      direction: "inbound",
      senderAuth: "pass",
      from: { email: "ines.duarte@northwind-acoustics.example" },
    })
    // The beat records the prospect's conversation: the reply to approve is on it.
    expect(await salesEmailInjector.entityOf?.(ctx)).toBe(data.conversationId as string)

    // A new run of the scenario: a new email, its own conversation, its own event.
    const next = { ...ctx, run: 1, runStartedAt: new Date() }
    await salesEmailInjector.injectWorldEvent(next)
    await salesEmailInjector.injectWorldEvent(next)
    expect(
      await sql`SELECT id FROM app_mail.messages WHERE org_id = ${demoOrg} AND account_id = ${accountId}`,
    ).toHaveLength(2)
    const nextConversation = await salesEmailInjector.entityOf?.(next)
    expect(nextConversation).not.toBe(data.conversationId)
    const nextEvents = await sql`SELECT payload FROM kernel.pending_events
      WHERE payload->>'app' = 'mail' AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create' AND org_id = ${demoOrg}
        AND payload->'data'->>'conversationId' = ${nextConversation ?? ""}`
    expect(nextEvents).toHaveLength(1)
    // The first run's conversation is still what that run's id names.
    expect(await salesEmailInjector.entityOf?.(ctx)).toBe(data.conversationId as string)
  })
})

describe("support-ticket", () => {
  it("one ticket per run of the scenario: a restart brings a new ticket, never the old one", async () => {
    await sql`INSERT INTO app_tickets.inboxes (
        id, org_id, kind, connected_account_id, name, email_address,
        default_team, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${demoOrg}, 'api', NULL, 'Support',
        NULL, NULL, NULL, false, now(), now())`
    const ctx = {
      orgId: demoOrg,
      ownerUserId: owner,
      tourId: "kernel.scenario-support",
      beatId: "live-ticket",
      run: 0,
      runStartedAt: new Date(),
    }
    await supportTicketInjector.injectWorldEvent(ctx)
    await supportTicketInjector.injectWorldEvent(ctx)
    const first = await supportTicketInjector.entityOf?.(ctx)
    expect(first).toBeTruthy()
    const next = { ...ctx, run: 1, runStartedAt: new Date() }
    expect(await supportTicketInjector.entityOf?.(next)).toBeNull()
    await supportTicketInjector.injectWorldEvent(next)
    await supportTicketInjector.injectWorldEvent(next)
    const second = await supportTicketInjector.entityOf?.(next)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    const tickets = await sql`SELECT id FROM app_tickets.tickets
      WHERE org_id = ${demoOrg} AND subject = ${SUPPORT_WORLD_SUBJECT}`
    expect(tickets).toHaveLength(2)
  })
})

describe("commerce-order per run", () => {
  // Walk 2026-10-26: the order took the fixtures' newest customer, a dealer in
  // Japan, so its parcel needed customs paperwork and the agent would not book
  // it "as it is". It is one person's order, shipped inside the EU, every day.
  it("is one end customer's order, shipped inside the EU, the same on any day", () => {
    const today = worldOrder(new Date("2026-10-26T09:00:00Z"))
    const later = worldOrder(new Date("2026-11-09T09:00:00Z"))
    expect(today.email).toBe(COMMERCE_WORLD_CUSTOMER_EMAIL)
    expect(later.email).toBe(COMMERCE_WORLD_CUSTOMER_EMAIL)
    expect(later.customerId).toBe(today.customerId)
    expect(today.shippingAddress.countryCode).toBe("DE")
    expect(today.shippingAddress.company).toBeNull()
    expect(today.shippingAddress.phone).toBeTruthy()
    const payload = worldOrderPayload(today) as {
      customer: { email: string } | null
      shipping_address: { country_code: string }
    }
    expect(payload.customer?.email).toBe(COMMERCE_WORLD_CUSTOMER_EMAIL)
    expect(payload.shipping_address.country_code).toBe("DE")
  })

  it("each run's order has its own id, number and name; the first run keeps the original ones", () => {
    const first = worldOrder(new Date(), 0)
    const second = worldOrder(new Date(), 1)
    expect(first.name).toBe(COMMERCE_WORLD_ORDER_NAME)
    expect(second.id).not.toBe(first.id)
    expect(second.numericId).not.toBe(first.numericId)
    expect(second.name).not.toBe(first.name)
    expect(worldOrderPayload(second).order_number).toBe(Number(second.name.slice(1)))
    expect(worldOrderPayload(second).id).toBe(second.numericId)
  })

  it("restores the order of the run its mark belongs to", async () => {
    resetDemoShopifyOverlay(demoOrg)
    CommerceOrderTestAccess.resetRestoreCache()
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
    await sql`INSERT INTO kernel.demo_world_marks (org_id, tour_id, beat_id, state, claimed_at, generation)
      VALUES (${demoOrg}, 'kernel.scenario-commerce', 'live-order', 'succeeded', now(), 2)`
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg).map((o) => o.name)).toEqual([worldOrder(new Date(), 2).name])
    resetDemoShopifyOverlay(demoOrg)
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
  })
})

describe("commerce-order after a restart", () => {
  it("restores the live order into the store from its once-mark, and only when it ran", async () => {
    resetDemoShopifyOverlay(demoOrg)
    CommerceOrderTestAccess.resetRestoreCache()
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
    // Never ran: nothing appears.
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg)).toHaveLength(0)
    // It ran before the restart (mark succeeded, overlay empty): the order is back.
    const at = new Date("2026-10-23T09:30:00.000Z")
    await sql`INSERT INTO kernel.demo_world_marks (org_id, tour_id, beat_id, state, claimed_at)
      VALUES (${demoOrg}, 'kernel.scenario-commerce', 'live-order', 'succeeded', ${at.toISOString()}::timestamptz)`
    CommerceOrderTestAccess.resetRestoreCache()
    await restoreCommerceWorldOrder(demoOrg)
    const restored = worldOrdersFor(demoOrg)
    expect(restored.map((o) => o.name)).toEqual([COMMERCE_WORLD_ORDER_NAME])
    expect(restored[0]?.createdAt).toBe(at.toISOString())
    // Idempotent.
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg)).toHaveLength(1)
    resetDemoShopifyOverlay(demoOrg)
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
  })
})

// Regression: the worker placed the order in ITS overlay; an api replica had
// read the store a few seconds before the claim, cached that miss for a
// minute, and answered the orders list's refetch (fired by the order's own
// event, before the mark settled) without #1097. The tour waited forever.
describe("commerce-order on a process that did not inject it", () => {
  it("shows the order as soon as the beat's claim commits, whatever this process read before", async () => {
    resetDemoShopifyOverlay(demoOrg)
    CommerceOrderTestAccess.resetRestoreCache()
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
    // A read before the beat: no order, and no cached verdict either.
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg)).toHaveLength(0)
    // Another process claims the beat and is placing the order (not settled yet).
    const at = new Date("2026-10-30T13:17:54.000Z")
    await sql`INSERT INTO kernel.demo_world_marks (org_id, tour_id, beat_id, state, claimed_at)
      VALUES (${demoOrg}, 'kernel.scenario-commerce', 'live-order', 'claimed', ${at.toISOString()}::timestamptz)`
    // The very next read here (the list's refetch) has it.
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg).map((o) => o.name)).toEqual([COMMERCE_WORLD_ORDER_NAME])
    resetDemoShopifyOverlay(demoOrg)

    // A released claim (the injection failed: claimed_at at the epoch) places nothing.
    await sql`UPDATE kernel.demo_world_marks SET claimed_at = to_timestamp(0) WHERE org_id = ${demoOrg}`
    await restoreCommerceWorldOrder(demoOrg)
    expect(worldOrdersFor(demoOrg)).toHaveLength(0)
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
  })
})

describe("demoWebFetchFixture", () => {
  it("answers the prospect's site for a demo org only, with no network call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
    try {
      const page = await demoWebFetchFixture(demoOrg, "https://northwind-acoustics.example/")
      expect(page?.status).toBe(200)
      expect(page?.body).toContain("Northwind Acoustics")
      expect(
        (await demoWebFetchFixture(demoOrg, "https://northwind-acoustics.example/nope"))?.status,
      ).toBe(404)
      expect(await demoWebFetchFixture(plainOrg, "https://northwind-acoustics.example/")).toBeNull()
      expect(await demoWebFetchFixture(demoOrg, "https://example.org/")).toBeNull()
      expect(await demoWebFetchFixture(demoOrg, "not a url")).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
