// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers (it replaced "This computer" and "Nodes"). Every
// computer of the viewer's, live, with "This computer", online or last seen,
// sessions running, folders and agents, a blocking problem inline, its switch
// and a way into its page. In the desktop app, while this computer is not set
// up, the setup card comes first: the checks through the shell (Claude
// sign-in, notifications, open at login and keep awake), each with its fix,
// then Turn on, which registers it (POST /api/nodes bound to this install's
// device id, the credential handed to the shell). A browser shows no setup
// card. The node routes are mocked at fetch.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopKeepAwake, DesktopNodeRecord } from "~/lib/desktop-shell-contract"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { NodeSessionTestAccess, nodeCredentialForHello } from "~/modules/nodes/node-session"
import { applyNodeFrame, resetNodesStore } from "~/modules/nodes/nodes-store"
import { resetSessionList } from "~/modules/sessions/session-list"
import { applyRow, resetSessionStore } from "~/modules/sessions/session-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import * as tabStoreModule from "~/modules/shell/tab-store"
import ComputersSettings from "./ComputersSettings"

const SERVER = "https://a.example.com"
/** The global the shell publishes its server on (lib/env.ts). */
const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

interface Shell {
  loggedIn: boolean
  permission: "granted" | "denied" | "default"
  launchAtLogin: boolean
  keepAwake: DesktopKeepAwake
  stored: DesktopNodeRecord | null
  storeCalls: Array<DesktopNodeRecord | null>
}

interface Fake {
  nodes: any[]
  nodesStatus: number
  /** null: GET /nodes/me is not answered (the server cannot be asked). */
  nodesAnswered: boolean
  attachments: unknown[]
  profiles: unknown[]
  denied: Record<string, string[]>
  registerStatus: number
  calls: Array<{ url: string; method: string; body: unknown }>
}

let shell: Shell
let fake: Fake

const NOW = new Date("2026-10-07T12:00:00Z")
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const mac = {
  id: "n-mac",
  name: "Studio Mac",
  enabled: true,
  online: true,
  lastSeenAt: ago(5),
  os: "macos",
  appVersion: "0.1.18",
  deviceId: "d.mac",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: ["app", "notes", "reports"],
}
const laptop = {
  id: "n-laptop",
  name: "Laptop",
  enabled: false,
  online: false,
  lastSeenAt: ago(3 * 3600),
  os: "windows",
  appVersion: "0.1.17",
  deviceId: "d.laptop",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: ["code"],
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      fake.calls.push({ url, method, body })
      const path = new URL(url, "http://x").pathname
      if (path.endsWith("/api/nodes") && method === "POST") {
        if (fake.registerStatus !== 200) return json({ error: { message: "nope" } }, 403)
        const node = { ...mac, id: "n-1", name: "Mac", deviceId: "d.install" }
        fake.nodes = [...fake.nodes, node]
        return json({ data: { node, credential: "lnn_1" } })
      }
      if (path.endsWith("/nodes/me") && method === "GET") {
        if (!fake.nodesAnswered) return json({ data: null }, 404)
        if (fake.nodesStatus !== 200) return json({ error: { message: "boom" } }, fake.nodesStatus)
        return json({ data: { nodes: fake.nodes } })
      }
      if (path.endsWith("/nodes/me/attachments")) return json({ data: fake.attachments })
      if (path.endsWith("/nodes/me/profiles")) return json({ data: fake.profiles })
      if (/\/nodes\/[^/]+\/folders$/.test(path)) {
        const id = path.split("/").at(-2) as string
        return json({
          data: {
            shared: { roots: [], isDefault: false, missing: [] },
            search: {
              roots: ["/Users/me"],
              display: ["~"],
              missing: [],
              denied: fake.denied[id] ?? [],
            },
          },
        })
      }
      if (/\/nodes\/[^/]+$/.test(path) && method === "PATCH") {
        fake.nodes = fake.nodes.map((n) => (path.endsWith(n.id) ? { ...n, ...body } : n))
        return json({ data: { node: fake.nodes.find((n) => path.endsWith(n.id)) ?? {} } })
      }
      if (path.includes("/sessions")) return json({ data: [] })
      return json({ data: null }, 404)
    }),
  )
}

function installShell(): void {
  const handle = installFakeBridge({ claudeAccount: { loggedIn: shell.loggedIn, email: null } })
  Object.assign(handle.bridge, {
    notificationDeviceId: () => "d.install",
    checkClaudeAccount: async () => {
      const account = { loggedIn: shell.loggedIn, email: null }
      handle.push({ claudeAccount: account })
      return account
    },
    notificationPermission: async () => shell.permission,
    requestNotificationPermission: async () => shell.permission,
    launchAtLogin: async () => shell.launchAtLogin,
    setLaunchAtLogin: async (on: boolean) => {
      shell.launchAtLogin = on
      return on
    },
    keepAwake: async () => shell.keepAwake,
    setKeepAwake: async (enabled: boolean) => {
      shell.keepAwake = { ...shell.keepAwake, enabled }
      return shell.keepAwake
    },
    loadNodeCredential: async () => shell.stored,
    storeNodeCredential: async (_server: string, node: DesktopNodeRecord | null) => {
      shell.storeCalls.push(node)
      shell.stored = node
    },
  })
}

