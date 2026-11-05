// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A2 — `evaluateSubscription` rule-matching matrix.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { evaluateSubscription } from "~/modules/attention/subscriptions"

const rlsDb = db as unknown as RlsClient

const ORG = "00000000-0000-0000-0000-0000000000b1"
const U = "00000000-0000-0000-0000-0000000000b2"
const U_NO_RULES = "00000000-0000-0000-0000-0000000000b3"

async function seedRule(args: {
  userId: string
  source: string
  kinds: string[]
  filters: Record<string, string[]>
  enabled: boolean
}): Promise<void> {
  await sql`
    INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
    VALUES (${args.userId}, ${args.source}, ${args.kinds}, ${JSON.stringify(args.filters)}::jsonb, ${args.enabled})
  `
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'AttnSubsOrg', 'attn-subs-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${U}, ${ORG}, 'attn-u@t.com', 'AU') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${U_NO_RULES}, ${ORG}, 'attn-u2@t.com', 'AU2') ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id IN (${U}, ${U_NO_RULES})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id IN (${U}, ${U_NO_RULES})`
})

describe("attention.evaluateSubscription", () => {
  it("default-on: user with no rules for the source passes all items", async () => {
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U_NO_RULES,
        source: "shopify",
        kind: "shopify:order.created",
        axes: { market: "EU", currency: "EUR" },
      }),
    ).toBe(true)
  })

  it("matches when source + kind + every filter axis hold", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["shopify:order.created"],
      filters: { market: ["EU"] },
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "shopify:order.created",
        axes: { market: "EU", currency: "EUR" },
      }),
    ).toBe(true)
  })

  it("drops when a filter axis mismatches", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["shopify:order.created"],
      filters: { market: ["US"] },
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "shopify:order.created",
        axes: { market: "EU" },
      }),
    ).toBe(false)
  })

  it("drops when kind is not in declared list (and the user has any rule for source)", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["shopify:order.created"],
      filters: {},
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "shopify:order.unfulfilled",
        axes: {},
      }),
    ).toBe(false)
  })

  it("'*' kind wildcard accepts any kind for that source", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["*"],
      filters: {},
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "shopify:order.unfulfilled",
        axes: {},
      }),
    ).toBe(true)
  })

  it("'*' source matches every source (catch-all rule)", async () => {
    await seedRule({
      userId: U,
      source: "*",
      kinds: ["mention"],
      filters: {},
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "tickets",
        kind: "mention",
        axes: {},
      }),
    ).toBe(true)
  })

  it("disabled rule does not match (and inhibits default-on for the source)", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["shopify:order.created"],
      filters: {},
      enabled: false,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "shopify:order.created",
        axes: {},
      }),
    ).toBe(false)
  })

  // NOTE: The migration enforces UNIQUE(user_id, source) — the Settings UI
  // exposes one master rule per source, and disjoint kinds/filters are
  // expressed by widening the single row's `kinds` array + multi-value
  // `filters` axes. The OR-within-axis case is covered by the next test.

  it("filter axis with multiple allowed values acts as OR within the axis", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["*"],
      filters: { market: ["EU", "US"] },
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "x",
        axes: { market: "US" },
      }),
    ).toBe(true)
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "x",
        axes: { market: "JP" },
      }),
    ).toBe(false)
  })

  it("missing axis value in event — rule with that filter does not match", async () => {
    await seedRule({
      userId: U,
      source: "shopify",
      kinds: ["*"],
      filters: { market: ["EU"] },
      enabled: true,
    })
    expect(
      await evaluateSubscription(rlsDb, {
        userId: U,
        source: "shopify",
        kind: "x",
        axes: {},
      }),
    ).toBe(false)
  })
})
