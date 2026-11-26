// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { highlighted } from "./highlight"

describe("highlighted", () => {
  it("marks every word of the query, case and accents aside", () => {
    expect(highlighted("The Refund délai is 30 days", "refund delai")).toEqual([
      { text: "The ", match: false },
      { text: "Refund", match: true },
      { text: " ", match: false },
      { text: "délai", match: true },
      { text: " is 30 days", match: false },
    ])
  })

  it("marks nothing for an empty or one-letter query", () => {
    expect(highlighted("abc", " a ")).toEqual([{ text: "abc", match: false }])
  })
})
