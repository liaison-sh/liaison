// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DEFAULT_STATUS_SEEDS, normalizeStatusSeeds } from "./create-project"

describe("projects.create.statuses", () => {
  it("falls back to the five defaults when no columns are given", () => {
    expect(normalizeStatusSeeds(undefined)).toBe(DEFAULT_STATUS_SEEDS)
    expect(normalizeStatusSeeds([])).toBe(DEFAULT_STATUS_SEEDS)
  })

  it("keeps the user's labels, in order, and makes the last column terminal when none is", () => {
    const seeds = normalizeStatusSeeds(
      ["Idea", "In discussion", "Candidate", "Todo", "In progress", "Done"].map((label) => ({
        label,
      })),
    )
    expect(seeds.map(([label]) => label)).toEqual([
      "Idea",
      "In discussion",
      "Candidate",
      "Todo",
      "In progress",
      "Done",
    ])
    expect(seeds.map(([, order]) => order)).toEqual([0, 1, 2, 3, 4, 5])
    expect(seeds.map(([, , terminal]) => terminal)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
    expect(seeds.map(([, , , color]) => color)).toEqual([null, null, null, null, null, null])
  })

  it("respects an explicit terminal flag instead of forcing the last column", () => {
    const seeds = normalizeStatusSeeds([
      { label: "Open" },
      { label: "Closed", terminal: true, color: "#22c55e" },
      { label: "Parked" },
    ])
    expect(seeds.map(([label, , terminal, color]) => [label, terminal, color])).toEqual([
      ["Open", false, null],
      ["Closed", true, "#22c55e"],
      ["Parked", false, null],
    ])
  })

  it("trims labels and rejects empty, duplicate (case-insensitive) or oversized ones", () => {
    expect(normalizeStatusSeeds([{ label: "  Idea " }])[0]![0]).toBe("Idea")
    expect(() => normalizeStatusSeeds([{ label: "Idea" }, { label: "   " }])).toThrow(
      /invalid_statuses: column 2 has an empty label/,
    )
    expect(() => normalizeStatusSeeds([{ label: "Todo" }, { label: "todo" }])).toThrow(
      /invalid_statuses: duplicate column "todo"/,
    )
    expect(() => normalizeStatusSeeds([{ label: "x".repeat(61) }])).toThrow(/longer than 60/)
    expect(() =>
      normalizeStatusSeeds(Array.from({ length: 21 }, (_, i) => ({ label: `c${i}` }))),
    ).toThrow(/at most 20 columns \(got 21\)/)
  })
})
