// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T10 (S8 list, S10, charter), S9: the Sessions list groups Needs you /
// Running / Done / Failed or stopped with tabular counts, says in one line why
// a waiting row waits (a needs_you row: the session's own words),
// moves rows live, loads Older on first open, shows a failed group's error
// with Retry (never the empty state), the setup state with no node, and the
// node line flips offline on a presence frame.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { applyNodeFrame, loadNodes, resetNodesStore } from "~/modules/nodes/nodes-store"
import { openTab } from "~/modules/shell/tab-store"
import { resetImportSupport, setImportSupported } from "./import-support"
import SessionList from "./SessionList"
import type { NodeSessionGroup, NodeSessionRow } from "./session-api"
import { resetSessionList, setSessionListApi } from "./session-list"
import { applyRow, resetSessionStore } from "./session-store"

const tabs = vi.hoisted(() => ({
  tabStore: { tabs: [] as { id: string; type: string; entityId: string }[], activeTabId: "" },
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn(), tabStore: tabs.tabStore }))

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    endedAt: null,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  }
}

const NODE = {
  id: "n1",
  name: "Mac mini",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: "0.1.20",
  deviceId: "d1",
  queue: { queued: 0, running: 0 },
}

function sessionsApi(
  pages: Partial<Record<NodeSessionGroup, NodeSessionRow[]>>,
  fail: string[] = [],
) {
  const get = vi.fn(async (path: string) => {
    const group = new URL(path, "http://x").searchParams.get("group") ?? ""
    if (fail.includes(group)) throw new Error("boom")
    return { sessions: pages[group as NodeSessionGroup] ?? [], nextCursor: null }
  })
  return { get, client: { get } as unknown as Pick<ApiClient, "get"> }
}

async function withNodes(list: unknown[]) {
  await loadNodes({ get: vi.fn(async () => ({ nodes: list })) } as never)
}

afterEach(() => {
  resetSessionList()
  resetSessionStore()
  resetNodesStore()
  vi.mocked(openTab).mockClear()
  tabs.tabStore.tabs = []
  tabs.tabStore.activeTabId = ""
  resetImportSupport()
})

