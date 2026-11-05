// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { adaptCadence, shouldAutoWatch } from "./auto-watch"

describe("shouldAutoWatch (B3)", () => {
  test.each([
    ["keyword match with 20 comments", { relation: "keyword_match", commentCount: 20 }, true],
    ["keyword match with 19 comments", { relation: "keyword_match", commentCount: 19 }, false],
    [
      "one brand-relevant comment",
      { relation: "comment_on_our_content", commentCount: 0, brandRelevant: true },
      true,
    ],
    ["a praise mention, no comments", { relation: "mention", commentCount: 0 }, false],
  ])("%s → %s", (_l, f, expected) => {
    expect(shouldAutoWatch(f as never)).toBe(expected)
  })
})

const NOW = new Date("2026-06-01T12:00:00Z")

describe("adaptCadence (B3)", () => {
  test("activity keeps a watch hot (5m)", () => {
    expect(adaptCadence("active", true, NOW.toISOString(), NOW)).toMatchObject({
      cadenceSeconds: 300,
      status: "active",
    })
  })

  test("7 idle days decays the watch", () => {
    const eightDaysAgo = new Date(NOW.getTime() - 8 * 24 * 3600_000).toISOString()
    expect(adaptCadence("active", false, eightDaysAgo, NOW)).toMatchObject({ status: "decayed" })
  })

  test("fresh activity resurrects a decayed watch to warm (1h)", () => {
    expect(adaptCadence("decayed", true, NOW.toISOString(), NOW)).toMatchObject({
      status: "active",
      cadenceSeconds: 3600,
    })
  })

  test("no activity but recently active → warm cadence (1h), still active", () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000).toISOString()
    expect(adaptCadence("active", false, twoHoursAgo, NOW)).toMatchObject({ status: "active" })
  })
})
