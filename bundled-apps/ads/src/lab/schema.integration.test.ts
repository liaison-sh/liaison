// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P5 T1 — boots the app schema for the three lab tables (experiments,
// manual_spend, dealer_profiles) against the in-memory ctx.db mock and
// round-trips an insert/find on each, mirroring how the pause_ledger tests boot
// (pause.test.ts).

import { describe, expect, it } from "bun:test"
import { createMockDb } from "../test-db"

describe("lab tables — schema boot + insert/find round-trip", () => {
  it("experiments: insert then find round-trips all declared fields", async () => {
    const db = createMockDb()
    const inserted = await db.insert("experiments", {
      title: "Search brand vs non-brand split",
      hypothesis: "Splitting brand out lowers blended CPA",
      platforms: JSON.stringify(["google"]),
      metric_tier: "purchase",
      primary_metric: "cpa",
      variants: JSON.stringify(["split", "combined"]),
      start_date: "2026-07-01",
      decision_date: "2026-08-01",
      minimum_sample: 100,
      status: "running",
      created_by: "agent",
    })
    const row = (await db.findOne("experiments", inserted.id)) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.title).toBe("Search brand vs non-brand split")
    expect(row.metric_tier).toBe("purchase")
    expect(row.status).toBe("running")
    expect(row.created_at).toBeDefined()
  })

  it("manual_spend: insert then find round-trips all declared fields", async () => {
    const db = createMockDb()
    const inserted = await db.insert("manual_spend", {
      channel: "specialized-site-x",
      site: "example-dealer.com",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      amount: 500,
      currency: "EUR",
      notes: "seeded from Morgan's buy list",
      created_by: "agent",
    })
    const row = (await db.findOne("manual_spend", inserted.id)) as Record<string, unknown>
    expect(row.channel).toBe("specialized-site-x")
    expect(row.amount).toBe(500)
    expect(row.currency).toBe("EUR")
  })

  it("dealer_profiles: insert then find round-trips all declared fields", async () => {
    const db = createMockDb()
    const inserted = await db.insert("dealer_profiles", {
      dealer_name: "Acme Music",
      sku_match_hints: JSON.stringify(["TESSERA2-*"]),
      coverage_area: "EU-West",
      dealer_type: "boutique",
      notes: "quarterly reorders",
      reorder_cadence: "quarterly",
      created_by: "agent",
    })
    const row = (await db.findOne("dealer_profiles", inserted.id)) as Record<string, unknown>
    expect(row.dealer_name).toBe("Acme Music")
    expect(row.dealer_type).toBe("boutique")
  })
})
