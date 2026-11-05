// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ThreadView's data effect tracks the very store cells a load writes, so a
// FAILED load used to re-arm it: the list stayed empty, `loading[id]` fell
// back to false, and the next reactive pass asked again, immediately and
// forever. On production that turned one 429 into 245 GET /threads and 227 GET
// /threads/:id/messages in three minutes. A failure must be remembered, and
// only an explicit retry may ask again.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { WsProvider } from "~/modules/shell/WsContext"
import { resetMessageStore } from "~/modules/threads/message-store"
import ThreadView from "~/modules/threads/ThreadView"
import { addThread, removeThread, resetThreadStore } from "~/modules/threads/thread-store"

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")
const mockWsSend = vi.fn()

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const THREAD_ID = "rl-thread-1"

function jsonBody(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

/**
 * Every call is answered on a macrotask, so a runaway refetch loop yields to
 * the timers this test waits on instead of starving them: the unfixed code
 * FAILS this test, it does not hang it.
 */
function installFetch(failing: RegExp) {
  const urls: string[] = []
  const spy = vi.fn((url: string) => {
    urls.push(String(url))
    const body = failing.test(String(url))
      ? jsonBody(500, { error: { message: "Server error" } })
      : jsonBody(200, { data: [] })
    return new Promise((resolve) => setTimeout(() => resolve(body), 0))
  })
  vi.stubGlobal("fetch", spy)
  return {
    urls,
    count: (fragment: string) => urls.filter((u) => u.includes(fragment)).length,
  }
}

function renderView() {
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <WsProvider send={mockWsSend} status={mockWsStatus}>
            <ApiProvider>
              <ThreadView entityId={THREAD_ID} />
            </ApiProvider>
          </WsProvider>
        )}
      />
    </Router>
  ))
}

/** Re-run the data effect the way the running app does: the thread list moves. */
function pokeThreadList() {
  addThread({
    id: "rl-other-thread",
    handle: "other",
    title: "Other",
    isPinned: false,
    participants: [],
  })
  removeThread("rl-other-thread")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

describe("ThreadView after a failed load", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("asks for a thread's messages exactly once when the read fails", async () => {
    const net = installFetch(/\/threads\/rl-thread-1\/messages/)
    renderView()

    await waitFor(() => expect(net.count(`/threads/${THREAD_ID}/messages`)).toBe(1))
    pokeThreadList()
    pokeThreadList()
    await settle()

    expect(net.count(`/threads/${THREAD_ID}/messages`)).toBe(1)
  })

  it("asks for the thread list exactly once when the list read fails", async () => {
    const net = installFetch(/\/threads\?limit=50/)
    renderView()

    await waitFor(() => expect(net.count("/threads?limit=50")).toBe(1))
    pokeThreadList()
    pokeThreadList()
    await settle()

    expect(net.count("/threads?limit=50")).toBe(1)
  })
})
