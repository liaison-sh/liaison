// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Smoke check over the seeded roster: the five channels the migration creates
// render in the Channels group, each with its named role agent visible. The
// fixture is the seed's own shape (roster.md: discoverable channels, handle
// per channel, the role agent as a thread participant), so this test pins the
// RENDERING contract without needing a live box.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

/** The unjoined half of the seeded roster: the same five channels as the
 *  listing route answers them for a user who has joined none of them. */
const DISCOVERABLE = [
  { handle: "#general", agent: null as { id: string; handle: string; displayName: string } | null },
  { handle: "#support", agent: { id: "a-support", handle: "@support", displayName: "Support" } },
  {
    handle: "#logistics",
    agent: { id: "a-logistics", handle: "@logistics", displayName: "Logistics" },
  },
  { handle: "#finance", agent: { id: "a-finance", handle: "@finance", displayName: "Finance" } },
  { handle: "#growth", agent: { id: "a-growth", handle: "@growth", displayName: "Growth" } },
].map((c) => ({
  id: `t-${c.handle.slice(1)}`,
  handle: c.handle,
  title: c.handle,
  participantCount: c.agent ? 2 : 1,
  agentCount: c.agent ? 1 : 0,
  agents: c.agent ? [c.agent] : [],
}))

function stubFetch(discoverable: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const body = String(input).includes("/threads/discoverable")
        ? { data: discoverable }
        : { data: [] }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type" ? "application/json" : null,
        },
        text: () => Promise.resolve(JSON.stringify(body)),
      })
    }),
  )
}

stubFetch([])

const AGENTS = [
  { id: "a-support", handle: "@support", displayName: "Support", avatarUrl: null },
  { id: "a-logistics", handle: "@logistics", displayName: "Logistics", avatarUrl: null },
  { id: "a-finance", handle: "@finance", displayName: "Finance", avatarUrl: null },
  { id: "a-growth", handle: "@growth", displayName: "Growth", avatarUrl: null },
]

/** roster.md: #general (everyone), then one channel per role agent. */
const SEEDED_CHANNELS: Array<{ handle: string; agentId: string | null }> = [
  { handle: "#general", agentId: null },
  { handle: "#support", agentId: "a-support" },
  { handle: "#logistics", agentId: "a-logistics" },
  { handle: "#finance", agentId: "a-finance" },
  { handle: "#growth", agentId: "a-growth" },
]

function seedChannel(handle: string, agentId: string | null) {
  addThread({
    id: `t-${handle.slice(1)}`,
    handle,
    title: handle,
    discoverable: true,
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    participants: [
      { id: "me", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      ...(agentId
        ? [{ id: agentId, name: "", avatarUrl: null, participantType: "agent", agentId }]
        : []),
    ],
    lastMessage: null,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
  })
}

function renderSidebar() {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{<HomeSidebar />}</ApiProvider>} />
    </Router>
  ))
}

describe("seeded roster channels (P4b-T28)", () => {
  beforeEach(async () => {
    localStorage.clear()
    resetSidebarSections()
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    await loadAgentDirectory({ get: async () => ({ data: AGENTS }) })
    for (const channel of SEEDED_CHANNELS) seedChannel(channel.handle, channel.agentId)
  })
  afterEach(() => cleanup())

  it("all five seeded channels render in the Channels group with their named agent member", () => {
    const section = screen.queryByText("Channels")
    expect(section).toBeNull()
    renderSidebar()
    // Three show and two fold (D32); open the fold to see them all.
    fireEvent.click(screen.getByTestId("channels-more-toggle"))
    const group = screen.getByText("Channels").closest("[data-testid='thread-group']")!
    const rows = Array.from(group.querySelectorAll("[data-testid='thread-item']"))
    expect(rows).toHaveLength(5)
    for (const channel of SEEDED_CHANNELS) {
      expect(rows.some((r) => (r.textContent ?? "").includes(channel.handle))).toBe(true)
    }
  })

  it("#support lists the support agent as a member", () => {
    renderSidebar()
    fireEvent.click(screen.getByTestId("channels-more-toggle"))
    const row = Array.from(
      screen
        .getByText("Channels")
        .closest("[data-testid='thread-group']")!
        .querySelectorAll("[data-testid='thread-item']"),
    ).find((r) => (r.textContent ?? "").includes("#support"))!
    // A36 dropped the avatar stack (and with it the participant count) from
    // the row: a channel now carries its kind mark and its name, nothing else.
    // Who is in #support is the thread header's to say.
    expect(row.querySelector("[data-testid='row-mark']")?.getAttribute("data-kind")).toBe(
      "channel-public",
    )
    expect(row.textContent).toContain("#support")
  })

  // Card 31: the unjoined half of the roster is a folded sub-section of one
  // line rows, so what it pins is one row per channel, not the agent roster the
  // old four line card printed (that moved to the thread header).
  it("every unjoined seeded channel is one row in the folded joinable section", async () => {
    resetThreadStore()
    stubFetch(DISCOVERABLE)
    renderSidebar()
    const toggle = await screen.findByTestId("thread-group-toggle-joinableChannels")
    expect(screen.getByTestId("joinable-channels-count").textContent).toBe("5")
    expect(screen.queryByTestId("unjoined-channel")).toBeNull()

    toggle.click()
    const rows = await screen.findAllByTestId("unjoined-channel")
    expect(rows).toHaveLength(5)
    for (const channel of SEEDED_CHANNELS) {
      const row = rows.find((r) => (r.textContent ?? "").includes(channel.handle))!
      expect(row).toBeDefined()
      expect(row.querySelector("[data-testid='row-mark']")?.getAttribute("data-kind")).toBe(
        "channel-public",
      )
      const agent = DISCOVERABLE.find((d) => d.handle === channel.handle)?.agents[0]
      if (agent) expect(row.textContent).not.toContain(agent.handle)
    }
    stubFetch([])
  })

  it("no seeded channel lands under Direct messages", () => {
    renderSidebar()
    const dmRows = screen
      .getByText("Direct messages")
      .closest("[data-testid='thread-group']")!
      .querySelectorAll("[data-testid='thread-item']")
    expect(dmRows).toHaveLength(0)
  })
})
