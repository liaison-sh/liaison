// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX4: the Slack style sidebar, A35 (what a channel is) and A36 (how a row
// reads). The judged mock is impl/ws06d-sidebar-mock.md; its eight seed
// conversations are the fixture below, so the grouping and the order the mock
// was judged on are the grouping and the order the code produces.
//
// What is NOT provable here: the pixels. jsdom has no layout, so row height,
// glyph size and the contrast of the unread pill against its ground are the
// driven walk's job. What IS provable, and pinned: which group a row lands in,
// what it is named, that no row carries a preview or a time, that the trailing
// slot holds exactly one thing, and that the density constant is the single
// place the row's size comes from.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { SIDEBAR_METRICS, sidebarMetrics } from "~/modules/threads/sidebar-density"
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

const AGENT_ID = "99999999-9999-4999-8999-999999999999"

/** The mock's eight rows, same titles, same unread counts, same pin and mute.
 *  `updatedAt` descends in listing order so the recency sort is not a coin
 *  toss; the pin tier still lifts "Q2 Marketing Plan" to the top of Channels. */
function seedMockWorld() {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 14, 10, 0, n)).toISOString()
  const row = (o: Record<string, unknown>) =>
    addThread({
      handle: `@${String(o.id)}`,
      isPinned: false,
      isPinnedByUser: false,
      isMuted: false,
      discoverable: false,
      unreadCount: 0,
      participants: [],
      lastMessage: null,
      ...o,
    } as never)

  // Channels, most recent first, with the pinned one lifted by its tier.
  row({ id: "c-q2", title: "Q2 Marketing Plan", isPinned: true, updatedAt: at(50) })
  row({ id: "c-standup", title: "Weekly standup notes", unreadCount: 16, updatedAt: at(59) })
  row({ id: "c-release", title: "Release checklist", unreadCount: 11, updatedAt: at(58) })
  row({ id: "c-security", title: "Security audit findings", unreadCount: 4, updatedAt: at(57) })
  row({ id: "c-retro", title: "Sprint retrospective", unreadCount: 16, updatedAt: at(56) })

  // Direct messages. The agent DM (an `agent_chat`, made as a DM) keeps its
  // stored auto-title and is STILL a DM.
  row({
    id: "d-agent",
    type: "agent_chat",
    title: "Local session walk",
    isMuted: true,
    unreadCount: 5,
    updatedAt: at(55),
    participants: [
      {
        id: AGENT_ID,
        name: "Liaison",
        avatarUrl: null,
        participantType: "agent",
        agentId: AGENT_ID,
      },
    ],
  })
  row({
    id: "d-bob",
    title: null,
    unreadCount: 1,
    updatedAt: at(54),
    participants: [{ id: "u-bob", name: "Bob Martinez", avatarUrl: null }],
  })
  row({
    id: "d-alice",
    title: null,
    updatedAt: at(53),
    participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
  })
}

function namesUnder(group: "channels" | "directMessages"): string[] {
  const section = document.querySelector(`[data-testid='thread-group'][data-group='${group}']`)
  if (!section) return []
  return Array.from(section.querySelectorAll("[data-testid='thread-item']")).map((el) =>
    (el.querySelector("span.truncate")?.textContent ?? "").trim(),
  )
}

