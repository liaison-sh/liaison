// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S53, S54 (owner D20, D21): the Subagents panel. Every subagent is one row
// from the main thread's task events; nothing of a subagent's own is fetched
// or held until its drawer opens, and closing the drawer releases it. The
// rail collapses to a strip that keeps the counts, remembered per device.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SubagentsPanel, { RAIL_COLLAPSED_KEY } from "./SubagentsPanel"
import type { NodeSessionRow } from "./session-api"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { applyRow, resetSessionStore, sessionStore, setSessionStoreApi } from "./session-store"

const T0 = Date.parse("2026-10-15T12:00:00.000Z")
let seq = 0
function ev(
  atMs: number,
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  parentToolUseId?: string,
): NodeSessionEvent {
  seq++
  return {
    seq,
    at: new Date(atMs).toISOString(),
    receivedAt: new Date(atMs).toISOString(),
    type,
    payload,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  } as NodeSessionEvent
}
const task = (atMs: number, subtype: string, data: Record<string, unknown>) =>
  ev(atMs, "system", { subtype, text: String(data.description ?? ""), data })
const started = (atMs: number, id: string, description: string) =>
  task(atMs, "task_started", {
    taskId: id,
    toolUseId: `tu_${id}`,
    taskType: "local_agent",
    subagentType: "general-purpose",
    description,
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
    title: "Run the pipeline",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "standard",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 40,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-15T12:00:00.000Z",
    startedAt: "2026-10-15T12:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-15T12:00:00.000Z",
    ...over,
  }
}

function fakeApi(subEvents: Record<string, NodeSessionEvent[]> = {}) {
  return {
    get: vi.fn(async (path: string) => {
      const q = new URLSearchParams(path.split("?")[1] ?? "")
      const parent = q.get("parent")
      const after = Number(q.get("after") ?? 0)
      const events = parent ? (subEvents[parent] ?? []).filter((e) => e.seq > after) : []
      return { events, lastSeq: 40, through: 40 }
    }),
  }
}

const parentCalls = (api: ReturnType<typeof fakeApi>) =>
  api.get.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("parent="))

function renderPanel(events: () => NodeSessionEvent[], over: { sheet?: boolean } = {}) {
  const [open, setOpen] = createSignal<string | null>(null)
  const utils = render(() => (
    <SubagentsPanel
      session={row()}
      events={events()}
      sheet={over.sheet ?? false}
      sheetOpen={false}
      onCloseSheet={() => {}}
      openToolUseId={open()}
      onOpen={setOpen}
      onCloseDrawer={() => setOpen(null)}
    />
  ))
  return { ...utils, setOpen }
}

beforeEach(() => {
  seq = 0
  try {
    localStorage.removeItem(RAIL_COLLAPSED_KEY)
  } catch {
    // no storage in this environment
  }
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
  vi.setSystemTime(T0 + 5 * 60_000)
})

afterEach(() => {
  vi.useRealTimers()
  resetSessionStore()
  resetSessionCommands()
})

