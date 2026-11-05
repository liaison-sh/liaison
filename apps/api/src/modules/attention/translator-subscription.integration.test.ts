// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 cluster-5 fix (test-fidelity): the production translator must apply
// `kernel.attention_subscriptions` narrowing UNCONDITIONALLY — not only when a
// test injects `deps.buildSubscriptionFilter`. This test seeds real rules and
// drives `processTranslationEvent` with the DEFAULT subscription filter (no
// injected `buildSubscriptionFilter`), asserting a non-matching recipient is
// dropped and a matching one is kept — i.e. the real DB-backed narrowing runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { manifestAttentionRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { processTranslationEvent } from "./translator"

const ORG = "00000000-0000-0000-0000-0000000000c1"
const U_MATCH = "00000000-0000-0000-0000-0000000000c2" // rule allows market:EU
const U_DROP = "00000000-0000-0000-0000-0000000000c3" // rule allows market:US only
const U_DEFAULT = "00000000-0000-0000-0000-0000000000c4" // no rule → default-on

const KIND = "shopify:order.created"

async function seedRule(args: {
  userId: string
  filters: Record<string, string[]>
}): Promise<void> {
  await sql`
    INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
    VALUES (${args.userId}, 'shopify', ${[KIND]}, ${JSON.stringify(args.filters)}::jsonb, true)
  `
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'TxOrg', 'tx-subs-org') ON CONFLICT DO NOTHING`
  for (const [id, email] of [
    [U_MATCH, "tx-match@t.com"],
    [U_DROP, "tx-drop@t.com"],
    [U_DEFAULT, "tx-default@t.com"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${email}, 'T') ON CONFLICT DO NOTHING`
  }
})

beforeEach(() => {
  resetAppRegistries()
  // Register a manifest attention translation that fans out to the recipient
  // ids carried in the event payload (so the test controls the candidate set).
  manifestAttentionRegistry.set(
    [ORG, "shopify"],
    [
      {
        event: "order:created",
        kind: KIND,
        urgency: 50,
        summary: "New order",
        // `participants` reads an array of ids from the payload (the candidate
        // recipient set this test controls); `field` reads only a single string.
        recipients: { kind: "participants", path: "data.recipientIds" },
      } as never,
    ],
  )
})

afterEach(async () => {
  resetAppRegistries()
  await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id IN (${U_MATCH}, ${U_DROP}, ${U_DEFAULT})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id IN (${U_MATCH}, ${U_DROP}, ${U_DEFAULT})`
})

function orderCreatedEvent(): AppEvent {
  return {
    app: "shopify",
    entity: "order",
    action: "created",
    orgId: ORG,
    actorId: "system:shopify",
    actorType: "system",
    entityId: "gid://shopify/Order/1",
    timestamp: "2026-05-28T12:00:00.000Z",
    // Axes derived from metadata — market:EU here.
    metadata: { market: "EU", currency: "EUR" },
    data: { recipientIds: [U_MATCH, U_DROP, U_DEFAULT] },
  }
}

describe("translator subscription narrowing (production default filter)", () => {
  it("drops recipients whose real DB rule does not match the event axes; keeps matching + default-on", async () => {
    await seedRule({ userId: U_MATCH, filters: { market: ["EU"] } })
    await seedRule({ userId: U_DROP, filters: { market: ["US"] } })
    // U_DEFAULT has no rule → default-on.

    const inserted: Array<{ userId: string }> = []
    // Deliberately DO NOT inject buildSubscriptionFilter — the translator must
    // use its privileged-DB default. Only the persistence + prefs are doubled.
    await processTranslationEvent(orderCreatedEvent(), {
      loadPreferences: async () => ({
        digestCadence: "daily",
        workHoursStart: "00:00",
        workHoursEnd: "23:59",
        workDays: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
      }),
      insertAttentionRow: async (row) => {
        inserted.push({ userId: row.userId })
      },
    })

    const ids = inserted.map((r) => r.userId).sort()
    // U_MATCH (market:EU rule, event market:EU) kept; U_DEFAULT (no rule) kept;
    // U_DROP (market:US rule, event market:EU) dropped.
    expect(ids).toEqual([U_DEFAULT, U_MATCH].sort())
    expect(ids).not.toContain(U_DROP)
  })

  it("with a disabled-source rule, that recipient is dropped (no default-on fallback)", async () => {
    // U_MATCH gets a rule that does NOT match the kind → dropped; U_DEFAULT kept.
    await sql`
      INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
      VALUES (${U_MATCH}, 'shopify', ${["shopify:order.unfulfilled"]}, '{}'::jsonb, true)
    `
    const inserted: Array<{ userId: string }> = []
    await processTranslationEvent(orderCreatedEvent(), {
      loadPreferences: async () => ({
        digestCadence: "daily",
        workHoursStart: "00:00",
        workHoursEnd: "23:59",
        workDays: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
      }),
      insertAttentionRow: async (row) => {
        inserted.push({ userId: row.userId })
      },
    })
    const ids = inserted.map((r) => r.userId)
    expect(ids).toContain(U_DEFAULT)
    expect(ids).not.toContain(U_MATCH)
  })
})
