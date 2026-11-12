// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T3 — summarizeManualSpendAdd / summarizeDealerProfileUpsert produce a
// SummaryCard echoing the fields the approver needs to see.

import { describe, expect, it } from "bun:test"
import { summarizeDealerProfileUpsert, summarizeManualSpendAdd } from "../summarizers"

describe("summarizeManualSpendAdd", () => {
  it("echoes channel/amount/currency/period", () => {
    const card = summarizeManualSpendAdd({
      channel: "specialized-site-x",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      amount: 500,
      currency: "EUR",
    })
    expect(card.kind).toBe("manual_spend_add")
    expect(card.title).toContain("specialized-site-x")
    const joined = card.lines.join(" | ")
    expect(joined).toContain("500")
    expect(joined).toContain("EUR")
    expect(joined).toContain("2026-06-01")
    expect(joined).toContain("2026-06-30")
  })
})

describe("summarizeDealerProfileUpsert", () => {
  it("echoes dealer_name/coverage_area/dealer_type", () => {
    const card = summarizeDealerProfileUpsert({
      dealer_name: "Acme Music",
      dealer_type: "boutique",
      coverage_area: "EU-West",
    })
    expect(card.kind).toBe("dealer_profile_upsert")
    expect(card.title).toContain("Acme Music")
    const joined = card.lines.join(" | ")
    expect(joined).toContain("boutique")
    expect(joined).toContain("EU-West")
  })
})
