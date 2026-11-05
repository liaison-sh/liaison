// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A thread created FROM an entity (a task's comments) is read where the entity
// is. Opened directly (an old link, a bookmark), the thread view says whose
// conversation it is and offers the way to the entity; a plain conversation
// shows no such header.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { WsProvider } from "~/modules/shell/WsContext"
import { resetMessageStore } from "~/modules/threads/message-store"
import ThreadView from "~/modules/threads/ThreadView"
import { resetThreadStore } from "~/modules/threads/thread-store"

vi.mock("~/modules/shell/entity-opener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/entity-opener")>()),
  openEntity: vi.fn(async () => {}),
}))

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const TASK = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

function jsonBody(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  }
}

function installFetch(threadId: string, detail: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = String(url)
      const body = new RegExp(`/threads/${threadId}(\\?|$)`).test(u)
        ? { data: { id: threadId, handle: threadId, title: null, participants: [], ...detail } }
        : { data: [] }
      return new Promise((resolve) => setTimeout(() => resolve(jsonBody(body)), 0))
    }),
  )
}

function renderView(threadId: string) {
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <WsProvider send={vi.fn()} status={mockWsStatus}>
            <ApiProvider>
              <ThreadView entityId={threadId} />
            </ApiProvider>
          </WsProvider>
        )}
      />
    </Router>
  ))
}

describe("ThreadView of an entity's thread", () => {
  beforeEach(() => {
    resetThreadStore()
    resetMessageStore()
    vi.mocked(openEntity).mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("names the task and opens it", async () => {
    installFetch("anchored-1", {
      hiddenFromList: true,
      createdFrom: { app: "projects", entityType: "task", entityId: TASK },
      anchor: {
        app: "projects",
        entityType: "task",
        entityId: TASK,
        kindLabel: "Task",
        label: "Fix the login page",
        secondaryLabel: "Website",
      },
    })
    renderView("anchored-1")
    const header = await screen.findByTestId("thread-anchor-header")
    expect(screen.getByTestId("thread-anchor-header.title").textContent).toBe(
      "Task: Fix the login page · Website",
    )
    const open = screen.getByTestId("thread-anchor-header.open")
    expect(open.textContent).toBe("Open task")
    expect(header.contains(open)).toBe(true)
    fireEvent.click(open)
    expect(openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "projects",
      "task",
      TASK,
      "Fix the login page",
    )
  })

  it("a plain conversation has no entity header", async () => {
    installFetch("plain-1", { title: "general" })
    renderView("plain-1")
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByTestId("thread-anchor-header")).toBeNull()
  })
})
