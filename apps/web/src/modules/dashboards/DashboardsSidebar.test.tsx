// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  userFromToken: () => ({ userId: "me", name: "Tester", scopes: [] }),
}))

import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { DashboardsSidebar } from "./DashboardsSidebar"
import { resetDashboardsStore } from "./dashboards-store"

const ROWS = [
  {
    id: "o1",
    title: "Weekly sales",
    visibility: "org",
    ownerUserId: "x",
    ownerName: "Claire Martin",
  },
  { id: "o2", title: "Ad spend", visibility: "org", ownerUserId: "y", ownerName: null },
  { id: "s1", title: "Support load", visibility: "org", ownerUserId: "me", ownerName: "Tester" },
  { id: "p1", title: "My pipeline", visibility: "personal", ownerUserId: "me" },
]

function mount(rows: unknown[] = ROWS) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/dashboards") return rows
      throw new Error(`unexpected ${path}`)
    }),
  } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <DashboardsSidebar />
    </ApiContext.Provider>
  ))
}

const rowIds = (section: "yours" | "team") => {
  const all = screen.getAllByTestId(/^dashboards-sidebar-row-[a-z0-9]+$/)
  const header = screen.getByTestId(`dashboards-sidebar-${section}`)
  const next = section === "yours" ? screen.queryByTestId("dashboards-sidebar-team") : null
  return all
    .filter(
      (r) =>
        header.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING &&
        (!next || next.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING),
    )
    .map((r) => r.dataset.testid)
}

beforeEach(() => {
  resetDashboardsStore()
  resetTabStore()
})
afterEach(cleanup)

describe("DashboardsSidebar", () => {
  it("lists the viewer's own dashboards, then the ones others share, each by title", async () => {
    mount()
    await screen.findByTestId("dashboards-sidebar-row-o1")
    expect(rowIds("yours")).toEqual(["dashboards-sidebar-row-p1", "dashboards-sidebar-row-s1"])
    expect(rowIds("team")).toEqual(["dashboards-sidebar-row-o2", "dashboards-sidebar-row-o1"])
    expect(screen.getByTestId("dashboards-sidebar-yours").textContent).toContain("2")
    // The viewer's shared one is marked; someone else's carries its owner's first name.
    expect(screen.getByTestId("dashboards-sidebar-row-s1-shared")).toBeTruthy()
    expect(screen.queryByTestId("dashboards-sidebar-row-p1-shared")).toBeNull()
    expect(screen.getByTestId("dashboards-sidebar-row-o1-owner").textContent).toBe("Claire")
    expect(screen.queryByTestId("dashboards-sidebar-row-o2-owner")).toBeNull()
    expect(screen.getByTestId("dashboards-sidebar-all").textContent).toContain("4")
    expect(screen.getByTestId("dashboards-sidebar-hint").textContent).toContain("Your agent")
  })

  it("opens a dashboard and lights its row; All dashboards opens the page", async () => {
    mount()
    fireEvent.click(await screen.findByTestId("dashboards-sidebar-row-o1"))
    const active = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    expect(active?.type).toBe("kernel:dashboard")
    expect(active?.entityId).toBe("o1")
    expect(screen.getByTestId("dashboards-sidebar-row-o1").getAttribute("aria-current")).toBe(
      "page",
    )
    expect(screen.getByTestId("dashboards-sidebar-row-p1").getAttribute("aria-current")).toBeNull()

    fireEvent.click(screen.getByTestId("dashboards-sidebar-all"))
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type).toBe("kernel:dashboards")
    expect(screen.getByTestId("dashboards-sidebar-all").getAttribute("aria-current")).toBe("page")
    expect(screen.getByTestId("dashboards-sidebar-row-o1").getAttribute("aria-current")).toBeNull()
  })

  it("filters by title, and says so when nothing matches", async () => {
    mount()
    await screen.findByTestId("dashboards-sidebar-row-o1")
    const filter = screen.getByTestId("dashboards-sidebar-filter")
    fireEvent.input(filter, { target: { value: "SALES" } })
    expect(
      screen.getAllByTestId(/^dashboards-sidebar-row-[a-z0-9]+$/).map((r) => r.dataset.testid),
    ).toEqual(["dashboards-sidebar-row-o1"])
    expect(screen.queryByTestId("dashboards-sidebar-yours")).toBeNull()
    fireEvent.input(filter, { target: { value: "nothing like it" } })
    expect(screen.getByTestId("dashboards-sidebar-no-match").textContent).toContain(
      "nothing like it",
    )
  })
})