describe("SubagentsPanel (S53, S54)", () => {
  it("S53: new subagent rows arrive collapsed: one row each, nothing of theirs fetched or held", async () => {
    const api = fakeApi()
    setSessionStoreApi(() => api as never)
    const [events, setEvents] = createSignal<NodeSessionEvent[]>([
      started(T0, "a", "Write the migration"),
    ])
    renderPanel(events)
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(1)
    const more = [...events()]
    for (let i = 0; i < 9; i++) more.push(started(T0 + 1000 * i, `n${i}`, `Task ${i}`))
    setEvents(more)
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(10)
    expect(screen.queryByTestId("subagent-drawer")).toBeNull()
    expect(parentCalls(api)).toEqual([])
    for (const e of more) {
      const tu = String((e.payload.data as { toolUseId: string }).toolUseId)
      expect(sessionStore.subagentEvents("s1", tu)).toEqual([])
    }
  })

  it("S54: a row shows title, type·model, elapsed, tool count, last action and its age; stuck rows first with their badge", () => {
    setSessionStoreApi(() => fakeApi() as never)
    const events = [
      ev(T0 - 1000, "tool_call", {
        id: "tu_b",
        name: "Agent",
        input: { description: "Busy one", subagent_type: "general-purpose", model: "sonnet" },
      }),
      started(T0, "b", "Busy one"),
      task(T0 + 4 * 60_000 + 50_000, "task_progress", {
        taskId: "b",
        toolUses: 12,
        lastToolName: "Bash",
      }),
      started(T0, "q", "Quiet one"),
      started(T0, "d", "Done one"),
      task(T0 + 60_000, "task_notification", { taskId: "d", status: "failed" }),
    ]
    renderPanel(() => events)
    const rows = screen.getAllByTestId("subagent-row")
    expect(rows.map((r) => r.dataset.state)).toEqual(["stuck", "running", "failed"])
    expect(rows[0].textContent).toContain("Quiet one")
    expect(rows[0].textContent).toContain("No activity")
    const busy = rows[1].textContent ?? ""
    expect(busy).toContain("general-purpose · sonnet")
    expect(busy).toContain("12 tool calls")
    expect(busy).toContain("Bash · 10 s ago")
    expect(busy).toContain("5 min")
    expect(rows[2].textContent).toContain("Failed")
    expect(screen.getByText("Active · 2")).toBeTruthy()
    expect(screen.getByText("Finished · 1")).toBeTruthy()
  })

  it("S54, D31a: a stuck row's badge names its last tool, even when its last progress named one", () => {
    setSessionStoreApi(() => fakeApi() as never)
    const events = [
      started(T0, "b", "Long build"),
      task(T0 + 30_000, "task_progress", { taskId: "b", toolUses: 3, lastToolName: "Bash" }),
    ]
    renderPanel(() => events)
    const rows = screen.getAllByTestId("subagent-row")
    expect(rows.map((r) => r.dataset.state)).toEqual(["stuck"])
    expect(rows[0].textContent).toContain("No activity 4 min · last: Bash")
  })

  it("S54: the panel collapses to a strip that keeps the counts, and stays collapsed on this device", () => {
    setSessionStoreApi(() => fakeApi() as never)
    const events = [
      started(T0, "a", "One"),
      started(T0 + 4 * 60_000 + 30_000, "b", "Two"),
      started(T0, "c", "Three"),
      task(T0 + 60_000, "task_notification", { taskId: "c", status: "completed" }),
    ]
    const first = renderPanel(() => events)
    fireEvent.click(screen.getByRole("button", { name: "Collapse the subagents panel" }))
    expect(screen.queryAllByTestId("subagent-row")).toHaveLength(0)
    const strip = screen.getByTestId("subagents-strip")
    expect(strip.getAttribute("aria-label")).toBe("1 running · 1 stuck · 1 done")
    expect(
      [...strip.querySelectorAll("[data-count]")].map((n) => [
        (n as HTMLElement).dataset.count,
        n.textContent,
      ]),
    ).toEqual([
      ["running", "1"],
      ["stuck", "1"],
      ["done", "1"],
    ])
    first.unmount()
    renderPanel(() => events)
    expect(screen.getByTestId("subagents-strip")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show the subagents panel" }))
    expect(screen.getAllByTestId("subagent-row")).toHaveLength(3)
  })

  it("S53: opening a row fetches that subagent with parent=<id> and renders it; closing releases it", async () => {
    const sub = [
      ev(T0 + 1000, "assistant_text", { text: "Reading the plan" }, "tu_a"),
      ev(T0 + 2000, "tool_call", { id: "c1", name: "Grep", input: { pattern: "x" } }, "tu_a"),
    ]
    const api = fakeApi({ tu_a: sub })
    setSessionStoreApi(() => api as never)
    renderPanel(() => [started(T0, "a", "Write the migration")])
    fireEvent.click(screen.getByTestId("subagent-row"))
    const drawer = await screen.findByTestId("subagent-drawer")
    await waitFor(() => expect(drawer.textContent).toContain("Reading the plan"))
    expect(parentCalls(api)).toEqual(["/me/node-sessions/s1/events?after=0&limit=500&parent=tu_a"])
    expect(sessionStore.subagentEvents("s1", "tu_a")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByTestId("subagent-drawer")).toBeNull()
    expect(sessionStore.subagentEvents("s1", "tu_a")).toEqual([])
  })

  it("batch-4 F6: a long subagent's drawer loads its trimmed earliest events on request (before=, parent=)", async () => {
    seq = 100
    const sub: NodeSessionEvent[] = []
    for (let i = 1; i <= 2_300; i++) {
      sub.push(ev(T0 + i, "assistant_text", { text: `sub step ${i}` }, "tu_a"))
    }
    const get = vi.fn(async (path: string) => {
      const q = new URLSearchParams(path.split("?")[1] ?? "")
      if (q.get("parent") !== "tu_a") return { events: [], lastSeq: 2_400, through: 2_400 }
      const limit = Number(q.get("limit"))
      if (q.has("before")) {
        const before = Number(q.get("before"))
        return { events: sub.filter((e) => e.seq < before).slice(-limit), lastSeq: 2_400 }
      }
      const after = Number(q.get("after") ?? 0)
      const events = sub.filter((e) => e.seq > after).slice(0, limit)
      return { events, lastSeq: 2_400, through: events.at(-1)?.seq ?? 2_400 }
    })
    setSessionStoreApi(() => ({ get }) as never)
    renderPanel(() => [started(T0, "a", "Write the migration")])
    fireEvent.click(screen.getByTestId("subagent-row"))
    const button = await screen.findByTestId("subagent-load-earlier", {}, { timeout: 10_000 })
    const held = () => sessionStore.subagentEvents("s1", "tu_a")
    const first = held()[0].seq
    expect(first).toBeGreaterThan(sub[0].seq)
    fireEvent.click(button)
    await waitFor(() => expect(held()[0].seq).toBe(sub[0].seq))
    expect(get.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("before="))).toEqual([
      `/me/node-sessions/s1/events?before=${first}&limit=500&parent=tu_a`,
    ])
    const seqs = held().map((e) => e.seq)
    expect(seqs).toEqual(sub.map((e) => e.seq))
    // The short page was the subagent's first: nothing earlier, no button.
    await waitFor(() => expect(screen.queryByTestId("subagent-load-earlier")).toBeNull())
  }, 30_000)

  it("S56: a drawer row the owner expanded stays expanded when its result arrives (rows keyed by seq)", async () => {
    const sub = [
      ev(T0 + 1000, "tool_call", { id: "c1", name: "Bash", input: { command: "echo hi" } }, "tu_a"),
    ]
    const api = fakeApi({ tu_a: sub })
    setSessionStoreApi(() => api as never)
    renderPanel(() => [started(T0, "a", "Write the migration")])
    fireEvent.click(screen.getByTestId("subagent-row"))
    const drawer = await screen.findByTestId("subagent-drawer")
    await waitFor(() => expect(drawer.querySelector("[data-testid='tool-row']")).toBeTruthy())
    const toolRow = () => drawer.querySelector("[data-testid='tool-row']") as HTMLElement
    fireEvent.click(toolRow().querySelector("button[aria-expanded]") as HTMLElement)
    expect(toolRow().dataset.open).toBe("true")
    // The result streams in while the drawer is open.
    seq = 40
    sub.push(ev(T0 + 2000, "tool_result", { id: "c1", isError: false, output: "hi there" }, "tu_a"))
    applyRow(row({ lastSeq: 50 }))
    await waitFor(() => expect(toolRow().textContent).toContain("hi there"))
    expect(toolRow().dataset.open).toBe("true")
  })

  it("S54: Stop subagent sends stop_task with that subagent's task id", async () => {
    setSessionStoreApi(() => fakeApi() as never)
    const post = vi.fn(async () => ({ commandId: "c1", seq: 1 }))
    setSessionCommandsApi(() => ({ post }) as never)
    renderPanel(() => [started(T0 + 4 * 60_000, "a", "Write the migration")])
    fireEvent.click(screen.getByTestId("subagent-row"))
    fireEvent.click(await screen.findByRole("button", { name: "Stop subagent" }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/me/node-sessions/s1/commands", {
        type: "stop_task",
        payload: { taskId: "a" },
      }),
    )
  })
})

