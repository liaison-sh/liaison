// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  createOptimisticStep,
  createValueStep,
  runOptimisticMutation,
} from "~/modules/threads/thread-view-optimistic"

describe("threadView optimistic mutations", () => {
  it("applies optimistic steps before the request and keeps them on success", async () => {
    const values: string[] = []
    const request = vi.fn(async () => "ok")

    await expect(
      runOptimisticMutation({
        request,
        steps: [createValueStep((value) => values.push(value), "before", "after")],
      }),
    ).resolves.toBe("ok")

    expect(values).toEqual(["after"])
    expect(request).toHaveBeenCalledOnce()
  })

  it("rolls back applied steps in reverse order when the request fails", async () => {
    const events: string[] = []

    await expect(
      runOptimisticMutation({
        request: vi.fn(async () => {
          throw new Error("nope")
        }),
        steps: [
          createOptimisticStep(
            () => events.push("apply:first"),
            () => events.push("rollback:first"),
          ),
          createOptimisticStep(
            () => events.push("apply:second"),
            () => events.push("rollback:second"),
          ),
        ],
      }),
    ).rejects.toThrow("nope")

    expect(events).toEqual(["apply:first", "apply:second", "rollback:second", "rollback:first"])
  })

  it("rolls back already-applied steps when an optimistic step throws", async () => {
    const events: string[] = []

    await expect(
      runOptimisticMutation({
        request: vi.fn(async () => "unused"),
        steps: [
          createOptimisticStep(
            () => events.push("apply:first"),
            () => events.push("rollback:first"),
          ),
          createOptimisticStep(
            () => {
              events.push("apply:second")
              throw new Error("optimistic failed")
            },
            () => events.push("rollback:second"),
          ),
        ],
      }),
    ).rejects.toThrow("optimistic failed")

    expect(events).toEqual(["apply:first", "apply:second", "rollback:first"])
  })
})
