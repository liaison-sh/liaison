// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetPanelStore } from "~/modules/shell/panel-store"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import KnowledgeHome from "./KnowledgeHome"
import { resetKnowledgeStore } from "./knowledge-store"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  userFromToken: () => ({ userId: "u1", name: "Test" }),
}))

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  openConversation: vi.fn(),
  collapse: vi.fn(),
  dockAvailable: true,
  dockTabs: [] as { threadId: string; expanded: boolean }[],
  dockActiveThreadId: null as string | null,
}))

vi.mock("~/modules/threads/message-store", () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
}))

vi.mock("~/modules/shell/dock-store", () => ({
  openConversation: (...args: unknown[]) => mocks.openConversation(...args),
  collapse: (...args: unknown[]) => mocks.collapse(...args),
  dockAvailable: () => mocks.dockAvailable,
  tabs: () => mocks.dockTabs,
  activeThreadId: () => mocks.dockActiveThreadId,
}))

const PERSONAL_AGENT_ID = "a-mine"

afterEach(() => {
  resetKnowledgeStore()
  resetPanelStore()
  resetPersonalDmStore()
  resetAgentDirectory()
  mocks.sendMessage.mockClear()
  mocks.openConversation.mockClear()
  mocks.collapse.mockClear()
  mocks.dockAvailable = true
  mocks.dockTabs = []
  mocks.dockActiveThreadId = null
  try {
    resetTabStore()
  } catch {
    /* test isolation */
  }
})

function renderWith(homeData?: any) {
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path === "/knowledge/home") {
        return homeData ?? { personal: [], recent: [], needsReview: [], sourceHealth: [] }
      }
      if (path === "/agents") {
        return {
          data: [
            {
              id: PERSONAL_AGENT_ID,
              handle: "@mine",
              displayName: "Liaison",
              kind: "personal",
              ownerUserId: "u1",
            },
          ],
        }
      }
      return []
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/threads/dm") return { data: { id: "thread-dm-1" } }
      return {}
    }),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeHome />
    </ApiContext.Provider>
  ))
  return api
}

describe("KnowledgeHome — calm IA", () => {
  it("renders recently-touched feed and primary CTA; no stat-card grid or Connect-Drive button", () => {
    renderWith()
    expect(screen.getByTestId("knowledge-home")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-home-recently-touched")).toBeInTheDocument()
    expect(screen.getByTestId("knowledge-home-create-from-cta")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-home-sections")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-stat-count")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-connect-drive")).not.toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-create-personal-note")).not.toBeInTheDocument()
  })

  it("Needs-review filter is hidden when count = 0", async () => {
    const { loadKnowledgeHome } = await import("./knowledge-store")
    await loadKnowledgeHome({
      get: vi.fn(async () => ({
        personal: [],
        recent: [],
        needsReview: [],
        sourceHealth: [],
      })),
    } as any)
    renderWith()
    expect(screen.queryByTestId("knowledge-home-needs-review-filter")).not.toBeInTheDocument()
  })

  it("Needs-review filter renders with count when > 0 and toggles the feed", async () => {
    const { loadKnowledgeHome } = await import("./knowledge-store")
    const recent = [{ id: "r1", title: "Recent doc", reviewStatus: "unverified" }]
    const needsReview = [
      { id: "r2", title: "Stale doc", reviewStatus: "stale" },
      { id: "r3", title: "Needs review", reviewStatus: "needs_review" },
    ]
    await loadKnowledgeHome({
      get: vi.fn(async () => ({
        personal: [],
        recent,
        needsReview,
        sourceHealth: [],
      })),
    } as any)
    renderWith()
    const filter = screen.getByTestId("knowledge-home-needs-review-filter")
    expect(filter).toHaveTextContent("2")
    // aria-pressed is the source of truth for the toggle state; a no-op
    // `setFiltered(true)` regression would still show the right rows but
    // would fail to flip aria-pressed back to false on a second click.
    expect(filter).toHaveAttribute("aria-pressed", "false")
    // Unfiltered: shows recent (r1)
    expect(screen.getByTestId("knowledge-recent-r1")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-recent-r2")).not.toBeInTheDocument()
    fireEvent.click(filter)
    expect(filter).toHaveAttribute("aria-pressed", "true")
    // Filtered: shows the needs-review subset
    expect(screen.getByTestId("knowledge-recent-r2")).toBeInTheDocument()
    expect(screen.queryByTestId("knowledge-recent-r1")).not.toBeInTheDocument()
    // Second click toggles back off.
    fireEvent.click(filter)
    expect(filter).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("knowledge-recent-r1")).toBeInTheDocument()
  })

  it("recently-touched renders the clean displayTitle, never the raw import filename", async () => {
    const { loadKnowledgeHome } = await import("./knowledge-store")
    await loadKnowledgeHome({
      get: vi.fn(async () => ({
        personal: [],
        // The API returns both the raw title (filename) and a clean displayTitle.
        recent: [{ id: "d1", title: "11-presets.md", displayTitle: "11 presets" }],
        needsReview: [],
        sourceHealth: [],
      })),
    } as any)
    renderWith()
    const row = screen.getByTestId("knowledge-recent-d1")
    expect(row).toHaveTextContent("11 presets")
    expect(row).not.toHaveTextContent("11-presets.md")
  })

  it("the create knowledge CTA opens the personal agent DM and posts the injected discuss message", async () => {
    // Off a Home surface: viewing a mail conversation tab, not kernel:home.
    resetTabStore()
    openTab({ type: "mail:conversation", entityId: "conv-1", label: "Order 1234" })
    renderWith()
    fireEvent.click(screen.getByTestId("knowledge-home-create-from-cta"))
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))

    expect(mocks.openConversation).toHaveBeenCalledWith("thread-dm-1")
    expect(mocks.sendMessage.mock.calls[0]![1]).toBe("thread-dm-1")
    expect(mocks.sendMessage.mock.calls[0]![2]).toBe(
      "I want to discuss Create knowledge from…: /knowledge",
    )
  })

  it("on Home the CTA opens the thread tab instead", async () => {
    // resetTabStore's default state is the kernel:home Home tab, active.
    resetTabStore()
    renderWith()
    fireEvent.click(screen.getByTestId("knowledge-home-create-from-cta"))
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))

    expect(tabStore.tabs.some((t) => t.type === "thread" && t.entityId === "thread-dm-1")).toBe(
      true,
    )
    expect(mocks.openConversation).not.toHaveBeenCalled()
  })
})
