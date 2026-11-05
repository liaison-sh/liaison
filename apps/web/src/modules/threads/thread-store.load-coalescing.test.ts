// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who shares a list load and who does not. Two surfaces noticing at the same
// moment that they have nothing to show want the same answer and may share one
// request. A reload raised BY AN EVENT cannot: the WS self heal asks because it
// was just told about a thread the store has never seen, and a response that
// left the server before that thread existed does not contain it, so answering
// the reload with it loses the row until the next event.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import { requestResync } from "~/framework/resync"
import {
  allThreads,
  loadThreads,
  resetThreadStore,
  setThreadReloadHandler,
  subscribeThreadResync,
  threadsLoadFailed,
} from "~/modules/threads/thread-store"

function row(id: string) {
  return {
    id,
    handle: id,
    title: id,
    isPinned: false,
    participants: [],
    unreadCount: 0,
    updatedAt: "2026-09-22T10:00:00.000Z",
  }
}

interface PendingRequest {
  resolve: (rows: unknown[]) => void
  reject: (error: unknown) => void
}

/** An api whose requests are answered, or refused, one at a time, in any order. */
function deferredApi() {
  const pending: Array<PendingRequest | null> = []
  const api = {
    get: vi.fn(
      (_path: string, init?: { userInitiated?: boolean }) =>
        new Promise<any>((resolve, reject) => {
          void init
          pending.push({ resolve: (rows) => resolve({ data: rows }), reject })
        }),
    ),
  }
  async function settle(index: number, act: (request: PendingRequest) => void) {
    const request = pending[index]
    if (!request) throw new Error(`no request #${index} waiting for an answer`)
    pending[index] = null
    act(request)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    api,
    calls: () => api.get.mock.calls.length,
    init: (index: number) => api.get.mock.calls[index]?.[1],
    answerAt: (index: number, rows: unknown[]) => settle(index, (r) => r.resolve(rows)),
    rejectAt: (index: number, error: unknown) => settle(index, (r) => r.reject(error)),
    async answer(rows: unknown[]) {
      const index = pending.findIndex(Boolean)
      if (index === -1) throw new Error("no request waiting for an answer")
      await settle(index, (r) => r.resolve(rows))
    },
  }
}

describe("loadThreads while a load is in flight", () => {
  beforeEach(() => {
    resetThreadStore()
  })

  it("chains one more request for an event driven reload, and its rows win", async () => {
    const net = deferredApi()
    const first = loadThreads(net.api)
    const reload = loadThreads(net.api, { fresh: true })
    expect(net.calls()).toBe(1)

    // The answer already on the wire was composed before the new thread existed.
    await net.answer([row("t-old")])
    await first
    expect(net.calls()).toBe(2)

    await net.answer([row("t-old"), row("t-new")])
    await reload
    expect(net.calls()).toBe(2)
    expect(
      allThreads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["t-new", "t-old"])
  })

  it("shares the one request between surfaces that are merely asking", async () => {
    const net = deferredApi()
    const a = loadThreads(net.api)
    const b = loadThreads(net.api)
    expect(net.calls()).toBe(1)

    await net.answer([row("t-old")])
    await Promise.all([a, b])
    expect(net.calls()).toBe(1)
  })

  it("lets a later reload start a fresh request once the first has settled", async () => {
    const net = deferredApi()
    const first = loadThreads(net.api)
    await net.answer([row("t-old")])
    await first

    const second = loadThreads(net.api, { fresh: true })
    await net.answer([row("t-new")])
    await second
    expect(net.calls()).toBe(2)
    expect(allThreads().map((t) => t.id)).toEqual(["t-new"])
  })

  it("carries a person's Try again into a run already queued behind a self heal", async () => {
    const net = deferredApi()
    const first = loadThreads(net.api)
    const heal = loadThreads(net.api, { fresh: true })
    const press = loadThreads(net.api, { fresh: true, userInitiated: true })

    await net.answer([row("t-old")])
    await first
    await net.answer([row("t-old")])
    await Promise.all([heal, press])

    expect(net.calls()).toBe(2)
    // Without it the queued run leaves as an ordinary read and the client rate
    // limit cool-down, which the press exists to get past, refuses it.
    expect(net.init(1)).toEqual({ userInitiated: true })
  })

  it("lets only the newest run write the store", async () => {
    const net = deferredApi()
    const stale = loadThreads(net.api)
    // A session teardown between the two (logout, then straight back in) is the
    // plainest way two runs overlap; the microtask between a run clearing
    // itself and a queued run starting is the other.
    resetThreadStore()
    const current = loadThreads(net.api)
    expect(net.calls()).toBe(2)

    await net.answerAt(1, [row("t-new")])
    await current
    await net.answerAt(0, [row("t-old")])
    await stale

    expect(allThreads().map((t) => t.id)).toEqual(["t-new"])
  })
  // Signing out with a run queued behind another one: the promise the queued
  // run was scheduled on cannot be cancelled, so it fires after teardown. It
  // must not leave: the request goes out with the old session's credentials,
  // and its 401 would leave the FRESH session remembering a failure it never
  // had, with a retry timer ticking under it.
  it("drops a run queued in a session that has since been torn down", async () => {
    vi.useFakeTimers()
    const net = deferredApi()
    const first = loadThreads(net.api)
    const queued = loadThreads(net.api, { fresh: true, userInitiated: true })
    expect(net.calls()).toBe(1)

    resetThreadStore()
    // `queued` is never awaited: a run that wrongly starts here would sit on an
    // unanswered request, and waiting on it would turn a fast failure into a
    // timeout. Its only job is to produce no request at all.
    void queued.catch(() => {})
    // The dead session's request comes back refused, exactly as it does when
    // the token died with the session.
    await net.rejectAt(0, Object.assign(new Error("Unauthorized"), { status: 401 }))
    await first
    await vi.advanceTimersByTimeAsync(10_000)

    expect(net.calls()).toBe(1)
    // Neither the refusal nor anything queued behind it may leave the fresh
    // session remembering a failure, or a retry ticking under it.
    expect(threadsLoadFailed()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // Teardown runs before Solid unmounts the sidebar, so for that window the
  // store still holds a reload handler closed over the ended session's client.
  it("forgets the sidebar's reload handler at teardown", () => {
    subscribeThreadResync()
    const net = deferredApi()
    setThreadReloadHandler(() => {
      void loadThreads(net.api, { fresh: true })
    })

    resetThreadStore()
    requestResync("test-teardown")

    expect(net.calls()).toBe(0)
  })
})

describe("the backoff after a refused list read", () => {
  beforeEach(() => {
    resetThreadStore()
    vi.useFakeTimers()
  })

  it("never asks faster than the backoff, whatever Retry-After says", async () => {
    const api = {
      get: vi.fn(() =>
        Promise.reject(Object.assign(new Error("Too many requests"), { retryAfter: 1 })),
      ),
    }
    await loadThreads(api)
    expect(threadsLoadFailed()).toBe(true)

    // Retry-After said one second. Honouring that literally is one list read a
    // second for as long as the limiter stays angry.
    await vi.advanceTimersByTimeAsync(1_500)
    expect(threadsLoadFailed()).toBe(true)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(threadsLoadFailed()).toBe(false)
    vi.useRealTimers()
  })
})
