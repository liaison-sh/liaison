// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cross-view parity oracle: every ticket smart filter must share ONE default
// sort direction. Sibling views of the same entity list may differ in what
// they filter, never in how they order time, unless the exception is named
// here on purpose. A view that silently diverges (the historical
// needs-attention oldest-first regression) fails this test the moment it
// lands, instead of waiting for a human to notice dates reading "messed up".
import { describe, expect, it } from "vitest"
import type { SmartFilter } from "./ticket-list-store"
import { paramsForSmartFilter } from "./ticket-list-store"

const ALL_FILTERS: SmartFilter[] = [
  "needs-attention",
  "awaiting-customer",
  "follow-ups",
  "closed",
  "all-open",
]

// Views allowed to deviate from the shared default sort. Empty on purpose:
// add an entry ONLY with a product decision recorded next to it.
const SORT_EXCEPTIONS: Partial<Record<SmartFilter, string>> = {}

const SHARED_DEFAULT_SORT = "activity_newest"

describe("ticket smart filter cross-view parity", () => {
  it("every smart filter resolves the shared default sort unless excepted by name", () => {
    for (const filter of ALL_FILTERS) {
      const expected = SORT_EXCEPTIONS[filter] ?? SHARED_DEFAULT_SORT
      expect(paramsForSmartFilter(filter).sort, `sort for smart filter "${filter}"`).toBe(expected)
    }
  })

  it("covers the whole SmartFilter union (a new filter must be added here)", () => {
    // Type-level exhaustiveness: if SmartFilter grows, this map stops compiling.
    const covered: Record<SmartFilter, true> = {
      "needs-attention": true,
      "awaiting-customer": true,
      "follow-ups": true,
      closed: true,
      "all-open": true,
    }
    expect(Object.keys(covered).sort()).toEqual([...ALL_FILTERS].sort())
  })
})
