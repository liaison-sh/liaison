// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An empty column that is really a failed read. The sidebar asked for the list
// once, at mount, so a refusal (a 429, a blip) left it empty and silent for the
// rest of the session unless a WebSocket event happened to wake it, with no
// line saying what happened and nothing to press. It now says so, offers the
// retry, and re-arms itself once the remembered failure lapses.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, removeThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const THREAD_ROW = {
  id: "t-live",
  handle: "@thread-live",
  title: "Engineering",
  isPinned: false,
  isMuted: false,
  participants: [{ id: "me", name: "Me", avatarUrl: null }],
  lastMessage: null,
  unreadCount: 0,
  updatedAt: "2026-09-22T10:00:00.000Z",
}

function jsonBody(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "retry-after" && status === 429
            ? "5"
            : null,
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

/** The list read fails `failures` times, then answers with `rows`. */
function installFetch(failures: number, rows: unknown[] = [THREAD_ROW]) {
  let listCalls = 0
  const spy = vi.fn((url: string) => {
    if (String(url).includes("/threads?limit=50")) {
      listCalls += 1
      return Promise.resolve(
        listCalls <= failures
          ? jsonBody(429, { error: { message: "Too many requests" } })
          : jsonBody(200, { data: rows }),
      )
    }
    return Promise.resolve(jsonBody(200, { data: [] }))
  })
  vi.stubGlobal("fetch", spy)
  return { listCalls: () => listCalls }
}

/** Write to the thread store the way the running app does. Every successful
 *  load writes fresh arrays too, which is the whole point of the test below. */
function pokeStore() {
  addThread({
    id: "t-poke",
    handle: "poke",
    title: "Poke",
    isPinned: false,
    participants: [],
  })
  removeThread("t-poke")
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

function renderSidebar() {
  render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{<HomeSidebar />}</ApiProvider>} />
    </Router>
  ))
}

describe("HomeSidebar when the thread list cannot be read", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    resetAgentDirectory()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("says the list failed instead of showing an empty workspace", async () => {
    installFetch(1)
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("threads-load-failed")).toBeInTheDocument())
    expect(screen.queryByText("No threads yet. Start a conversation!")).not.toBeInTheDocument()
  })

  it("reloads the list from the retry control", async () => {
    const net = installFetch(1)
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("threads-load-retry")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("threads-load-retry"))
    // The press is visible while its own request is on the wire.
    expect(screen.getByTestId("threads-load-retry")).toBeDisabled()
    await waitFor(() => expect(net.listCalls()).toBe(2))
    await waitFor(() => expect(screen.getByText("Engineering")).toBeInTheDocument())
    expect(net.listCalls()).toBe(2)
    expect(screen.queryByTestId("threads-load-failed")).not.toBeInTheDocument()
  })

  // A workspace whose list is legitimately empty is the case an "ask while the
  // list is empty" rule can never get right: the answer arrives, the list is
  // still empty, and the rule asks again, one request per round trip, forever.
  it("asks once for a list that comes back empty, however much the store moves", async () => {
    const net = installFetch(0, [])
    renderSidebar()

    await waitFor(() => expect(net.listCalls()).toBe(1))
    // Let the empty answer land: it is the successful load's own write into the
    // store that used to re-arm the ask.
    await settle()
    pokeStore()
    pokeStore()
    pokeStore()
    await settle()

    expect(net.listCalls()).toBe(1)
    expect(screen.queryByTestId("threads-load-failed")).not.toBeInTheDocument()
  })

  it("asks exactly once more when the cool-down expires, and then shows the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const net = installFetch(1)
    renderSidebar()

    await vi.waitFor(() => expect(net.listCalls()).toBe(1))
    // Inside the window nothing is asked again: that is what kept one refusal
    // from becoming hundreds.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(net.listCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(screen.getByText("Engineering")).toBeInTheDocument())
    expect(net.listCalls()).toBe(2)
  })
})