describe("SessionList", () => {
  it("the open session's row is highlighted when the shell renders the list with no props (m5)", async () => {
    await withNodes([NODE])
    const api = sessionsApi({ running: [row({ id: "s1" }), row({ id: "s2", title: "Other" })] })
    setSessionListApi(() => api.client)
    tabs.tabStore.tabs = [{ id: "kernel:session:s2", type: "kernel:session", entityId: "s2" }]
    tabs.tabStore.activeTabId = "kernel:session:s2"
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(2))
    const current = screen
      .getAllByTestId("session-row")
      .filter((r) => r.getAttribute("aria-current") === "true")
      .map((r) => r.dataset.id)
    expect(current).toEqual(["s2"])
  })

  it("groups render with counts and a waiting row says why", async () => {
    await withNodes([NODE])
    const api = sessionsApi({
      needs_you: [
        row({ id: "w", status: "waiting", waitingReason: "permission: Bash", title: "Push it" }),
      ],
      running: [row({ id: "r1" }), row({ id: "r2", title: "Second" })],
      done: [row({ id: "d", status: "done", endedAt: new Date().toISOString(), title: "Ended" })],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(4))
    const counts = Object.fromEntries(
      screen.getAllByTestId("session-group").map((g) => [g.dataset.group, g.dataset.count]),
    )
    expect(counts).toMatchObject({ needs_you: "1", running: "2", done: "1" })
    const waiting = screen.getAllByTestId("session-row").find((r) => r.dataset.id === "w")
    expect(waiting?.textContent).toContain("Waiting on you: permission for Bash")
    expect(waiting?.dataset.waiting).toBe("true")
    fireEvent.click(waiting as HTMLElement)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:session", entityId: "w" }),
    )
  })

  it("a live frame moves a row from Running to Waiting on you without a reload", async () => {
    await withNodes([NODE])
    const api = sessionsApi({ running: [row({ id: "s1" })] })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(1))
    const calls = api.get.mock.calls.length
    applyRow(row({ id: "s1", status: "waiting", waitingReason: "question: Rule" }))
    await waitFor(() => {
      const g = screen.getAllByTestId("session-group").find((x) => x.dataset.group === "needs_you")
      expect(g?.dataset.count).toBe("1")
    })
    expect(api.get.mock.calls.length).toBe(calls)
  })

  it("S9: groups render in order Needs you, Running, Done, Failed or stopped", async () => {
    await withNodes([NODE])
    const ended = new Date(Date.now() - 3_600_000).toISOString()
    const api = sessionsApi({
      needs_you: [
        row({
          id: "n",
          status: "waiting",
          state: "needs_you",
          endedAt: ended,
          resultSummary: "Which <b>branch</b> should I push to?",
        }),
      ],
      running: [row({ id: "r" })],
      done: [row({ id: "d", status: "done", state: "done", endedAt: ended })],
      failed: [row({ id: "f", status: "stopped", state: "stopped", endedAt: ended })],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(4))
    const groups = screen.getAllByTestId("session-group")
    expect(groups.map((g) => g.dataset.group)).toEqual(["needs_you", "running", "done", "failed"])
    expect(groups.map((g) => g.querySelector("h3")?.textContent?.replace(/\d+$/, ""))).toEqual([
      "Needs you",
      "Running",
      "Done",
      "Failed or stopped",
    ])
    // The needs_you row says why in the session's own words, one line, as plain text.
    const needs = screen.getAllByTestId("session-row").find((r) => r.dataset.id === "n")
    const reason = needs?.querySelector("[data-testid='session-says']")
    expect(reason?.textContent).toBe("The session says: Which <b>branch</b> should I push to?")
    expect(reason?.querySelector("b")).toBeNull()
    expect(needs?.dataset.waiting).toBe("true")
  })

  it("S51: a needs_you row with a reason code says it in the reader's language, never the node's English summary", async () => {
    await withNodes([NODE])
    const ended = new Date(Date.now() - 3_600_000).toISOString()
    const summary = "VS Code is driving this session. Send again to resume it here as well."
    const api = sessionsApi({
      needs_you: [
        row({
          id: "v",
          status: "waiting",
          state: "needs_you",
          endedAt: ended,
          resultSummary: summary,
          reasonCode: "driven_elsewhere_vscode",
        }),
        row({
          id: "t",
          status: "waiting",
          state: "needs_you",
          endedAt: ended,
          resultSummary: "Half way.\n\nStopped: this session reached its hard limit of 10 tokens.",
          reasonCode: "token_limit",
        }),
      ],
    })
    setSessionListApi(() => api.client)
    render(() => (
      <I18nProvider initialLocale="fr">
        <SessionList />
      </I18nProvider>
    ))
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(2))
    const line = (id: string) =>
      screen
        .getAllByTestId("session-row")
        .find((r) => r.dataset.id === id)
        ?.querySelector("[data-testid='session-reason']")?.textContent
    expect(line("v")).toBe(
      "VS Code pilote cette session. Envoyez de nouveau pour la reprendre aussi ici.",
    )
    expect(line("t")).toBe("Arrêtée à sa limite de jetons.")
    expect(screen.queryByTestId("session-says")).toBeNull()
  })

  it("S32/S57: the new reason codes render their labels; an unknown code shows the summary", async () => {
    await withNodes([NODE])
    const ended = new Date(Date.now() - 3_600_000).toISOString()
    const needs = (id: string, reasonCode: string, resultSummary: string) =>
      row({
        id,
        status: "waiting",
        state: "needs_you",
        endedAt: ended,
        resultSummary,
        reasonCode: reasonCode as NodeSessionRow["reasonCode"],
      })
    const api = sessionsApi({
      needs_you: [
        needs("a", "stuck_after_5_continues", "node words a"),
        needs("b", "auto_continue_cap", "node words b"),
        needs("c", "atelier_awaiting", "node words c"),
        needs("d", "pr_missing", "node words d"),
        needs("e", "push_failed", "node words e"),
        needs("z", "a_code_from_the_future", "The push was refused by the remote."),
      ],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(6))
    const rowEl = (id: string) =>
      screen.getAllByTestId("session-row").find((r) => r.dataset.id === id)
    const line = (id: string) =>
      rowEl(id)?.querySelector("[data-testid='session-reason']")?.textContent ?? null
    expect(["a", "b", "c", "d", "e"].map(line)).toEqual([
      "Stuck after 5 tries on its own.",
      "Stopped after 30 continues on its own.",
      "Atelier is waiting for you.",
      "Finished without a pull request.",
      "Could not push the branch.",
    ])
    expect(line("z")).toBeNull()
    expect(rowEl("z")?.querySelector("[data-testid='session-says']")?.textContent).toBe(
      "The session says: The push was refused by the remote.",
    )
  })

  it("final recheck: the computer's own park reason reads as the computer's, never the session's", async () => {
    await withNodes([NODE])
    const ended = new Date(Date.now() - 3_600_000).toISOString()
    const api = sessionsApi({
      needs_you: [
        row({
          id: "w",
          status: "waiting",
          state: "needs_you",
          endedAt: ended,
          reasonCode: "workspace_blocked",
          resultSummary: "Another Liaison session, Fix cart, is using this folder on main.",
        }),
      ],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(1))
    expect(screen.queryByTestId("session-says")).toBeNull()
    expect(screen.getByTestId("session-reason").textContent).toBe(
      "Your computer says: Another Liaison session, Fix cart, is using this folder on main.",
    )
  })

  it("S9: an empty group is hidden whatever its name, and the shown groups keep the S9 order", async () => {
    await withNodes([NODE])
    const ended = new Date(Date.now() - 3_600_000).toISOString()
    const api = sessionsApi({
      failed: [row({ id: "f", status: "failed", state: "failed", endedAt: ended })],
      needs_you: [row({ id: "n", status: "waiting", state: "needs_you", endedAt: ended })],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(2))
    await waitFor(() =>
      expect(screen.getAllByTestId("session-group").map((g) => g.dataset.group)).toEqual([
        "needs_you",
        "failed",
      ]),
    )
    // A row arriving in an empty group shows that group in its place.
    applyRow(row({ id: "r" }))
    await waitFor(() =>
      expect(screen.getAllByTestId("session-group").map((g) => g.dataset.group)).toEqual([
        "needs_you",
        "running",
        "failed",
      ]),
    )
  })

  it("S9: an unknown state renders with the neutral tone in the Running group", async () => {
    await withNodes([NODE])
    const api = sessionsApi({
      running: [row({ id: "x", status: "running", state: "hibernating" })],
    })
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getAllByTestId("session-row")).toHaveLength(1))
    const running = screen
      .getAllByTestId("session-group")
      .find((g) => g.dataset.group === "running")
    const dot = running?.querySelector("[data-testid='session-row'] > span")
    expect(dot?.className).toContain("bg-text-tertiary")
  })

  it("Older loads on first open and stays collapsed", async () => {
    await withNodes([NODE])
    const api = sessionsApi({})
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4))
    expect(api.get.mock.calls.some(([p]) => String(p).includes("group=older"))).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: /Older/ }))
    await waitFor(() =>
      expect(api.get.mock.calls.some(([p]) => String(p).includes("group=older"))).toBe(true),
    )
    await waitFor(() => expect(screen.getByText("No older sessions.")).toBeTruthy())
  })

  it("a failed group load shows the error and Retry, never the empty state", async () => {
    await withNodes([NODE])
    const api = sessionsApi({}, ["needs_you", "running", "done", "failed"])
    setSessionListApi(() => api.client)
    render(() => <SessionList />)
    await waitFor(() =>
      expect(screen.getAllByText("Your sessions could not be loaded.").length).toBeGreaterThan(0),
    )
    expect(screen.queryByText("Nothing running on your computer")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0)
  })

  it("no node: the setup empty state", async () => {
    await withNodes([])
    setSessionListApi(() => sessionsApi({}).client)
    render(() => <SessionList />)
    await waitFor(() => expect(screen.getByText("No computer yet")).toBeTruthy())
  })

  it("with a node and no session: the empty state with New session", async () => {
    await withNodes([NODE])
    setSessionListApi(() => sessionsApi({}).client)
    const onNew = vi.fn()
    render(() => <SessionList onNew={onNew} />)
    await waitFor(() => expect(screen.getByText("Nothing running on your computer")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "New session" }))
    expect(onNew).toHaveBeenCalled()
  })

  it("the node line flips to offline on a presence frame", async () => {
    await withNodes([NODE])
    setSessionListApi(() => sessionsApi({}).client)
    render(() => <SessionList />)
    expect(screen.getByTestId("node-line").textContent).toContain("Mac mini · online")
    applyNodeFrame({ nodeId: "n1", change: "presence", online: false })
    expect(screen.getByTestId("node-line").textContent).toContain("Mac mini · offline")
  })
})

describe("Import from a computer (S8)", () => {
  it("opens the Import sessions tab, never a dialog", async () => {
    await withNodes([NODE])
    setSessionListApi(() => sessionsApi({}).client)
    render(() => <SessionList />)
    fireEvent.click(await screen.findByTestId("import-entry"))
    expect(openTab).toHaveBeenCalledWith({
      type: "kernel:session-import",
      entityId: "session-import",
      label: "Import sessions",
      routePath: "/import-sessions",
    })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("is hidden once the API answered that it has no import route (D42)", async () => {
    await withNodes([NODE])
    setSessionListApi(() => sessionsApi({}).client)
    setImportSupported(false)
    render(() => <SessionList />)
    await screen.findByTestId("session-list")
    expect(screen.queryByTestId("import-entry")).toBeNull()
  })
})
