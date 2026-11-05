// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ReDoS check of a manifest pattern never parks this thread on a Worker: that
// wait has no deadline, and a Worker that deadlocks holds the whole event loop.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { manifestRegExp } from "./manifest-regex"

describe("the manifest pattern check", () => {
  const started: string[] = []
  const realWorker = globalThis.Worker
  const realWait = Atomics.wait

  beforeEach(() => {
    started.length = 0
    globalThis.Worker = class extends realWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        started.push(String(url))
        super(url, options)
      }
    } as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = realWorker
    Atomics.wait = realWait
  })

  it("runs on this thread: no Worker and no Atomics.wait", () => {
    const wait = spyOn(Atomics, "wait")
    expect(manifestRegExp(`^backend-check-${crypto.randomUUID()}[a-z]+$`).test("x")).toBe(false)
    expect(started).toEqual([])
    expect(wait).not.toHaveBeenCalled()
  })

  it("still refuses a pattern that can backtrack catastrophically", () => {
    expect(() => manifestRegExp(`^(a+)+${crypto.randomUUID()}$`)).toThrow("backtrack")
  })
})
