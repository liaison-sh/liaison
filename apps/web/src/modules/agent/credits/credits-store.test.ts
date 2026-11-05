// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credits storm: the box logged 15 500 GET /credits/balance and 6 800 GET
// /credits/models in forty minutes from two or three browser sessions, most of
// them answered 429, which starved every other request on the same limiter.
// The cause was a per-ThreadView `createResource` for each endpoint: one copy
// per mounted conversation, per mount. These are the rules that replace it.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import {
  availableModelIds,
  BALANCE_MAX_AGE_MS,
  creditsBalance,
  creditsBalanceStale,
  ensureAvailableModels,
  ensureCreditsBalance,
  refreshAvailableModels,
  resetCreditsStore,
} from "~/modules/agent/credits/credits-store"

function makeApi(get: (path: string) => Promise<unknown>): ApiClient {
  return { get: (path: string) => get(path) } as unknown as ApiClient
}

describe("credits-store", () => {
  beforeEach(() => {
    resetCreditsStore()
    vi.useRealTimers()
  })

  it("ten conversations mounting together issue ONE models request", async () => {
    const get = vi.fn(async () => ({ models: [{ modelId: "claude-opus-4-5" }] }))
    const api = makeApi(get)
    await Promise.all(Array.from({ length: 10 }, () => ensureAvailableModels(api)))
    expect(get).toHaveBeenCalledTimes(1)
    expect(availableModelIds()?.has("claude-opus-4-5")).toBe(true)
    // And the eleventh, mounting later in the same session, issues none: the
    // org's provider keys are not going to change while the tab is open.
    await ensureAvailableModels(api)
    expect(get).toHaveBeenCalledTimes(1)
  })

  // A visitor pasting their first key must see its models in the picker at
  // once: "once per session" stops at a change of the org's keys.
  it("re-reads the models when the org's keys change, and after an in-flight read", async () => {
    let models = [] as string[]
    const get = vi.fn(async () => ({ models: models.map((modelId) => ({ modelId })) }))
    const api = makeApi(get)
    await ensureAvailableModels(api)
    expect(availableModelIds()?.size).toBe(0)
    models = ["gemini-flash-lite-latest"]
    await refreshAvailableModels(api)
    expect(get).toHaveBeenCalledTimes(2)
    expect(availableModelIds()?.has("gemini-flash-lite-latest")).toBe(true)
    // A read already in flight when the key changed is followed by a fresh one.
    resetCreditsStore()
    const first = ensureAvailableModels(api)
    const refreshed = refreshAvailableModels(api)
    await Promise.all([first, refreshed])
    expect(get).toHaveBeenCalledTimes(4)
  })

  it("ten conversations mounting together issue ONE balance request", async () => {
    const get = vi.fn(async () => ({ data: { included: "0", purchased: "5", currency: "EUR" } }))
    const api = makeApi(get)
    await Promise.all(Array.from({ length: 10 }, () => ensureCreditsBalance(api)))
    expect(get).toHaveBeenCalledTimes(1)
    expect(creditsBalance()?.purchased).toBe("5")
  })

  it("re-reads the balance at most once a minute", async () => {
    vi.useFakeTimers()
    const get = vi.fn(async () => ({ included: "0", purchased: "1", currency: "EUR" }))
    const api = makeApi(get)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BALANCE_MAX_AGE_MS - 1_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("a finished turn may jump the throttle, rendering may not", async () => {
    const get = vi.fn(async () => ({ included: "0", purchased: "1", currency: "EUR" }))
    const api = makeApi(get)
    await ensureCreditsBalance(api)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(1)
    creditsBalanceStale()
    await ensureCreditsBalance(api, { force: true })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("a 429 parks the endpoint instead of being retried", async () => {
    vi.useFakeTimers()
    const get = vi.fn(async () => {
      throw new ApiError("Too many requests", 429, "rate_limited", 30)
    })
    const api = makeApi(get)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(1)
    // No immediate retry, however many conversations ask.
    await ensureCreditsBalance(api)
    await ensureCreditsBalance(api, { force: true })
    await ensureAvailableModels(makeApi(get))
    expect(get).toHaveBeenCalledTimes(2) // the balance once, the models once
    vi.advanceTimersByTime(29_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(2)
    // Retry-After honoured, and only then.
    vi.advanceTimersByTime(2_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it("the backoff grows while the failures last", async () => {
    vi.useFakeTimers()
    const get = vi.fn(async () => {
      throw new ApiError("Too many requests", 429)
    })
    const api = makeApi(get)
    await ensureCreditsBalance(api) // 1st failure -> 30s
    vi.advanceTimersByTime(31_000)
    await ensureCreditsBalance(api) // 2nd failure -> 60s
    expect(get).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(31_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(31_000)
    await ensureCreditsBalance(api)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it("keeps the last known balance when a read is rate limited", async () => {
    let fail = false
    const get = vi.fn(async () => {
      if (fail) throw new ApiError("Too many requests", 429)
      return { included: "0", purchased: "7", currency: "EUR" }
    })
    const api = makeApi(get)
    await ensureCreditsBalance(api)
    expect(creditsBalance()?.purchased).toBe("7")
    fail = true
    creditsBalanceStale()
    await ensureCreditsBalance(api, { force: true })
    expect(creditsBalance()?.purchased).toBe("7")
  })
})
