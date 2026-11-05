// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dashboard's tool-call concurrency limiter: a mount-time burst of ~10
// resource fetches must never hold more than MAX_INFLIGHT_TOOL_CALLS sandbox
// slots at once (pool starvation + the documented module-leak spiral).
import { beforeEach, describe, expect, it, mock } from "bun:test"

let live = 0
let peak = 0
const pending: Array<() => void> = []

mock.module("@liaison/host", () => ({
  app: {
    invokeTool: () => {
      live++
      peak = Math.max(peak, live)
      return new Promise((resolve) => {
        pending.push(() => {
          live--
          resolve({ ok: true })
        })
      })
    },
  },
  navigate: () => {},
}))

import { limitedInvoke } from "./Dashboard"

describe("limitedInvoke", () => {
  beforeEach(() => {
    live = 0
    peak = 0
    pending.length = 0
  })

  it("caps in-flight tool calls at 3 under a 10-call burst and drains the queue", async () => {
    const calls = Array.from({ length: 10 }, (_, i) => limitedInvoke(`tool_${i}`, {}))
    // Only 3 reached the host; 7 queued.
    expect(live).toBe(3)
    expect(peak).toBe(3)
    // Drain: as each settles, a queued call takes its slot; the cap holds.
    while (pending.length > 0) {
      pending.shift()!()
      await Promise.resolve()
      await Promise.resolve()
      expect(live).toBeLessThanOrEqual(3)
    }
    await Promise.all(calls)
    expect(peak).toBe(3)
    expect(live).toBe(0)
  })

  it("releases the slot when a call rejects and still resolves queued callers", async () => {
    let rejectFirst: (() => void) | null = null
    mock.module("@liaison/host", () => ({
      app: {
        invokeTool: (name: string) => {
          live++
          peak = Math.max(peak, live)
          if (name === "boom" && !rejectFirst) {
            return new Promise((_, reject) => {
              rejectFirst = () => {
                live--
                reject(new Error("boom"))
              }
            })
          }
          return new Promise((resolve) => {
            pending.push(() => {
              live--
              resolve({ ok: true })
            })
          })
        },
      },
      navigate: () => {},
    }))
    const failing = limitedInvoke("boom", {}).catch((e) => e)
    const others = Array.from({ length: 4 }, (_, i) => limitedInvoke(`t${i}`, {}))
    rejectFirst!()
    await Promise.resolve()
    await Promise.resolve()
    expect(live).toBeLessThanOrEqual(3)
    while (pending.length > 0) {
      pending.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
    const err = await failing
    expect(err).toBeInstanceOf(Error)
    await Promise.all(others)
    expect(live).toBe(0)
  })
})
