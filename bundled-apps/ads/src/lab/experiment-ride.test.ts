// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T5 — experiment design rides the gated spend tools' approval cards (§5.2).
// With an `experiment` param, the card includes title/hypothesis/metric_tier/
// minimum_sample/decision_date; without it, the card is unchanged (regression
// on the existing Meta summarizers).

import { describe, expect, it } from "bun:test"
import {
  summarizeCampaign,
  summarizeAdset,
  summarizeBudget,
  summarizeSetStatus,
} from "../summarizers"

const experiment = {
  experiment_id: "exp_123",
  title: "Brand vs non-brand split",
  hypothesis: "Splitting brand out lowers blended CPA",
  metric_tier: "purchase",
  minimum_sample: 100,
  decision_date: "2026-08-01",
}

function assertExperimentBlock(lines: string[]) {
  const joined = lines.join(" | ")
  expect(joined).toContain("Brand vs non-brand split")
  expect(joined).toContain("exp_123")
  expect(joined).toContain("Splitting brand out lowers blended CPA")
  expect(joined).toContain("purchase")
  expect(joined).toContain("100")
  expect(joined).toContain("2026-08-01")
}

describe("summarizeCampaign — experiment ride", () => {
  it("appends the Experiment block when `experiment` param is present", () => {
    const card = summarizeCampaign({
      name: "Search Brand",
      objective: "OUTCOME_SALES",
      special_ad_categories: [],
      experiment,
    })
    assertExperimentBlock(card.lines)
  })

  it("card is unchanged (no Experiment block) without `experiment` — regression", () => {
    const card = summarizeCampaign({
      name: "Search Brand",
      objective: "OUTCOME_SALES",
      special_ad_categories: [],
    })
    expect(card.lines.join(" | ")).not.toContain("Experiment:")
  })
})

describe("summarizeAdset — experiment ride", () => {
  it("appends the Experiment block when present", () => {
    const card = summarizeAdset({
      name: "Prospecting",
      campaign_id: "camp_1",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      experiment,
    })
    assertExperimentBlock(card.lines)
  })

  it("card is unchanged without `experiment` — regression", () => {
    const card = summarizeAdset({
      name: "Prospecting",
      campaign_id: "camp_1",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
    })
    expect(card.lines.join(" | ")).not.toContain("Experiment:")
  })
})

describe("summarizeBudget — experiment ride", () => {
  it("appends the Experiment block when present", () => {
    const card = summarizeBudget({
      level: "adset",
      object_id: "adset_1",
      daily_budget: "50.00",
      currency: "EUR",
      experiment,
    })
    assertExperimentBlock(card.lines)
  })

  it("card is unchanged without `experiment` — regression", () => {
    const card = summarizeBudget({
      level: "adset",
      object_id: "adset_1",
      daily_budget: "50.00",
      currency: "EUR",
    })
    expect(card.lines.join(" | ")).not.toContain("Experiment:")
  })
})

describe("summarizeSetStatus — experiment ride (ACTIVE direction only)", () => {
  it("appends the Experiment block when status=ACTIVE and experiment present", () => {
    const card = summarizeSetStatus({
      object_id: "adset_1",
      status: "ACTIVE",
      experiment,
    })
    assertExperimentBlock(card.lines)
  })

  it("does NOT append the block for status=PAUSED even if experiment present", () => {
    const card = summarizeSetStatus({
      object_id: "adset_1",
      status: "PAUSED",
      experiment,
    })
    expect(card.lines.join(" | ")).not.toContain("Experiment:")
  })

  it("card is unchanged without `experiment` — regression", () => {
    const card = summarizeSetStatus({
      object_id: "adset_1",
      status: "ACTIVE",
    })
    expect(card.lines.join(" | ")).not.toContain("Experiment:")
  })
})
