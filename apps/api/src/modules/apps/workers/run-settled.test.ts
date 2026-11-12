// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { emitRunSettled, onRunSettled, type RunSettledInfo } from "./run-settled"
import { clearBridgeTimings, recentRunTimings } from "./timings"

const base: RunSettledInfo = {
  app: "rs-app",
  orgId: "00000000-0000-4000-8000-000000000001",
  entry: "tool:x",
  executor: "workers",
  nested: false,
  ms: 12,
  ok: true,
  at: 1,
}

afterEach(() => clearBridgeTimings())

describe("onRunSettled", () => {
  it("hands every subscriber the event, in order, until it unsubscribes", () => {
    const seen: string[] = []
    const offA = onRunSettled((i) => seen.push(`a:${i.entry}`))
    const offB = onRunSettled((i) => seen.push(`b:${i.entry}`))
    emitRunSettled(base)
    offA()
    emitRunSettled({ ...base, entry: "job:y" })
    offB()
    emitRunSettled({ ...base, entry: "job:z" })
    expect(seen).toEqual(["a:tool:x", "b:tool:x", "b:job:y"])
  })

  it("a throwing subscriber neither stops the others nor reaches the run", () => {
    const seen: number[] = []
    const offBad = onRunSettled(() => {
      throw new Error("boom")
    })
    const offGood = onRunSettled((i) => seen.push(i.ms))
    expect(() => emitRunSettled(base)).not.toThrow()
    expect(() => emitRunSettled(base)).not.toThrow()
    offBad()
    offGood()
    expect(seen).toEqual([12, 12])
  })

  it("the run timing records are one subscriber: sandboxed runs only, fallback fields kept", () => {
    emitRunSettled({ ...base, executor: "quickjs", fallback: "breaker", errorKind: "network" })
    // Trusted code in-process is not a sandboxed run.
    emitRunSettled({ ...base, app: "trusted-app", executor: "inprocess" })
    const runs = recentRunTimings()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: "run",
      app: "rs-app",
      executor: "quickjs",
      fallback: "breaker",
      errorKind: "network",
    })
  })
})
