// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ATTENTION_POLL_MS, attentionStore } from "./attention-store"

function makeFakeApi(opts: { getEnvelope: ReturnType<typeof vi.fn> }): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getEnvelope: opts.getEnvelope,
  } as unknown as ApiClient
}

beforeEach(() => {
  attentionStore._setForTest({
    items: [],
    errors: [],
    loading: false,
  })
})

afterEach(() => {
  attentionStore.stop()
  vi.useRealTimers()
})

describe("attention-store", () => {
  it("attention-store.debounce-coalesces-burst", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    const api = makeFakeApi({ getEnvelope: fetchMock })
    attentionStore.start(api)
    for (let i = 0; i < 10; i++) attentionStore.markStaleAndReload(api)
    // Debounce widened to 2000ms (L14) to coalesce reconnect/resync bursts.
    vi.advanceTimersByTime(2000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)) // start() + 1 debounced burst
  })

  it("attention-store.two-calls-1s-apart-coalesce-to-one-fetch", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    const api = makeFakeApi({ getEnvelope: fetchMock })
    attentionStore.markStaleAndReload(api)
    vi.advanceTimersByTime(1000)
    attentionStore.markStaleAndReload(api) // resets the 2s window
    vi.advanceTimersByTime(1999)
    // Still within the widened window after the second call -> no fetch yet.
    expect(fetchMock).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    vi.useRealTimers()
  })

  it("attention-store.sustained-burst-forces-a-load-within-max-wait", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    const api = makeFakeApi({ getEnvelope: fetchMock })
    attentionStore.start(api)
    fetchMock.mockClear() // drop start()'s own immediate load

    // Faster than the 2s trailing debounce, so a pure trailing debounce would
    // starve indefinitely. Fire every 1s for 10s (10 calls).
    for (let i = 0; i < 10; i++) {
      attentionStore.markStaleAndReload(api)
      vi.advanceTimersByTime(1_000)
    }
    // The 5s max-wait must have forced at least one load during the burst,
    // well before the burst's own trailing edge could fire.
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1))
  })

  it("attention-store.attentionForApp-filters", () => {
    attentionStore._setForTest({
      items: [{ app: "tickets", urgency: 70 } as never, { app: "projects", urgency: 60 } as never],
      errors: [],
    })
    expect(attentionStore.attentionForApp("tickets").length).toBe(1)
    expect(attentionStore.attentionForApp("projects").length).toBe(1)
    expect(attentionStore.attentionForApp("kernel").length).toBe(0)
  })

  // An approval decided from its row leaves the feed at once, and a reload
  // that started BEFORE the decision (still carrying it) does not bring it
  // back; the next reload is the server's word again.
  it("attention-store.resolve-locally-hides-the-row-until-a-later-reload", async () => {
    const row = { id: "kernel:approval:a1", app: "kernel" } as never
    const other = { id: "tickets:t1", app: "tickets" } as never
    attentionStore._setForTest({ items: [row, other], errors: [] })
    let release: (v: unknown) => void = () => {}
    const stale = vi.fn(
      () =>
        new Promise((r) => {
          release = r
        }),
    )
    const inFlight = attentionStore.load(makeFakeApi({ getEnvelope: stale }))
    attentionStore.resolveLocally("kernel:approval:a1")
    expect(attentionStore.items.map((i) => i.id)).toEqual(["tickets:t1"])
    release({ data: { items: [row, other], errors: [] } })
    await inFlight
    expect(attentionStore.items.map((i) => i.id)).toEqual(["tickets:t1"])
    // A reload started after the decision shows whatever the server says.
    await attentionStore.load(
      makeFakeApi({
        getEnvelope: vi.fn().mockResolvedValue({ data: { items: [row], errors: [] } }),
      }),
    )
    expect(attentionStore.items.map((i) => i.id)).toEqual(["kernel:approval:a1"])
  })

  it("attention-store.failed-fetch-keeps-last-good-items", async () => {
    attentionStore._setForTest({
      items: [{ app: "tickets" } as never],
      errors: [],
    })
    await attentionStore.load(
      makeFakeApi({
        getEnvelope: vi.fn().mockRejectedValue(new Error("500")),
      }),
    )
    expect(attentionStore.items).toHaveLength(1)
    expect(attentionStore.errors[0].app).toBe("_aggregator")
  })

  it("attention-store.start-is-idempotent", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    const api = makeFakeApi({ getEnvelope: fetchMock })
    attentionStore.start(api)
    attentionStore.start(api)
    // One poll interval + 2s debounce for the interval-triggered reload.
    vi.advanceTimersByTime(ATTENTION_POLL_MS + 2_000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)) // two immediate loads + one interval
  })

  it("attention-store.poll-is-a-5-minute-safety-net", async () => {
    // Live invalidation carries the feed; the poll only bounds how stale a
    // clock-driven provider row can get. It used to fire every 60 s per tab.
    expect(ATTENTION_POLL_MS).toBeGreaterThanOrEqual(300_000)
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    attentionStore.start(makeFakeApi({ getEnvelope: fetchMock }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    vi.advanceTimersByTime(62_000)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("attention-store.ws-burst-triggers-one-fetch", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ data: { items: [], errors: [] } })
    const api = makeFakeApi({ getEnvelope: fetchMock })
    attentionStore.start(api)
    // Initial start() triggers the first load synchronously (microtask).
    for (let i = 0; i < 5; i++) attentionStore.markStaleAndReload(api)
    // Debounce widened to 2000ms (L14).
    vi.advanceTimersByTime(2000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})

// Regression (prod 2026-08-05, ticket-10194): the feed reloads on a 60s poll, on
// tab focus and on every WS echo, and `load` replaced `items` wholesale. `<For>`
// keys by object REFERENCE, so every row remounted on each refresh and an
// approval card expanded in place lost both its expansion and the draft being
// typed into it. Reconciling by id keeps untouched rows referentially stable so
// their component state survives.
describe("attention feed row identity across reloads", () => {
  function feed(items: unknown[]) {
    return { data: { items, errors: [] } }
  }
  const rowA = {
    id: "kernel:approval:a1",
    app: "kernel",
    entity: "approval_request",
    entityId: "a1",
    kind: "approval_pending",
    summary: "A",
    urgency: 60,
    occurredAt: "2026-08-05T00:00:00Z",
  }
  const rowB = {
    id: "kernel:approval:b1",
    app: "kernel",
    entity: "approval_request",
    entityId: "b1",
    kind: "approval_pending",
    summary: "B",
    urgency: 60,
    occurredAt: "2026-08-05T00:00:00Z",
  }

  it("keeps the SAME object reference for an unchanged row across a reload", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue(feed([{ ...rowA }, { ...rowB }])),
    } as never
    await attentionStore.load(api)
    const firstA = attentionStore.items[0]
    // A fresh payload with structurally identical rows: a wholesale replace
    // would hand `<For>` new objects and remount everything.
    ;(api as { getEnvelope: ReturnType<typeof vi.fn> }).getEnvelope.mockResolvedValue(
      feed([{ ...rowA }, { ...rowB }]),
    )
    await attentionStore.load(api)
    expect(attentionStore.items[0]).toBe(firstA)
  })

  it("still applies real changes to a row in place", async () => {
    const api = { getEnvelope: vi.fn().mockResolvedValue(feed([{ ...rowA }])) } as never
    await attentionStore.load(api)
    ;(api as { getEnvelope: ReturnType<typeof vi.fn> }).getEnvelope.mockResolvedValue(
      feed([{ ...rowA, summary: "A changed" }]),
    )
    await attentionStore.load(api)
    expect(attentionStore.items[0]?.summary).toBe("A changed")
  })

  it("adds and removes rows correctly", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue(feed([{ ...rowA }, { ...rowB }])),
    } as never
    await attentionStore.load(api)
    expect(attentionStore.items.length).toBe(2)
    ;(api as { getEnvelope: ReturnType<typeof vi.fn> }).getEnvelope.mockResolvedValue(
      feed([{ ...rowB }]),
    )
    await attentionStore.load(api)
    expect(attentionStore.items.map((i) => i.id)).toEqual(["kernel:approval:b1"])
  })
})
