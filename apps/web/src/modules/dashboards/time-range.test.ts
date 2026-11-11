// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  choiceFromQuery,
  choiceKey,
  choiceToParams,
  compareWindowOf,
  DEFAULT_CHOICE,
  deltaOf,
  formatWindow,
  initialChoice,
  isValidTimeRange,
  queryOf,
  resolveTimeRange,
  sameChoice,
  withChoiceInPath,
  withoutChoiceInPath,
} from "./time-range"

const TODAY = "2026-11-11"

describe("resolveTimeRange (mirrors the server's presets)", () => {
  it.each([
    ["last7d", "2026-11-05", "2026-11-11"],
    ["last30d", "2026-10-13", "2026-11-11"],
    ["last90d", "2026-08-14", "2026-11-11"],
    ["mtd", "2026-11-01", "2026-11-11"],
    ["lastMonth", "2026-10-01", "2026-10-31"],
    ["qtd", "2026-10-01", "2026-11-11"],
    ["lastQuarter", "2026-07-01", "2026-09-30"],
    ["ytd", "2026-01-01", "2026-11-11"],
    ["lastYear", "2025-01-01", "2025-12-31"],
  ] as const)("%s", (preset, from, to) => {
    expect(resolveTimeRange({ preset }, TODAY)).toEqual({ from, to })
  })

  it("a custom range is its own days", () => {
    expect(
      resolveTimeRange({ preset: "custom", from: "2026-01-05", to: "2026-02-01" }, TODAY),
    ).toEqual({ from: "2026-01-05", to: "2026-02-01" })
  })
})

describe("compareWindowOf", () => {
  it("same period last year keeps a month's last day on the last day", () => {
    expect(compareWindowOf("mtd", { from: "2026-11-01", to: "2026-11-11" }, "lastYear")).toEqual({
      from: "2025-11-01",
      to: "2025-11-11",
    })
    expect(
      compareWindowOf("lastMonth", { from: "2024-02-01", to: "2024-02-29" }, "lastYear"),
    ).toEqual({ from: "2023-02-01", to: "2023-02-28" })
  })

  it("previous period: the month before for month to date, the equal span before otherwise", () => {
    expect(
      compareWindowOf("mtd", { from: "2026-11-01", to: "2026-11-11" }, "previousPeriod"),
    ).toEqual({ from: "2026-10-01", to: "2026-10-11" })
    expect(
      compareWindowOf("last7d", { from: "2026-11-05", to: "2026-11-11" }, "previousPeriod"),
    ).toEqual({ from: "2026-10-29", to: "2026-11-04" })
  })

  it("none compares with nothing", () => {
    expect(compareWindowOf("mtd", { from: "2026-11-01", to: "2026-11-11" }, "none")).toBeNull()
  })
})

describe("the choice in a URL", () => {
  it("reads a preset and a compare mode", () => {
    expect(choiceFromQuery("?range=qtd&compare=previousPeriod")).toEqual({
      timeRange: { preset: "qtd" },
      compare: "previousPeriod",
    })
  })

  it("reads a custom range, also from from/to alone", () => {
    const custom = { preset: "custom", from: "2026-11-01", to: "2026-11-11" }
    expect(choiceFromQuery("range=custom&from=2026-11-01&to=2026-11-11").timeRange).toEqual(custom)
    expect(choiceFromQuery("from=2026-11-01&to=2026-11-11").timeRange).toEqual(custom)
  })

  it("drops what the server would refuse", () => {
    expect(choiceFromQuery("range=forever&compare=never")).toEqual({})
    expect(choiceFromQuery("range=custom&from=2026-11-11&to=2026-11-01")).toEqual({})
    expect(choiceFromQuery("range=custom&from=2026-02-30&to=2026-03-01")).toEqual({})
    expect(isValidTimeRange({ preset: "mtd", from: "2026-11-01" })).toBe(false)
  })

  it("writes a choice back, keeping other parameters", () => {
    const c = {
      timeRange: { preset: "custom" as const, from: "2026-11-01", to: "2026-11-11" },
      compare: "none" as const,
    }
    expect(choiceToParams(c).toString()).toBe(
      "range=custom&from=2026-11-01&to=2026-11-11&compare=none",
    )
    expect(withChoiceInPath("/dashboard/d1?x=1&range=mtd", DEFAULT_CHOICE)).toBe(
      "/dashboard/d1?x=1&range=last30d&compare=lastYear",
    )
    expect(withoutChoiceInPath("/dashboard/d1?range=mtd&compare=none")).toBe("/dashboard/d1")
    expect(withoutChoiceInPath("/dashboard/d1?x=1&range=mtd")).toBe("/dashboard/d1?x=1")
    expect(queryOf("/dashboard/d1?range=mtd")).toBe("range=mtd")
    expect(queryOf(undefined)).toBe("")
  })
})

describe("initialChoice: link > saved > default", () => {
  const saved = { timeRange: { preset: "ytd" as const }, compare: "previousPeriod" as const }

  it("the link wins, part by part", () => {
    expect(initialChoice({ timeRange: { preset: "mtd" } }, saved)).toEqual({
      timeRange: { preset: "mtd" },
      compare: "previousPeriod",
    })
    expect(initialChoice({ compare: "none" }, saved)).toEqual({
      timeRange: { preset: "ytd" },
      compare: "none",
    })
  })

  it("the saved choice otherwise", () => {
    expect(initialChoice({}, saved)).toEqual(saved)
  })

  it("defaults to last 30 days compared with the same period last year", () => {
    expect(initialChoice({}, null)).toEqual({
      timeRange: { preset: "last30d" },
      compare: "lastYear",
    })
  })

  it("keys and compares choices", () => {
    expect(sameChoice(saved, { ...saved })).toBe(true)
    expect(sameChoice(saved, DEFAULT_CHOICE)).toBe(false)
    expect(choiceKey(saved)).not.toBe(choiceKey(DEFAULT_CHOICE))
  })
})

describe("deltaOf and formatWindow", () => {
  it("a change is a fraction of the previous value; none without one", () => {
    expect(deltaOf(112, 100)).toBeCloseTo(0.12)
    expect(deltaOf(-50, -100)).toBeCloseTo(0.5)
    expect(deltaOf(5, 0)).toBeNull()
    expect(deltaOf(5, null)).toBeNull()
    expect(deltaOf(null, 5)).toBeNull()
  })

  it("a window reads as one range of days", () => {
    const text = formatWindow({ from: "2026-11-01", to: "2026-11-11" }, "en-GB")
    expect(text).toMatch(/1\s*[–-]\s*11 Nov 2026/)
    expect(formatWindow({ from: "2026-11-01", to: "2026-11-11" }, "fr")).toMatch(/nov/)
  })
})
