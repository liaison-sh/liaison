// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX4: the row has ONE trailing slot.
//
// The row this replaces drew the agent profile control in an `absolute right-2
// top-1.5` overlay while the relative timestamp sat at that same right edge in
// normal flow. On a DM row the two landed on top of each other: the 6b walk
// capture 06 shows a "3" printed over the little person glyph. The fix is
// structural, not a nudge: everything trailing is in flow, the slot renders
// exactly one thing in a fixed order (unread count, else pin, else mute bell,
// else nothing), the participant count is gone from the list entirely, and the
// agent profile control is a sibling of the row rather than a layer on it.
//
// jsdom lays nothing out, so "do not overlap" is asserted structurally: one
// child in the slot, the control outside the row button, the name truncating
// rather than pushing the slot out. The rendered proof is the driven walk.

import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

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

function renderInShell(ui: () => any) {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{ui()}</ApiProvider>} />
    </Router>
  ))
}

describe("HomeSidebar - one trailing slot, never two things at the right edge", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
  })
  afterEach(() => cleanup())

  // The row this replaces drew the agent profile control in an `absolute
  // right-2` overlay on top of the in-flow relative timestamp, so a DM row
  // showed a person glyph and a time in the same place (6b walk capture 06).
  it("a row that is unread AND pinned AND muted with three people shows exactly one trailing element", () => {
    addThread({
      id: "d-loud",
      handle: "@d-loud",
      title: null,
      isPinned: true,
      isMuted: true,
      unreadCount: 7,
      participants: [
        { id: "u1", name: "Alice Chen", avatarUrl: null },
        { id: "u2", name: "Bob Martinez", avatarUrl: null },
        { id: "u3", name: "Carl Kim", avatarUrl: null },
      ],
    } as never)
    renderInShell(() => <HomeSidebar />)

    const trailing = document.querySelector("[data-testid='row-trailing']")!
    expect(trailing.children.length).toBe(1)
    expect(trailing.firstElementChild?.getAttribute("aria-label")).toBe("7 unread")
    // No second right edge element anywhere in the row.
    expect(screen.queryByLabelText("Pinned")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Muted")).not.toBeInTheDocument()
  })

  it("the trailing slot falls back to the pin, then to the mute bell", () => {
    addThread({ id: "a", handle: "@a", title: "Pinned only", isPinned: true } as never)
    addThread({ id: "b", handle: "@b", title: "Muted only", isMuted: true } as never)
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument()
    expect(screen.getByLabelText("Muted")).toBeInTheDocument()
    for (const slot of Array.from(document.querySelectorAll("[data-testid='row-trailing']"))) {
      expect(slot.children.length).toBeLessThanOrEqual(1)
    }
  })

  it("the name truncates before the trailing slot rather than pushing it out", () => {
    addThread({
      id: "long",
      handle: "@long",
      title: "A channel with a name long enough to need the ellipsis every time",
      unreadCount: 3,
    } as never)
    renderInShell(() => <HomeSidebar />)
    const name = screen.getByText(
      "A channel with a name long enough to need the ellipsis every time",
    )
    expect(name.className).toContain("truncate")
    expect(name.className).toContain("min-w-0")
    const trailing = document.querySelector("[data-testid='row-trailing']")!
    expect(trailing.className).toContain("shrink-0")
  })

  it("the agent profile control is a flow sibling of the row, never an overlay on it", () => {
    addThread({
      id: "d-agent",
      handle: "@d-agent",
      title: null,
      participants: [
        {
          id: "a-1",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a-1",
        },
      ],
    } as never)
    renderInShell(() => <HomeSidebar />)
    const control = screen.getByTestId("agent-profile-open-a-1")
    expect(control.className).not.toContain("absolute")
    expect(control.closest("[data-testid='thread-item']")).toBeNull()
  })
})

// P6d-FX6: the trailing slot's RIGHT EDGE is shared by every row.
//
// The real render measured it (impl/ws06d-sidebar-real.md): the agent profile
// control was rendered, at opacity-0, only on rows naming exactly one agent,
// so the row button on those five rows stopped 24 px early and its trailing
// slot ended at x=271 while every other row's ended at x=295. No artifact in
// that seed, because all five happened to be read; a single-agent channel that
// goes unread would sit its pill 24 px left of the column. The box is reserved
// on EVERY row now and the control lives inside it.
//
// jsdom has no layout, so the invariant is asserted structurally: every row
// reserves one gutter, of the same width class, and the gutter is a sibling of
// the row button on all of them. The pixel proof is the driven walk.
describe("HomeSidebar - every row reserves the same trailing gutter", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
  })
  afterEach(() => cleanup())

  /** An unread channel with ONE agent seat, an unread channel with people
   *  only, a read agent DM and a read people DM: the mixed fixture the edge
   *  has to hold across. */
  function seedMixed() {
    addThread({
      id: "c-agent",
      handle: "@c-agent",
      title: "Growth",
      discoverable: true,
      unreadCount: 9,
      participants: [
        {
          id: "ag-1",
          name: "Growth",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-1",
        },
      ],
    } as never)
    addThread({
      id: "c-people",
      handle: "@c-people",
      title: "Weekly standup notes",
      unreadCount: 4,
      participants: [
        { id: "u-a", name: "Alice Chen", avatarUrl: null },
        { id: "u-b", name: "Bob Martinez", avatarUrl: null },
      ],
    } as never)
    addThread({
      id: "d-agent",
      handle: "@d-agent",
      title: null,
      participants: [
        {
          id: "ag-2",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-2",
        },
      ],
    } as never)
    addThread({
      id: "d-person",
      handle: "@d-person",
      title: null,
      participants: [{ id: "u-c", name: "Carl Kim", avatarUrl: null }],
    } as never)
  }

  it("an unread single agent channel puts its pill in the same column as a people channel", () => {
    seedMixed()
    renderInShell(() => <HomeSidebar />)

    const rows = Array.from(document.querySelectorAll("[data-testid='thread-item']"))
    expect(rows.length).toBe(4)
    const widths = new Set<string>()
    for (const row of rows) {
      const outer = row.parentElement!
      const gutters = outer.querySelectorAll("[data-testid='row-agent-gutter']")
      // Exactly one reserved box per row, agent seat or no agent seat.
      expect(gutters.length).toBe(1)
      // The gutter is outside the row button, so the button's right edge (and
      // with it the trailing slot's) is the same on every row.
      expect(gutters[0].closest("[data-testid='thread-item']")).toBeNull()
      expect(outer.lastElementChild).toBe(gutters[0])
      widths.add(gutters[0].className)
    }
    expect(widths.size).toBe(1)

    // And the pills really are on the two unread rows, one each.
    expect(screen.getByLabelText("9 unread")).toBeInTheDocument()
    expect(screen.getByLabelText("4 unread")).toBeInTheDocument()
  })

  it("the agent profile control lives inside the reserved box rather than shortening the row", () => {
    seedMixed()
    renderInShell(() => <HomeSidebar />)

    const control = screen.getByTestId("agent-profile-open-ag-1")
    expect(control.closest("[data-testid='row-agent-gutter']")).not.toBeNull()
    // A row with no agent seat reserves the box and leaves it empty.
    const people = screen.getByText("Weekly standup notes").closest("[data-testid='thread-item']")
    const emptyGutter = people?.parentElement?.querySelector("[data-testid='row-agent-gutter']")
    expect(emptyGutter).not.toBeNull()
    expect(emptyGutter?.children.length).toBe(0)
  })
})