function renderPage() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ComputersSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

const card = () => screen.queryByTestId("computer-setup")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  NodeSessionTestAccess.reset()
  shell = {
    loggedIn: true,
    permission: "granted",
    launchAtLogin: true,
    keepAwake: { enabled: true, supported: true, nodeOn: false, power: "ac", held: false },
    stored: null,
    storeCalls: [],
  }
  fake = {
    nodes: [mac, laptop],
    nodesStatus: 200,
    nodesAnswered: true,
    attachments: [
      {
        id: "att-1",
        agentId: "a-1",
        agentName: "Bug Fixer",
        allowedRequesters: [],
        maxJobsPerDay: 10,
        maxTokensPerDay: 2_000_000,
      },
    ],
    profiles: [],
    denied: {},
    registerStatus: 200,
    calls: [],
  }
  installFetch()
})

afterEach(() => {
  cleanup()
  uninstallFakeBridge()
  delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  resetNodesStore()
  resetSessionStore()
  resetSessionList()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function sessionRow(id: string, nodeId: string, status: string) {
  return {
    id,
    ownerUserId: "me",
    nodeId,
    jobId: null,
    agentId: "a-1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: id,
    folderName: null,
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status,
    pendingCount: status === "waiting" ? 1 : 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: ago(600),
    startedAt: ago(600),
    endedAt: null,
    updatedAt: ago(60),
  }
}

describe("the list (every client)", () => {
  it("each computer: online or last seen, sessions running, folders, agents; no setup card in a browser", async () => {
    renderPage()
    const rows = await screen.findAllByTestId("computer-row")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("Studio Mac")
    expect(screen.getByTestId("computer-status-n-mac").textContent).toBe("Online")
    expect(screen.getByTestId("computer-sessions-n-mac").textContent).toBe("0 sessions running")
    expect(screen.getByTestId("computer-folders-n-mac").textContent).toBe("3 folders")
    expect(screen.getByTestId("computer-folders-n-laptop").textContent).toBe("1 folder")
    await waitFor(() =>
      expect(screen.getByTestId("computer-agents-n-mac").textContent).toBe("1 agent"),
    )
    expect(screen.getByTestId("computer-status-n-laptop").textContent).toContain("Last seen")
    expect(screen.getByTestId("computer-status-n-laptop").textContent).toContain("3h")
    expect(screen.getByTestId("computer-enabled-n-laptop").getAttribute("aria-checked")).toBe(
      "false",
    )
    expect(screen.queryByTestId("computer-this-n-mac")).toBeNull()
    expect(card()).toBeNull()
    expect(screen.getByTestId("computers-add-hint").textContent).toContain(
      "open Liaison on it and sign in",
    )
    // The page reads "computer", never "node".
    expect(screen.getByTestId("computers-settings").textContent).not.toMatch(/\bnodes?\b/i)
  })

  it("sessions running are live, and open Sessions", async () => {
    const open = vi.spyOn(tabStoreModule, "openTab").mockImplementation(() => {})
    renderPage()
    await screen.findAllByTestId("computer-row")
    applyRow(sessionRow("s1", "n-mac", "running"))
    applyRow(sessionRow("s2", "n-mac", "waiting"))
    await waitFor(() =>
      expect(screen.getByTestId("computer-sessions-n-mac").textContent).toBe(
        "1 session running, 1 waiting on you",
      ),
    )
    fireEvent.click(screen.getByTestId("computer-sessions-n-mac"))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:sessions", routePath: "/sessions" }),
    )
  })

  it("a presence frame updates the row without a reload", async () => {
    renderPage()
    await screen.findAllByTestId("computer-row")
    const reads = fake.calls.filter((c) => c.url.endsWith("/nodes/me")).length
    applyNodeFrame({ ownerUserId: "me", nodeId: "n-mac", change: "presence", online: false })
    await waitFor(() =>
      expect(screen.getByTestId("computer-status-n-mac").getAttribute("data-online")).toBe("false"),
    )
    expect(fake.calls.filter((c) => c.url.endsWith("/nodes/me")).length).toBe(reads)
  })

  it("a place the OS refuses is the row's problem, said inline", async () => {
    fake.denied = { "n-mac": ["~/Documents"] }
    renderPage()
    expect((await screen.findByTestId("computer-problem-n-mac")).textContent).toBe(
      "macOS does not let Liaison read Documents yet",
    )
    // An offline computer is not asked.
    expect(fake.calls.some((c) => c.url.includes("/nodes/n-laptop/folders"))).toBe(false)
  })

  it("another computer's switch turns it off and on (queued work waits)", async () => {
    renderPage()
    await screen.findAllByTestId("computer-row")
    fireEvent.click(screen.getByTestId("computer-enabled-n-mac"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("computer-enabled-n-mac").getAttribute("aria-checked")).toBe(
        "false",
      ),
    )
  })

  it("the row opens the computer's page", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("computer-open-n-mac"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-mac"))
    window.history.pushState({}, "", "/")
  })

  it("says how to add a computer when there is none", async () => {
    fake.nodes = []
    renderPage()
    expect((await screen.findByTestId("computers-empty")).textContent).toContain(
      "open Liaison on it and sign in",
    )
    expect(screen.queryByTestId("computer-row")).toBeNull()
  })

  it("names a failed load instead of an empty page", async () => {
    fake.nodesStatus = 500
    renderPage()
    expect(await screen.findByTestId("computers-error")).toBeTruthy()
    expect(screen.queryByTestId("computers-empty")).toBeNull()
  })
})

describe("this computer, in the desktop app (P4 N-D T4, S19)", () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = SERVER
  })

  it("not set up: the setup card first; Turn on registers it at once when every check passes", async () => {
    installShell()
    renderPage()
    await waitFor(() => expect(card()?.getAttribute("data-phase")).toBe("off"))
    for (const item of ["claude", "notifications", "startup"]) {
      await waitFor(() =>
        expect(screen.getByTestId(`computer-check-${item}`).getAttribute("data-state")).toBe(
          "done",
        ),
      )
    }
    fireEvent.click(screen.getByTestId("computer-turn-on"))
    await waitFor(() => expect(card()).toBeNull())
    const post = fake.calls.find((c) => c.method === "POST")
    expect(post?.url).toBe(`${SERVER}/api/nodes`)
    expect(post?.body).toEqual({ deviceId: "d.install", os: "macos" })
    expect(shell.storeCalls).toEqual([{ nodeId: "n-1", credential: "lnn_1", enabled: true }])
    expect(nodeCredentialForHello()).toBe("lnn_1")
    expect(await screen.findByTestId("computer-this-n-1")).toBeTruthy()
  })

  it("a check still to do: Turn on waits; the fix turns on open at login and keep awake, then it registers", async () => {
    shell.launchAtLogin = false
    shell.keepAwake = { ...shell.keepAwake, enabled: false }
    installShell()
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("computer-check-startup").getAttribute("data-state")).toBe("todo"),
    )
    expect((screen.getByTestId("computer-turn-on") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("computer-fix-startup"))
    await waitFor(() =>
      expect(screen.getByTestId("computer-check-startup").getAttribute("data-state")).toBe("done"),
    )
    expect(shell.launchAtLogin).toBe(true)
    expect(shell.keepAwake.enabled).toBe(true)
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false)
    fireEvent.click(screen.getByTestId("computer-turn-on"))
    await waitFor(() => expect(card()).toBeNull())
  })

  it("a refused registration is named, and nothing is stored", async () => {
    fake.registerStatus = 403
    installShell()
    renderPage()
    await waitFor(() => expect(card()?.getAttribute("data-phase")).toBe("off"))
    await waitFor(() =>
      expect((screen.getByTestId("computer-turn-on") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("computer-turn-on"))
    expect(await screen.findByTestId("computer-setup-error")).toBeTruthy()
    expect(shell.storeCalls).toEqual([])
  })

  it("set up: no card; its row says This computer, and its switch turns it off keeping the credential", async () => {
    fake.nodes = [{ ...mac, id: "n-1", name: "Mac" }, laptop]
    shell.stored = { nodeId: "n-1", credential: "lnn_1", enabled: true }
    installShell()
    renderPage()
    expect(await screen.findByTestId("computer-this-n-1")).toBeTruthy()
    expect(card()).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("computer-enabled-n-1").getAttribute("aria-checked")).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("computer-enabled-n-1"))
    await waitFor(() =>
      expect(shell.stored).toEqual({ nodeId: "n-1", credential: "lnn_1", enabled: false }),
    )
    expect(fake.calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false })
    // Turned off, it is still listed: its switch, not the setup card.
    expect(card()).toBeNull()
  })

  it("removed elsewhere (walk N13): the credential is dropped and the setup card shows", async () => {
    shell.stored = { nodeId: "n-1", credential: "lnn_1", enabled: true }
    installShell()
    renderPage()
    await waitFor(() => expect(card()?.getAttribute("data-phase")).toBe("off"))
    expect(shell.storeCalls).toEqual([null])
  })

  it("kept when the server cannot be asked", async () => {
    fake.nodesAnswered = false
    shell.stored = { nodeId: "n-1", credential: "lnn_1", enabled: true }
    installShell()
    renderPage()
    await waitFor(() => expect(fake.calls.some((c) => c.url.endsWith("/nodes/me"))).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(shell.storeCalls).toEqual([])
  })
})
