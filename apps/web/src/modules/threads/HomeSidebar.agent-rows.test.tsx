// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX6, A37: a role agent the member has no DM with is ONE dimmed line.
//
// The real render of the A36 sidebar (impl/ws06d-sidebar-real.md, capture
// `ws06d-sidebar-real-slack-light.png`) listed four role agents under Direct
// messages as a name over an @handle with a "Message" button, about 48 px
// each: two line blocks in a list whose whole premise is one line per row, and
// the one thing on the screen that did not read as a directory. A37 makes the
// offer a row: the agent mark in the same mark box, the name, nothing else,
// the row's own density height, dimmed because there is no conversation yet.
// Pressing it runs the SAME `startDm` the "Message" button ran, so the entry
// point is unchanged and only its shape moved; once the DM exists the agent is
// a real DM row and the offer is gone.
//
// D32: those rows live in the Agents group now, which leads the list, with
// the role agents' DMs beside them; Direct messages holds the people.
//
// jsdom lays nothing out, so "one line of the density's height" is asserted as
// the height class coming from the density table (the same proxy the FX4 tests
// use) plus a single name line and no second text node. The pixels are the
// driven walk's job.

import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { createMentionDelegate } from "~/modules/shell/markdown-content"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { sidebarMetrics } from "~/modules/threads/sidebar-density"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import ThreadHeader from "~/modules/threads/ThreadHeader"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const ROLE_AGENTS = [
  { id: "ag-finance", handle: "@finance", displayName: "Finance", kind: "role" },
  { id: "ag-growth", handle: "@growth", displayName: "Growth", kind: "role" },
  { id: "ag-logistics", handle: "@logistics", displayName: "Logistics", kind: "role" },
  { id: "ag-support", handle: "@support", displayName: "Support", kind: "role" },
]

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const body =
    init?.method === "POST" && String(url).includes("/threads/dm")
      ? { data: { id: "dm-created", handle: "@dm-created" } }
      : { data: [] }
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => JSON.stringify(body),
  }
})
vi.stubGlobal("fetch", fetchMock)

function renderInShell(ui: () => any) {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{ui()}</ApiProvider>} />
    </Router>
  ))
}

/** Every agent-page tab the store holds, as (entityId, label) pairs. */
function openedAgentTabs(): Array<{ entityId: string; label: string }> {
  return tabStore.tabs
    .filter((t: any) => t.type === "agents:agent")
    .map((t: any) => ({ entityId: t.entityId, label: t.label }))
}

function agentRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='agent-dm-row']"))
}

