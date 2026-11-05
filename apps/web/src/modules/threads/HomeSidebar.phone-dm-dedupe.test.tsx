// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone Chats ROOT listed the personal agent DM twice: once as the pinned
// first row and again in the body, because the column only skipped the exact
// thread id the pinned row resolved to. A DM is identified by its counterpart,
// so a twin room with the same agent slipped straight past that check. The
// root now runs the SAME decision the desktop sidebar takes (dm-dedupe.ts):
// one row per counterpart, the most recently active one, across every tier.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

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

const PERSONAL_AGENT = {
  id: "ag-mine",
  handle: "@liaison",
  displayName: "Liaison",
  kind: "personal",
  ownerUserId: "me",
}

const SUPPORT_AGENT = {
  id: "ag-support",
  handle: "@support",
  displayName: "Support Desk",
  kind: "role",
}

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function seedDm(id: string, agentId: string, name: string, minutesAgo: number) {
  addThread({
    id,
    handle: `@${id}`,
    title: null,
    type: "agent_chat",
    unreadCount: 0,
    updatedAt: iso(minutesAgo),
    participants: [
      { id: "me", name: "Me", avatarUrl: null, participantType: "user" },
      { id: `seat-${id}`, name, avatarUrl: null, participantType: "agent", agentId },
    ],
  })
}

const renderChats = () =>
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <HomeSidebar variant="dock" onSelect={vi.fn()} />
          </ApiProvider>
        )}
      />
    </Router>
  ))

const titles = () =>
  screen.queryAllByTestId("chat-row-title").map((el) => el.textContent?.trim() ?? "")

describe("HomeSidebar phone Chats root: one row per DM counterpart", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    resetPersonalDmStore()
    setShellTier("phone")
    signInAs("me")
  })
  afterEach(() => {
    cleanup()
    clearAuth()
    setShellTier("desktop")
    vi.unstubAllGlobals()
  })

  it("lists the personal agent once when a twin DM sits in the body", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    // The pinned row resolves to the first match; the twin is a second room
    // with the same counterpart and must not be offered as a separate chat.
    seedDm("dm-mine-a", "ag-mine", "Liaison", 60)
    seedDm("dm-mine-b", "ag-mine", "Liaison", 5)
    renderChats()

    await waitFor(() => expect(screen.getByTestId("chats-personal-agent-row")).toBeInTheDocument())
    expect(titles().filter((t) => t === "Liaison")).toHaveLength(1)
    expect(document.querySelectorAll('[data-testid="chat-row"]').length).toBe(0)
  })

  it("lists a role agent once when the box holds two DMs with it", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [SUPPORT_AGENT] }) })
    seedDm("dm-support-a", "ag-support", "Support Desk", 600)
    seedDm("dm-support-b", "ag-support", "Support Desk", 5)
    renderChats()

    await waitFor(() => expect(screen.queryAllByTestId("chat-row").length).toBeGreaterThan(0))
    expect(titles().filter((t) => t === "Support Desk")).toHaveLength(1)
    // The survivor is the room the viewer last used.
    expect(document.querySelector('[data-testid="chat-row"]')?.getAttribute("data-thread-id")).toBe(
      "dm-support-b",
    )
  })
})