describe("HomeSidebar - the mock's eight conversations, grouped by A35", () => {
  beforeEach(async () => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: AGENT_ID, handle: "@liaison", displayName: "Liaison", kind: "personal" }],
      }),
    })
  })
  afterEach(() => cleanup())

  // D32: Direct messages before Channels. No Agents group here: the only agent
  // is a personal one that is not the viewer's, so its DM is a direct message.
  it("renders Direct messages then Channels, the channels in the mock's order", () => {
    seedMockWorld()
    renderInShell(() => <HomeSidebar />)

    const groups = Array.from(document.querySelectorAll("[data-testid='thread-group']")).map((el) =>
      el.getAttribute("data-group"),
    )
    expect(groups).toEqual(["directMessages", "channels"])

    expect(namesUnder("channels")).toEqual([
      "Q2 Marketing Plan",
      "Weekly standup notes",
      "Release checklist",
      "Security audit findings",
      "Sprint retrospective",
    ])
    expect(namesUnder("directMessages")).toEqual(["Liaison", "Bob", "Alice"])
  })

  it("the agent DM keeps its stored title yet lists as a DM named by the agent", () => {
    seedMockWorld()
    renderInShell(() => <HomeSidebar />)
    expect(namesUnder("directMessages")).toContain("Liaison")
    expect(namesUnder("channels")).not.toContain("Local session walk")
    expect(screen.queryByText("Local session walk")).not.toBeInTheDocument()
  })

  // A35 amended (2026-10-12): a channel the user made and then seated an
  // agent in is a channel by its title, and the real agent DM stays listed.
  it("a titled channel whose only other seat is an agent lists as a channel, not as the agent's DM", () => {
    seedMockWorld()
    addThread({
      id: "c-walk",
      handle: "@c-walk",
      type: "thread",
      isPinned: false,
      isPinnedByUser: false,
      isMuted: false,
      discoverable: false,
      unreadCount: 0,
      lastMessage: null,
      title: "s11-cloud-walk",
      updatedAt: new Date(Date.UTC(2026, 8, 14, 10, 0, 1)).toISOString(),
      participants: [
        {
          id: AGENT_ID,
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: AGENT_ID,
        },
      ],
    } as never)
    renderInShell(() => <HomeSidebar />)
    fireEvent.click(screen.getByTestId("channels-more-toggle"))
    expect(namesUnder("channels")).toContain("s11-cloud-walk")
    expect(namesUnder("directMessages")).toEqual(["Liaison", "Bob", "Alice"])
  })

  it("a discoverable channel takes the hash mark, a private one the lock", () => {
    addThread({ id: "pub", handle: "@pub", title: "General", discoverable: true } as never)
    addThread({ id: "priv", handle: "@priv", title: "Release checklist" } as never)
    renderInShell(() => <HomeSidebar />)
    const kinds = Array.from(document.querySelectorAll("[data-testid='row-mark']")).map((el) =>
      el.getAttribute("data-kind"),
    )
    expect(kinds).toContain("channel-public")
    expect(kinds).toContain("channel-private")
  })

  it("no row carries a preview line or a relative time", () => {
    seedMockWorld()
    addThread({
      id: "d-preview",
      handle: "@d-preview",
      title: null,
      updatedAt: new Date().toISOString(),
      participants: [{ id: "u-carl", name: "Carl Kim", avatarUrl: null }],
      lastMessage: {
        content: "Solid week",
        authorId: "u-carl",
        authorName: "Carl",
        createdAt: new Date().toISOString(),
      },
    } as never)
    renderInShell(() => <HomeSidebar />)

    for (const row of Array.from(document.querySelectorAll("[data-testid='thread-item']"))) {
      const text = row.textContent ?? ""
      expect(text).not.toContain("Solid week")
      expect(text).not.toContain("Carl:")
      expect(text).not.toMatch(/\b\d+[mhd]\b/)
      expect(text).not.toContain("Yesterday")
      expect(text).not.toContain("No messages yet")
    }
  })
})

describe("HomeSidebar - the unread pair (A36)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
  })
  afterEach(() => cleanup())

  it("an unread row is a bold name plus a count pill with a token foreground", () => {
    addThread({ id: "c1", handle: "@c1", title: "Weekly standup notes", unreadCount: 16 } as never)
    renderInShell(() => <HomeSidebar />)

    const pill = screen.getByLabelText("16 unread")
    expect(pill).toHaveTextContent("16")
    expect(pill.className).toContain("bg-accent")
    // The defect the mock surfaced: `text-white` on `bg-accent` is white on
    // light grey in dark theme. The foreground is a token now, so it can be
    // defined per theme and contrast checked (theme-accent-contrast.test.ts).
    expect(pill.className).toContain("text-accent-foreground")
    expect(pill.className).not.toContain("text-white")

    const name = screen.getByText("Weekly standup notes")
    expect(name.className).toContain("font-semibold")
    expect(name.className).toContain("text-text")
  })

  it("a read row's name is not bold and carries no pill", () => {
    addThread({ id: "c1", handle: "@c1", title: "Quiet channel", unreadCount: 0 } as never)
    renderInShell(() => <HomeSidebar />)
    const name = screen.getByText("Quiet channel")
    expect(name.className).not.toContain("font-semibold")
    expect(document.querySelector("[data-testid='row-trailing']")?.children.length).toBe(0)
  })
})

