// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Direct messages listed two "Support Desk" rows and two "Liaison" rows on the
// demo box, identical in every way a reader can see. The list is the last line
// of defence: whatever mints a stray twin, only one row per counterpart is
// offered.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u1", name: "Owner" }) }
})

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => JSON.stringify({ data: [] }),
  })),
)

function seedDm(id: string, agentId: string, name: string, updatedAt: string) {
  addThread({
    id,
    handle: `@${id}`,
    title: null,
    type: "agent_chat",
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    updatedAt,
    participants: [
      { id: "u1", name: "Owner", avatarUrl: null, participantType: "user" },
      { id: `seat-${id}`, name, avatarUrl: null, participantType: "agent", agentId },
    ],
  })
}

describe("HomeSidebar - one Direct messages row per counterpart", () => {
  beforeEach(async () => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: "ag-support", handle: "@support", displayName: "Support Desk", kind: "role" }],
      }),
    })
  })
  afterEach(() => cleanup())

  it("shows the most recent of two DMs with the same agent, not both", async () => {
    seedDm("dm-seeded", "ag-support", "Support Desk", "2026-09-10T10:00:00.000Z")
    seedDm("dm-product", "ag-support", "Support Desk", "2026-09-16T10:00:00.000Z")

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

    await waitFor(() => expect(screen.getAllByText("Support Desk").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Support Desk")).toHaveLength(1)
  })
})
