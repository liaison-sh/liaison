// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A shared read runs once for every caller of the same key, with its own signal: one caller
// leaving (a tab closed) never cancels it for the others; it stops only when every caller has
// gone (step-2 review LOW 14).

import { describe, expect, it } from "bun:test"
import { singleFlight } from "~/modules/dashboards/cache"

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("singleFlight", () => {
  it("runs once for concurrent callers", async () => {
    let runs = 0
    const gate = deferred<number>()
    const fn = async () => {
      runs++
      return gate.promise
    }
    const a = singleFlight("sf:once", fn)
    const b = singleFlight("sf:once", fn)
    gate.resolve(7)
    expect(await Promise.all([a, b])).toEqual([7, 7])
    expect(runs).toBe(1)
  })

  it("one caller leaving does not stop the shared run", async () => {
    const gate = deferred<string>()
    let seen: AbortSignal | undefined
    const first = new AbortController()
    const second = new AbortController()
    const fn = async (signal: AbortSignal) => {
      seen = signal
      return gate.promise
    }
    const a = singleFlight("sf:leave", fn, first.signal)
    const b = singleFlight("sf:leave", fn, second.signal)
    first.abort()
    expect(seen?.aborted).toBe(false)
    gate.resolve("rows")
    expect(await b).toBe("rows")
    expect(await a).toBe("rows")
  })

  it("stops once every caller has left", async () => {
    const gate = deferred<string>()
    let seen: AbortSignal | undefined
    const first = new AbortController()
    const second = new AbortController()
    const fn = async (signal: AbortSignal) => {
      seen = signal
      return gate.promise
    }
    const a = singleFlight("sf:all", fn, first.signal)
    const b = singleFlight("sf:all", fn, second.signal)
    first.abort()
    second.abort()
    expect(seen?.aborted).toBe(true)
    gate.resolve("late")
    await Promise.all([a, b])
  })

  it("a caller without a signal keeps the run going", async () => {
    const gate = deferred<number>()
    let seen: AbortSignal | undefined
    const leaving = new AbortController()
    const fn = async (signal: AbortSignal) => {
      seen = signal
      return gate.promise
    }
    const a = singleFlight("sf:nosignal", fn)
    const b = singleFlight("sf:nosignal", fn, leaving.signal)
    leaving.abort()
    expect(seen?.aborted).toBe(false)
    gate.resolve(1)
    await Promise.all([a, b])
  })

  it("a caller arriving after everyone left, before the run settles, starts a fresh run", async () => {
    const gate = deferred<string>()
    let runs = 0
    const leaving = new AbortController()
    const fn = async (signal: AbortSignal) => {
      runs++
      if (runs === 1) {
        await gate.promise
        if (signal.aborted) throw new Error("cancelled")
        return "stale"
      }
      return "fresh"
    }
    const old = singleFlight("sf:rejoin", fn, leaving.signal).catch((e: Error) => e.message)
    leaving.abort()
    // A reload of the tab: same key, while the aborted run has not settled yet.
    const next = singleFlight("sf:rejoin", fn, new AbortController().signal)
    gate.resolve("late")
    expect(await next).toBe("fresh")
    expect(runs).toBe(2)
    expect(await old).toBe("cancelled")
  })
})