describe("HomeSidebar - the density constant is the one place the row size lives", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
  })
  afterEach(() => {
    cleanup()
    vi.doUnmock("~/modules/threads/sidebar-density")
    vi.resetModules()
  })

  it("the default row carries the height class of the judged default variant", () => {
    addThread({ id: "c1", handle: "@c1", title: "General", discoverable: true } as never)
    renderInShell(() => <HomeSidebar />)
    const row = screen.getByTestId("thread-item")
    expect(row.className).toContain(sidebarMetrics().row)
    expect(sidebarMetrics().row).toBe(SIDEBAR_METRICS.slack.row)
  })

  // The pixel proof of either variant is the driven walk; what a jsdom test can
  // prove is that flipping the ONE constant flips the row, which is what makes
  // the density choice a one line change.
  it("flipping SIDEBAR_DENSITY to slack-dense renders the dense row height instead", async () => {
    vi.resetModules()
    vi.doMock("~/modules/threads/sidebar-density", async () => {
      const actual = await vi.importActual<typeof import("~/modules/threads/sidebar-density")>(
        "~/modules/threads/sidebar-density",
      )
      return {
        ...actual,
        SIDEBAR_DENSITY: "slack-dense",
        sidebarMetrics: () => actual.SIDEBAR_METRICS["slack-dense"],
      }
    })
    // resetModules gives a whole fresh module graph, so the provider and the
    // stores have to come from THAT graph: the outer ApiProvider's context is
    // a different object and the sidebar would not find it.
    const { default: DenseSidebar } = await import("~/modules/threads/HomeSidebar")
    const { ApiProvider: DenseApiProvider } = await import("~/modules/shell/ApiContext")
    // The router too: ApiContext calls useNavigate, and a fresh graph's
    // useNavigate only sees a Route from that same fresh graph.
    const { Route: DenseRoute, Router: DenseRouter } = await import("@solidjs/router")
    const { addThread: addDense, resetThreadStore: resetDense } = await import(
      "~/modules/threads/thread-store"
    )
    resetDense()
    addDense({ id: "c1", handle: "@c1", title: "General", discoverable: true } as never)
    render(() => (
      <DenseRouter>
        <DenseRoute
          path="/*"
          component={() => (
            <DenseApiProvider>
              <DenseSidebar />
            </DenseApiProvider>
          )}
        />
      </DenseRouter>
    ))
    const row = screen.getByTestId("thread-item")
    expect(row.className).toContain(SIDEBAR_METRICS["slack-dense"].row)
    expect(row.className).not.toContain(`${SIDEBAR_METRICS.slack.row} `)
  })
})

describe("HomeSidebar - collapsible section headers (A36)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    resetSidebarSections()
    localStorage.clear()
  })

  it("the header is the collapse control and folding it hides the rows", () => {
    addThread({ id: "c1", handle: "@c1", title: "General", discoverable: true } as never)
    renderInShell(() => <HomeSidebar />)

    const toggle = screen.getByTestId("thread-group-toggle-channels")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("General")).toBeInTheDocument()

    toggle.click()
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("General")).not.toBeInTheDocument()
    // Remembered for this user rather than forgotten on the next mount.
    expect(localStorage.getItem("liaison:sidebar-sections:anonymous")).toContain("channels")
  })
})
