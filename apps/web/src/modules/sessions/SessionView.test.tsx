// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T16 (S8 surface, S6, charter): `/sessions/:id` is the Sessions app's
// session view: loading, error with Retry, populated; a row that says it has
// events while none could be pulled is the error state, never empty; a reload
// renders the same items; `?request=` highlights that card; the composer is
// P3's seam, fed the session.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import type { SessionComposerProps } from "./SessionComposer"
import SessionView, { FILES_REFRESH_MS } from "./SessionView"
import type { NodeSessionRow } from "./session-api"
import { applyRow, resetSessionStore, setSessionStoreApi } from "./session-store"

const composerProps: SessionComposerProps[] = []
vi.mock("./SessionComposer", () => ({
  default: (p: SessionComposerProps) => {
    composerProps.push(p)
    return null
  },
}))

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

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
    title: "Add a line",
    folderName: "sample",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "strict",
    status: "waiting",
    pendingCount: 1,
    waitingReason: "permission: Bash",
    claudeCode: null,
    lastSeq: 3,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: "2026-10-13T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

function ev(seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) {
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000 + 20).toISOString(),
    type,
    payload,
  } as NodeSessionEvent
}

const EVENTS = [
  ev(1, "user_message", { text: "Add a line" }),
  ev(2, "assistant_text", { text: "Sure." }),
  ev(3, "permission_request", {
    requestId: "r1",
    tool: "Bash",
    input: { command: "git push" },
    reason: "",
  }),
]

function api(opts: { row?: NodeSessionRow | null; events?: NodeSessionEvent[]; fail?: boolean }) {
  const get = vi.fn(async (path: string) => {
    if (opts.fail) throw new Error("down")
    if (path.includes("/events")) {
      const after = Number(new URL(path, "http://x").searchParams.get("after"))
      const events = (opts.events ?? []).filter((e) => e.seq > after)
      return { events, lastSeq: events.at(-1)?.seq ?? after }
    }
    if (!opts.row) throw new Error("not found")
    return opts.row
  })
  setSessionStoreApi(() => ({ get }) as never)
  return get
}

afterEach(() => {
  resetSessionStore()
  resetTabStore()
  composerProps.length = 0
})

