// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-WEB-5 and the quota arithmetic (blueprint task 10.4).
//
// The rule this file exists to enforce: degradation is ALWAYS explicit. A
// search box that quietly answers "no matches" because the browser evicted the
// index is worse than one that refuses, because the user believes the answer.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  estimateIndexStorage,
  INDEX_BYTES_PER_MESSAGE_MEASURED,
  isQuotaExceededError,
  planIndexCapacity,
  QUOTA_SAFETY_FRACTION,
  STORED_BYTES_PER_MESSAGE,
} from "~/modules/mailbox/search-index/quota"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("T-WEB-5: index capacity planning at the measured threshold", () => {
  it("derives its per-message figure from the measured ratio", () => {
    // Base64 of the sealed shard is 4 bytes on disk per 3 bytes of index.
    expect(STORED_BYTES_PER_MESSAGE).toBe(Math.ceil((INDEX_BYTES_PER_MESSAGE_MEASURED * 4) / 3))
  })

  it("indexes everything when the projection fits inside the safe share", () => {
    const free = 400 * 1024 * 1024
    // Exactly the number of messages the measured figure says will fit.
    const fits = Math.floor((free * QUOTA_SAFETY_FRACTION) / STORED_BYTES_PER_MESSAGE)
    const plan = planIndexCapacity({
      messageCount: fits,
      estimate: { usage: 0, quota: free },
    })
    expect(plan.mode).toBe("full")
    expect(plan.windowMonths).toBeNull()
  })

  it("degrades at the measured threshold, one message past what fits", () => {
    const free = 400 * 1024 * 1024
    const fits = Math.floor((free * QUOTA_SAFETY_FRACTION) / STORED_BYTES_PER_MESSAGE)
    const plan = planIndexCapacity({
      messageCount: fits + 1,
      estimate: { usage: 0, quota: free },
    })
    expect(plan.mode).toBe("reduced-window")
    // The offer the spec names: the last twelve months.
    expect(plan.windowMonths).toBe(12)
  })

  it("falls all the way to metadata only when even a year does not fit", () => {
    const plan = planIndexCapacity({
      messageCount: 500_000,
      messagesInWindow: 400_000,
      estimate: { usage: 0, quota: 20 * 1024 * 1024 },
    })
    expect(plan.mode).toBe("metadata-only")
  })

  it("counts what the origin already uses, not only the quota", () => {
    const quota = 400 * 1024 * 1024
    const fits = Math.floor((quota * QUOTA_SAFETY_FRACTION) / STORED_BYTES_PER_MESSAGE)
    const plan = planIndexCapacity({
      messageCount: fits,
      estimate: { usage: quota - 1024, quota },
    })
    expect(plan.mode).not.toBe("full")
  })

  it("indexes in full when the browser will not say what the quota is", () => {
    // An unknown quota is not a reason to refuse: the QuotaExceededError path
    // catches the real failure, and refusing on ignorance would disable search
    // on every browser without the Storage API.
    const plan = planIndexCapacity({ messageCount: 250_000, estimate: null })
    expect(plan.mode).toBe("full")
    expect(plan.estimateAvailable).toBe(false)
  })

  it("recognises the browser quota error by name and by constructor", () => {
    const named = new Error("out of room")
    named.name = "QuotaExceededError"
    expect(isQuotaExceededError(named)).toBe(true)
    expect(isQuotaExceededError(new Error("something else"))).toBe(false)
    expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true)
    expect(isQuotaExceededError(null)).toBe(false)
  })

  it("reads the storage estimate and survives a browser that has none", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ usage: 10, quota: 100 }) },
    })
    expect(await estimateIndexStorage()).toEqual({ usage: 10, quota: 100 })

    vi.stubGlobal("navigator", {})
    expect(await estimateIndexStorage()).toBeNull()

    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => {
          throw new Error("blocked")
        },
      },
    })
    expect(await estimateIndexStorage()).toBeNull()
  })
})
