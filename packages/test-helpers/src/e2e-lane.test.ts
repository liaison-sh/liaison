// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { waitForSchedulerTick } from "./e2e-lane"

describe("waitForSchedulerTick", () => {
  it("goes on at once when the scheduler is not registered", async () => {
    const started = Date.now()
    await waitForSchedulerTick({ zscore: async () => null }, "p:", "kernel-cron", "absent", 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("returns when the scheduler's next fire moves forward", async () => {
    let score = 1_000
    const redis = {
      zscore: async () => {
        score += 500
        return String(score)
      },
    }
    const started = Date.now()
    await waitForSchedulerTick(redis, "p:", "kernel-cron", "tick", 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("waits while the next fire stays put", async () => {
    const started = Date.now()
    await waitForSchedulerTick({ zscore: async () => "1000" }, "p:", "kernel-cron", "still", 600)
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
  })
})
