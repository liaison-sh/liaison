// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { silenceLimitMs, tailLines, watchSilence } from "./unit-watchdog"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("silenceLimitMs", () => {
  it("is five per-test timeouts", () => {
    expect(silenceLimitMs(60_000)).toBe(300_000)
  })

  it("takes an override, and ignores one that is not a positive number", () => {
    expect(silenceLimitMs(60_000, "90000")).toBe(90_000)
    expect(silenceLimitMs(60_000, "soon")).toBe(300_000)
    expect(silenceLimitMs(60_000, "0")).toBe(300_000)
  })
})

describe("watchSilence", () => {
  it("fires once, after the limit, when nothing arrives", async () => {
    const fired: number[] = []
    const watch = watchSilence(40, (ms) => fired.push(ms), 10)
    await wait(120)
    watch.stop()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toBeGreaterThanOrEqual(40)
  })

  it("stays quiet while output keeps arriving", async () => {
    const fired: number[] = []
    const watch = watchSilence(60, (ms) => fired.push(ms), 10)
    for (let i = 0; i < 6; i++) {
      await wait(20)
      watch.touch()
    }
    watch.stop()
    expect(fired).toEqual([])
  })

  it("never fires after stop", async () => {
    const fired: number[] = []
    const watch = watchSilence(20, (ms) => fired.push(ms), 5)
    watch.stop()
    await wait(60)
    expect(fired).toEqual([])
  })
})

describe("tailLines", () => {
  it("keeps the last non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n", 2)).toBe("b\nc")
  })
})
