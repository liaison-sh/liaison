// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { padToResponseFloor } from "~/lib/response-timing"

describe("padToResponseFloor (U-3: no account-existence timing oracle)", () => {
  it("holds a fast answer until the floor", async () => {
    const t0 = performance.now()
    await padToResponseFloor(t0, 120)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(115)
  })

  it("does not delay an answer that already took longer than the floor", async () => {
    const started = performance.now() - 500
    const t0 = performance.now()
    await padToResponseFloor(started, 120)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
