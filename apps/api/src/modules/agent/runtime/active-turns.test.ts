// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { ActiveTurnsTestAccess, activeTurns, awaitTurns, trackTurn } from "./active-turns"

describe("active turns", () => {
  // The table is process-wide: a route test run in the same process may leave
  // a mocked turn in it.
  beforeEach(() => ActiveTurnsTestAccess.clear())

  it("awaitTurns resolves when turns end or at the deadline", async () => {
    expect(await awaitTurns(10)).toEqual({ drained: true, remaining: [] })

    // Ends: the wait resolves as the last turn ends, long before its deadline.
    let finish: () => void = () => {}
    const turn = trackTurn("chat:a", () => new Promise<void>((r) => (finish = r)))
    expect(activeTurns()).toEqual(["chat:a"])
    setTimeout(() => finish(), 20)
    const started = Date.now()
    expect(await awaitTurns(60_000)).toEqual({ drained: true, remaining: [] })
    expect(Date.now() - started).toBeLessThan(1_000)
    await turn

    // A turn that throws leaves the table too.
    await expect(
      trackTurn("x", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(activeTurns()).toEqual([])

    // Never ends: the wait is cut at its deadline and names what remains.
    void trackTurn("thread:b", () => new Promise<void>(() => {}))
    const cutAt = Date.now()
    const cut = await awaitTurns(50)
    expect(Date.now() - cutAt).toBeGreaterThanOrEqual(45)
    expect(cut).toEqual({ drained: false, remaining: ["thread:b"] })
  })
})
