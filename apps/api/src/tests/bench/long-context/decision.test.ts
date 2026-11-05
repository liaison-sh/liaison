// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type Cell, decide } from "./report"

function cell(partial: Partial<Cell> & { strategyId: string }): Cell {
  return {
    resumeWeek: "all",
    answers: 10,
    accuracyPct: 0,
    distractorAccuracyPct: 100,
    distractorCount: 2,
    meanFedTokens: 1000,
    meanProviderTokens: null,
    accuracyPer1k: 0,
    recallAt5: null,
    mrr: null,
    meanLatencyMs: 0,
    totalFedTokens: 0,
    errors: 0,
    ...partial,
  }
}

describe("the decision rule", () => {
  const table: Cell[] = [
    cell({ strategyId: "S0", accuracyPct: 84, accuracyPer1k: 1.7, meanFedTokens: 49_000 }),
    cell({ strategyId: "S1", accuracyPct: 70, accuracyPer1k: 8.0, meanFedTokens: 8_750 }),
    cell({ strategyId: "S2", accuracyPct: 83, accuracyPer1k: 9.2, meanFedTokens: 9_000 }),
    cell({ strategyId: "S3", accuracyPct: 86, accuracyPer1k: 9.0, meanFedTokens: 9_600 }),
    // S4 invents on distractors: ineligible however cheap it is.
    cell({ strategyId: "S4", accuracyPct: 88, accuracyPer1k: 30, distractorAccuracyPct: 60 }),
  ]

  it("picks the best accuracy per 1000 tokens within 5 points of the best absolute", () => {
    const out = decide(table)
    // Best eligible absolute is S3 at 86, so S1 at 70 is out of the window and
    // S2 at 83 is in it, with the better accuracy per 1000 tokens.
    expect(out.winner).toBe("S2")
    expect(out.eligible).toEqual(["S0", "S1", "S2", "S3"])
    expect(out.ineligible).toEqual([
      { id: "S4", reason: "distractor accuracy 60.0 percent is below the 90 percent floor" },
    ])
  })

  it("breaks a tie on accuracy per 1000 tokens by the lower id", () => {
    const tied = [
      cell({ strategyId: "S5", accuracyPct: 80, accuracyPer1k: 9 }),
      cell({ strategyId: "S2", accuracyPct: 80, accuracyPer1k: 9 }),
    ]
    expect(decide(tied).winner).toBe("S2")
  })

  it("keeps a strategy eligible when the probe set carries no distractor", () => {
    const out = decide([
      cell({
        strategyId: "S2",
        accuracyPct: 80,
        accuracyPer1k: 9,
        distractorAccuracyPct: null,
        distractorCount: 0,
      }),
    ])
    expect(out.winner).toBe("S2")
  })

  it("crowns nobody when every strategy invents", () => {
    const out = decide([
      cell({ strategyId: "S0", accuracyPct: 90, accuracyPer1k: 9, distractorAccuracyPct: 10 }),
    ])
    expect(out.winner).toBeNull()
  })
})
