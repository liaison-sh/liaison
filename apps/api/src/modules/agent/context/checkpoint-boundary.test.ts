// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The checkpoint boundary never takes the newest row: it is the message the
// coming turn answers, so it stays raw however large it is.

import { describe, expect, it } from "bun:test"
import { checkpointBoundaryIndex } from "~/modules/agent/context/checkpoint"

const row = (chars: number) => ({ content: "x".repeat(chars), metadata: null })

describe("checkpointBoundaryIndex", () => {
  it("cuts where the rows after the boundary pass the reserve", () => {
    const tail = [row(4_000), row(4_000), row(4_000), row(4_000)]
    // ~1,000 tokens a row: the last two pass a 1,500 token reserve.
    expect(checkpointBoundaryIndex(tail, 1_500)).toBe(2)
  })

  it("keeps the newest row raw when it alone passes the reserve", () => {
    const tail = [row(400), row(400), row(200_000)]
    expect(checkpointBoundaryIndex(tail, 12_000)).toBe(1)
  })

  it("has nothing to summarize when the only row is the newest one", () => {
    expect(checkpointBoundaryIndex([row(200_000)], 12_000)).toBe(-1)
  })

  it("has nothing to summarize when the tail fits the reserve", () => {
    expect(checkpointBoundaryIndex([row(400), row(400)], 12_000)).toBe(-1)
  })
})
