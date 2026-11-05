// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-A T4b. The viewer's own agent is a PERSON in Chats, not a button parked
// somewhere else on the screen: it leads Direct messages on the phone Chats
// root (and sits in Unread while its DM has something to read). Where there is
// no personal agent there is no row, rather than an empty affordance that
// leads nowhere.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { DESKTOP_QUERY, PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

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

const b64 = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** A token the client can decode; nothing here verifies a signature. */
function signInAs(userId: string) {
  const payload = {
    userId,
    orgId: "org-1",
    name: "Me",
    roles: [],
    scopes: [],
    dimensionGrants: {},
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  setTokens(`${b64({ alg: "none" })}.${b64(payload)}.x`)
}

function setPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

const PERSONAL_AGENT = {
  id: "ag-mine",
  handle: "@liaison",
  displayName: "Liaison",
  kind: "personal",
  ownerUserId: "me",
  state: "Watching the inbox",
}

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function seedThreads() {
  addThread({
    id: "t-ops",
    handle: "@ops",
    title: "Ops",
    isPinned: true,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    unreadCount: 0,
    updatedAt: iso(10),
  })
}

const renderChats = (onSelect = vi.fn()) => ({
  onSelect,
  ...render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <HomeSidebar variant="dock" onSelect={onSelect} />
          </ApiProvider>
        )}
      />
    </Router>
  )),
})

describe("HomeSidebar — the personal agent row at the head of Chats", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    resetPersonalDmStore()
    setPhone()
    signInAs("me")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === DESKTOP_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    syncShellTier()
  })

  it("in the desktop dock, carries the dock mark a guided step rings it by", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === DESKTOP_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    syncShellTier()
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    seedThreads()
    renderChats()
    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    // Not the Chats screen's own list beside the channel: the dock's row.
    expect(row.dataset.inDock).toBe("true")
  })

  it("is the FIRST row of Agents, marked yours, while a pinned channel stays in Channels", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    seedThreads()
    renderChats()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    expect(row.textContent).toContain("Liaison")
    // The state line the directory carries.
    expect(row.textContent).toContain("Watching the inbox")
    expect(row.querySelector("[data-agent-glyph]")).not.toBeNull()

    expect(row.querySelector('[data-testid="chats-personal-agent-yours"]')?.textContent).toBe(
      "· yours",
    )
    const agents = document.querySelector('[data-section="agents"]') as HTMLElement
    const rows = [...agents.querySelectorAll('[role="listitem"]')]
    expect(rows[0].contains(row)).toBe(true)
    const channels = document.querySelector('[data-section="channels"]') as HTMLElement
    expect(channels.querySelector('[data-testid="chat-row-title"]')?.textContent).toBe("Ops")
  })

  it("renders no row when the viewer has no personal agent", async () => {
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: "ag-role", handle: "@finance", displayName: "Finance", kind: "role" }],
      }),
    })
    seedThreads()
    renderChats()

    await waitFor(() => expect(screen.getByTestId("chat-row-title")).toBeInTheDocument())
    expect(screen.queryByTestId("chats-personal-agent-row")).toBeNull()
  })

  it("opens the existing DM with the personal agent, and lists it only once", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    seedThreads()
    addThread({
      id: "t-my-dm",
      handle: "@dm-mine",
      title: null,
      participants: [
        {
          id: "ag-mine",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-mine",
        },
      ],
      unreadCount: 2,
      updatedAt: iso(1),
    })
    const { onSelect } = renderChats()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    // The pinned row carries the DM's unread count, and the DM is NOT repeated
    // further down the column.
    expect(row.querySelector('[data-testid="chat-row-unread"]')?.textContent).toBe("2")
    expect(document.querySelectorAll('[data-thread-id="t-my-dm"]').length).toBe(0)

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith("t-my-dm")
  })
})