describe("HomeSidebar - a role agent without a DM is one dimmed row (A37)", () => {
  beforeEach(async () => {
    fetchMock.mockClear()
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    resetAgentDirectory()
    await loadAgentDirectory({ get: async () => ({ data: ROLE_AGENTS }) })
  })
  afterEach(() => cleanup())

  it("the four seeded role agents render four single line rows with no button and no handle", async () => {
    addThread({
      id: "d-alice",
      handle: "@d-alice",
      title: null,
      participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
    } as never)
    renderInShell(() => <HomeSidebar />)

    await waitFor(() => expect(agentRows().length).toBe(4))

    const agents = document.querySelector("[data-testid='thread-group'][data-group='agents']")!
    expect(agents.querySelectorAll("[data-testid='agent-dm-row']").length).toBe(4)

    for (const row of agentRows()) {
      // One line, at the density's row height, same as every other row.
      expect(row.className).toContain(sidebarMetrics().row)
      // The name, and nothing else: no @handle text, no "Message" label.
      const text = (row.textContent ?? "").trim()
      expect(["Finance", "Growth", "Logistics", "Support"]).toContain(text)
      expect(text).not.toContain("@")
      expect(text).not.toContain("Message")
      // A guided step rings the agent by name, DM started or not.
      const frame = row.closest("[data-testid='chats-agent-row']")!
      expect(frame.getAttribute("data-agent-name")).toBe(text)
      // The agent mark sits in the shared 24 px mark box.
      const mark = row.querySelector("[data-testid='row-mark']")!
      expect(mark.getAttribute("data-kind")).toBe("dm-agent-unstarted")
      expect(mark.querySelector("[data-agent-glyph]")).not.toBeNull()
      // Dimmed: quieter than a real DM row, which is text-secondary.
      const name = row.querySelector("span.truncate")!
      expect(name.className).toContain("text-text-tertiary")
      // The row IS the control: no nested button to press instead.
      expect(row.querySelector("button")).toBeNull()
    }
    // The two line invite block is gone from the sidebar entirely.
    expect(document.querySelector("[data-testid='agent-dm-invite']")).toBeNull()
    expect(screen.queryByText("@finance")).not.toBeInTheDocument()
  })

  it("Agents leads the list, then Direct messages with the people, then Channels (D32)", async () => {
    addThread({
      id: "d-alice",
      handle: "@d-alice",
      title: null,
      participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
    } as never)
    addThread({
      id: "c-ops",
      handle: "@ops",
      title: "Ops",
      discoverable: true,
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
    } as never)
    renderInShell(() => <HomeSidebar />)
    await waitFor(() => expect(agentRows().length).toBe(4))

    const groups = Array.from(document.querySelectorAll("[data-testid='thread-group']")).map((el) =>
      el.getAttribute("data-group"),
    )
    expect(groups.slice(0, 3)).toEqual(["agents", "directMessages", "channels"])
    const dms = document.querySelector("[data-testid='thread-group'][data-group='directMessages']")!
    const rows = Array.from(
      dms.querySelectorAll("[data-testid='thread-item'], [data-testid='agent-dm-row']"),
    ).map((el) => el.getAttribute("data-thread-id") ?? el.getAttribute("data-testid"))
    expect(rows).toEqual(["d-alice"])
    expect(
      document.querySelector("[data-group='agents'] [data-testid='thread-group-add-agents']"),
    ).not.toBeNull()
  })

  it("clicking the row runs the same Message agent path the button ran", async () => {
    renderInShell(() => <HomeSidebar />)
    await waitFor(() => expect(agentRows().length).toBe(4))

    const support = agentRows().find((r) => (r.textContent ?? "").trim() === "Support")!
    support.click()

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([url, init]: any) => init?.method === "POST" && String(url).includes("/threads/dm"),
      )
      expect(posted).toBeDefined()
      expect(JSON.parse((posted as any)[1].body)).toEqual({ agentId: "ag-support" })
    })
  })

  // P4c-T39: EVERY surface that names an agent opens the SAME page, addressed
  // the way people address an agent — by handle. Three of them live in three
  // different modules, which is exactly why they drifted apart before: the
  // sidebar row and the thread header each opened a `profile` tab keyed by the
  // agent's UUID, and the mention chip opened nothing at all.
  it("the sidebar agent row, the thread header row and a mention chip all open /agents/:handle", async () => {
    const seat = {
      id: "seat-support",
      name: "Support",
      avatarUrl: null,
      participantType: "agent",
      agentId: "ag-support",
    }

    // 1. The sidebar row's profile control.
    addThread({
      id: "d-support",
      handle: "@d-support",
      title: null,
      participants: [seat],
    } as never)
    renderInShell(() => <HomeSidebar />)
    // The row settles under Agents once the directory names Support a role agent.
    const control = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-group='agents'] [data-testid='agent-profile-open-ag-support']",
      )
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    control.click()
    expect(openedAgentTabs()).toEqual([{ entityId: "@support", label: "Support" }])
    cleanup()
    resetTabStore()

    // 2. The thread header's participant row.
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <ThreadHeader
                threadId="d-support"
                title={null}
                handle="@d-support"
                participants={[{ id: "me", name: "Me", avatarUrl: null }, seat] as never}
                isPinned={false}
                isPinnedByUser={false}
                isMuted={false}
                isArchived={false}
                discoverable={false}
                topic={null}
                description={null}
                currentUserId="me"
                onTogglePin={() => {}}
                onTogglePinForAll={() => {}}
                onToggleMute={() => {}}
                onToggleDiscoverable={() => {}}
                onSaveDetails={() => {}}
                onArchive={() => {}}
                onLeave={() => {}}
                onAddParticipant={() => {}}
                onRemoveParticipant={() => {}}
              />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    screen.getByLabelText("Thread actions").click()
    screen.getByTestId("thread-header-agent-profile-ag-support").click()
    expect(openedAgentTabs()).toEqual([{ entityId: "@support", label: "Support" }])
    cleanup()
    resetTabStore()

    // 3. The rendered `@agent` mention chip, through the same click delegate
    //    the message list installs on its markdown.
    const chip = document.createElement("span")
    chip.setAttribute("data-mention-ref", "agent:ag-support")
    chip.textContent = "@Support"
    document.body.appendChild(chip)
    createMentionDelegate({} as never)({
      target: chip,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as never)
    chip.remove()
    expect(openedAgentTabs()).toEqual([{ entityId: "@support", label: "Support" }])
  })

  it("an agent that already has a DM renders once, as the DM row", async () => {
    addThread({
      id: "d-support",
      handle: "@d-support",
      title: null,
      participants: [
        {
          id: "ag-support",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-support",
        },
      ],
    } as never)
    renderInShell(() => <HomeSidebar />)
    await waitFor(() => expect(agentRows().length).toBe(3))

    const named = Array.from(
      document.querySelectorAll("[data-testid='thread-item'], [data-testid='agent-dm-row']"),
    ).filter((el) => (el.textContent ?? "").trim() === "Support")
    expect(named.length).toBe(1)
    expect(named[0].getAttribute("data-testid")).toBe("thread-item")
    // A role agent's DM is an Agents row, not a Direct message.
    expect(named[0].closest("[data-testid='thread-group']")?.getAttribute("data-group")).toBe(
      "agents",
    )
  })
})
