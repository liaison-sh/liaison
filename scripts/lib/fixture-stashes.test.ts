// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { ABANDONED_STASH_QUERY, formatAbandonedStashReport } from "./fixture-stashes"

describe("db-reset reports the fixture stashes it found", () => {
  test("says nothing when the database is clean", () => {
    expect(formatAbandonedStashReport("")).toBeNull()
    expect(formatAbandonedStashReport("\n  \n")).toBeNull()
  })

  test("names every stash it found, and counts them", () => {
    const report = formatAbandonedStashReport(
      "app_invoicing__fixture_stash_p101_aaaaaaaa\napp_mail__fixture_stash_p102_bbbbbbbb\n",
    )
    expect(report).not.toBeNull()
    expect(report).toContain("Found 2 abandoned fixture stashes")
    expect(report).toContain("app_invoicing__fixture_stash_p101_aaaaaaaa")
    expect(report).toContain("app_mail__fixture_stash_p102_bbbbbbbb")
  })

  test("reads as English for a single stash", () => {
    const report = formatAbandonedStashReport("app_mail__fixture_stash_p102_bbbbbbbb\n")
    expect(report).toContain("Found 1 abandoned fixture stash before the drop")
    expect(report).not.toContain("stashes")
  })

  // The wildcard half of the same claim: the prefix is mostly underscores, and
  // an unescaped LIKE would name unrelated schemas in a report an operator is
  // meant to act on.
  test("the query escapes the underscores in the stash marker", () => {
    expect(ABANDONED_STASH_QUERY).toContain("\\_\\_fixture\\_stash\\_")
    expect(ABANDONED_STASH_QUERY).toContain("ESCAPE")
  })
})