describe("SubagentsPanel: an import's subagents (S44, regression)", () => {
  it("S44 (regression): synthesized task_started/task_notification of an import show in the Subagents panel and the subagent's lines only in its drawer", async () => {
    const sub = [ev(T0 + 1000, "assistant_text", { text: "Reading the schema" }, "tu_a1")]
    const api = fakeApi({ tu_a1: sub })
    setSessionStoreApi(() => api as never)
    // The follow host's synthesized pair (follow-host.ts): agentId as taskId.
    const events = [
      task(T0, "task_started", {
        taskId: "a1",
        toolUseId: "tu_a1",
        description: "Map the schema",
        subagentType: "Explore",
        taskType: "local_agent",
      }),
      task(T0 + 2000, "task_notification", {
        taskId: "a1",
        toolUseId: "tu_a1",
        status: "completed",
      }),
    ]
    const [open, setOpen] = createSignal<string | null>(null)
    render(() => (
      <SubagentsPanel
        session={row({ source: "import", importMode: "follow", following: true })}
        events={events}
        sheet={false}
        sheetOpen={false}
        onCloseSheet={() => {}}
        openToolUseId={open()}
        onOpen={setOpen}
        onCloseDrawer={() => setOpen(null)}
      />
    ))
    const rows = screen.getAllByTestId("subagent-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain("Map the schema")
    expect(rows[0].textContent).not.toContain("Reading the schema")
    fireEvent.click(rows[0])
    const drawer = await screen.findByTestId("subagent-drawer")
    await waitFor(() => expect(drawer.textContent).toContain("Reading the schema"))
  })
})
