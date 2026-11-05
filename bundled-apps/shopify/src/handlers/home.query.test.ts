// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure query-shape oracle for the Home tab's "Unfulfilled past SLA" list.
//
// Regression pin: cancelled and archived (closed) orders -- including refunded
// ones -- keep displayFulfillmentStatus UNFULFILLED forever in Shopify. Without
// `status:open` the attention list fills with phantom rows nobody can or should
// fulfill (20 refunded/archived orders on the Fabrikam prod store, 2026-07-11).
// scan-unfulfilled.ts already carried the guard; the Home query built its own
// string without it. This test pins BOTH the guard and the lookback bound so
// the two query builders cannot silently diverge on the open-orders invariant.
import { describe, expect, test } from "bun:test"
import { buildUnfulfilledQuery } from "./home"

describe("buildUnfulfilledQuery", () => {
  test("excludes cancelled/archived orders via status:open", () => {
    expect(buildUnfulfilledQuery(24)).toContain("status:open")
  })

  test("filters to unfulfilled orders past the SLA cutoff", () => {
    const q = buildUnfulfilledQuery(24)
    expect(q).toContain("fulfillment_status:unfulfilled")
    expect(q).toMatch(/created_at:<'\d{4}-\d{2}-\d{2}T[0-9:.]+Z'/)
  })

  test("bounds the window with a lookback so ancient stuck orders stay out", () => {
    expect(buildUnfulfilledQuery(24)).toMatch(/created_at:>'\d{4}-\d{2}-\d{2}T[0-9:.]+Z'/)
  })

  test("cutoff honours the SLA hours parameter", () => {
    const q = buildUnfulfilledQuery(48)
    const m = q.match(/created_at:<'([^']+)'/)
    expect(m).not.toBeNull()
    const cutoffMs = new Date(m![1]!).getTime()
    const expected = Date.now() - 48 * 3_600_000
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(5_000)
  })
})