describe("SessionView", () => {
  it("loading, error with Retry, populated", async () => {
    const get = api({ fail: true })
    render(() => <SessionView entityId="s1" />)
    expect(screen.getByText("Loading the session…")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("session-error")).toBeTruthy())
    get.mockImplementation(async (path: string) =>
      path.includes("/events") ? { events: EVENTS, lastSeq: 3 } : row(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(screen.getByTestId("session-header").textContent).toContain("Add a line")
  })

  it("a row with lastSeq 3 and no events is the error state, not empty", async () => {
    api({ row: row({ lastSeq: 3 }), events: [] })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("session-error")).toBeTruthy())
    expect(screen.queryByTestId("session-empty")).toBeNull()
  })

  it("a row with lastSeq 0 shows nothing yet", async () => {
    api({ row: row({ lastSeq: 0, status: "queued" }), events: [] })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeTruthy())
  })

  it("a reload renders the same items", async () => {
    api({ row: row(), events: EVENTS })
    const first = render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    const before = screen.getAllByTestId("session-event").map((e) => e.dataset.seq)
    first.unmount()
    resetSessionStore()
    api({ row: row(), events: EVENTS })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getAllByTestId("session-event")).toHaveLength(3))
    expect(screen.getAllByTestId("session-event").map((e) => e.dataset.seq)).toEqual(before)
  })

  it("/sessions/:id?request=r keeps the query and highlights r", async () => {
    openTab({
      type: "kernel:session",
      entityId: "s1",
      label: "Add a line",
      routePath: "/sessions/s1?request=r1",
    })
    api({ row: row(), events: EVENTS })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("request-card").dataset.focused).toBe("true"))
  })

  it("the composer receives the session, its pending requests and the node state", async () => {
    api({ row: row(), events: EVENTS })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() =>
      expect(
        (composerProps.at(-1) as SessionComposerProps).pendingRequests.map((r) => r.requestId),
      ).toEqual(["r1"]),
    )
    const last = composerProps.at(-1) as SessionComposerProps
    expect(last.session.id).toBe("s1")
    expect(last.nodeOnline).toBe(true)
    expect(typeof last.confirmLevel).toBe("function")
  })

  // P3-T15 replaced P2's stub at the seam (D55): the real composer renders
  // under the view with the fixed props, so it is no longer empty.
  it("the seam renders P3's composer with P2's fixed props", async () => {
    const real = await vi.importActual<typeof import("./SessionComposer")>("./SessionComposer")
    // Under the shell's ApiProvider, as the composer's writing helpers expect.
    const client: Partial<ApiClient> = {}
    const { container } = render(() => (
      <ApiContext.Provider value={client as ApiClient}>
        <real.default
          session={row()}
          pendingRequests={[]}
          nodeOnline
          confirmLevel={async () => null}
        />
      </ApiContext.Provider>
    ))
    expect(container.querySelector("textarea")).not.toBeNull()
  })
  it("S54: the rail lists the subagent, and its inline reference opens its drawer, fetched with parent=", async () => {
    const events = [
      ev(1, "user_message", { text: "Run the plan" }),
      ev(2, "tool_call", {
        id: "tu_a",
        name: "Agent",
        input: { description: "Write the migration", subagent_type: "general-purpose" },
      }),
      ev(3, "system", {
        subtype: "task_started",
        text: "Write the migration",
        data: {
          taskId: "a",
          toolUseId: "tu_a",
          taskType: "local_agent",
          description: "Write the migration",
        },
      }),
    ]
    const get = api({ row: row({ status: "running", lastSeq: 3, pendingCount: 0 }), events })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getByTestId("subagents-rail")).toBeTruthy())
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(1)
    expect(get.mock.calls.some(([p]) => String(p).includes("parent="))).toBe(false)
    fireEvent.click(screen.getByTestId("subagent-ref"))
    await waitFor(() => expect(screen.getByTestId("subagent-drawer")).toBeTruthy())
    expect(get.mock.calls.map(([p]) => String(p))).toContain(
      "/me/node-sessions/s1/events?after=0&limit=500&parent=tu_a",
    )
  })
  it("S53 (D29): Files changed counts the server's summary, a subagent's edits included, and the drawer asks for the hunks", async () => {
    const files = [
      { path: "a.ts", added: 1, removed: 0, cut: false },
      { path: "b.ts", added: 2, removed: 0, cut: false },
    ]
    const get = api({
      row: row({ status: "running", lastSeq: 3, pendingCount: 0 }),
      events: EVENTS,
    })
    const base = get.getMockImplementation() as (p: string) => Promise<never>
    get.mockImplementation(async (path: string): Promise<never> => {
      if (path.includes("/files-changed?hunks=1")) {
        return {
          files: files.map((f) => ({ ...f, hunks: [[{ type: "add", text: "x" }]] })),
        } as never
      }
      if (path.includes("/files-changed")) return { files } as never
      return base(path)
    })
    render(() => <SessionView entityId="s1" />)
    const chip = await screen.findByRole("button", { name: /Files changed/ })
    await waitFor(() => expect(chip.textContent).toContain("2"))
    expect(get.mock.calls.map(([p]) => String(p))).toContain("/me/node-sessions/s1/files-changed")
    fireEvent.click(chip)
    await waitFor(() =>
      expect(get.mock.calls.map(([p]) => String(p))).toContain(
        "/me/node-sessions/s1/files-changed?hunks=1",
      ),
    )
    await waitFor(() => expect(screen.getAllByTestId("file-row")).toHaveLength(2))
  })
  it("D31d: with the drawer closed, Files changed is read again when a turn settles, never on the timer as events arrive", async () => {
    const get = api({
      row: row({ status: "running", lastSeq: 3, pendingCount: 0 }),
      events: EVENTS,
    })
    const base = get.getMockImplementation() as (p: string) => Promise<never>
    get.mockImplementation(
      async (path: string): Promise<never> =>
        path.includes("/files-changed") ? ({ files: [] } as never) : base(path),
    )
    const reads = () => get.mock.calls.filter(([p]) => String(p).includes("/files-changed"))
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(reads()).toHaveLength(1))
    applyRow(row({ status: "running", lastSeq: 4, pendingCount: 0 }))
    applyRow(row({ status: "running", lastSeq: 5, pendingCount: 0 }))
    await new Promise((r) => setTimeout(r, FILES_REFRESH_MS + 300))
    expect(reads()).toHaveLength(1)
    // The turn ends: one read for the new count.
    applyRow(row({ status: "done", lastSeq: 6, pendingCount: 0 }))
    await waitFor(() => expect(reads()).toHaveLength(2), { timeout: FILES_REFRESH_MS + 1000 })
    expect(String(reads()[1][0])).toBe("/me/node-sessions/s1/files-changed")
  }, 15_000)

  it("batch-4 F7: a failed refresh keeps the server's last figure, never the held events' own", async () => {
    const files = [
      { path: "a.ts", added: 1, removed: 0, cut: false },
      { path: "b.ts", added: 2, removed: 0, cut: false },
      { path: "c.ts", added: 3, removed: 0, cut: false },
    ]
    const get = api({
      row: row({ status: "running", lastSeq: 3, pendingCount: 0 }),
      events: EVENTS,
    })
    const base = get.getMockImplementation() as (p: string) => Promise<never>
    let up = true
    get.mockImplementation(async (path: string): Promise<never> => {
      if (path.includes("/files-changed")) {
        if (!up) throw new Error("down")
        return { files } as never
      }
      return base(path)
    })
    const reads = () => get.mock.calls.filter(([p]) => String(p).includes("/files-changed"))
    render(() => <SessionView entityId="s1" />)
    const chip = await screen.findByRole("button", { name: /Files changed/ })
    await waitFor(() => expect(chip.textContent).toContain("3"))
    up = false
    applyRow(row({ status: "done", lastSeq: 3, pendingCount: 0 }))
    await waitFor(() => expect(reads()).toHaveLength(2), { timeout: FILES_REFRESH_MS + 1000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(chip.textContent).toContain("3")
  }, 15_000)

  it("batch-4 F7: without the server's summary, a call whose input was elided is never read for its change", async () => {
    const edits = [
      ev(1, "user_message", { text: "Edit two files" }),
      ev(2, "tool_call", {
        id: "tu_w",
        name: "Write",
        input: { file_path: "a.ts", content: "" },
        inputElided: { chars: 9_000 },
      }),
      ev(3, "tool_result", { id: "tu_w", output: "ok" }),
      ev(4, "tool_call", {
        id: "tu_e",
        name: "Edit",
        input: { file_path: "b.ts", old_string: "one", new_string: "two" },
      }),
      ev(5, "tool_result", { id: "tu_e", output: "ok" }),
    ]
    api({ row: row({ status: "running", lastSeq: 5, pendingCount: 0 }), events: edits })
    render(() => <SessionView entityId="s1" />)
    const chip = await screen.findByRole("button", { name: /Files changed/ })
    await waitFor(() => expect(screen.getAllByTestId("session-event").length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    expect(chip.textContent?.replace(/\D/g, "")).toBe("1")
  })
})
