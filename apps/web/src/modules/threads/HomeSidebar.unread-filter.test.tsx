// SPDX-License-Identifier: FSL-1.1-ALv2
// LIF-26: the Unread chip shows what there is to read, and only that: a read
// conversation and a muted one (which never surfaces unread state) stay out.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { needsReading } from "~/modules/threads/thread-list-model"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import HomeSidebar from "./HomeSidebar"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

describe("needsReading", () => {
  it("is an unread count on a conversation that is not muted", () => {
    expect(needsReading({ unreadCount: 2, isMuted: false })).toBe(true)
    expect(needsReading({ unreadCount: 0, isMuted: false })).toBe(false)
    expect(needsReading({ unreadCount: 3, isMuted: true })).toBe(false)
  })
})

describe("Messages sidebar: the Unread chip", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
  })
  afterEach(() => cleanup())

  it("leaves read and muted conversations out", async () => {
    for (const [id, title, unreadCount, isMuted] of [
      ["thread-a", "Unread room", 2, false],
      ["thread-b", "Read room", 0, false],
      ["thread-c", "Muted room", 4, true],
    ] as const) {
      addThread({
        id,
        handle: `#${id}`,
        title,
        type: "channel",
        isPinned: false,
        isMuted,
        participants: [],
        updatedAt: new Date().toISOString(),
        unreadCount,
      })
    }
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <HomeSidebar />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    expect(await screen.findByText("Read room")).toBeTruthy()
    const tab = screen.getAllByRole("tab").find((el) => el.textContent === "Unread")
    expect(tab).toBeTruthy()
    fireEvent.click(tab as HTMLElement)
    expect(screen.getByText("Unread room")).toBeTruthy()
    expect(screen.queryByText("Read room")).toBeNull()
    expect(screen.queryByText("Muted room")).toBeNull()
  })
})
