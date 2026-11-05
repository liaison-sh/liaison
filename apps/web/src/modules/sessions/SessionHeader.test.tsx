// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T09 (S8 header, charter): the session header shows title, status, folder,
// branch, model, level, node, Claude Code version and source (its path only in
// that chip's tooltip), tokens, elapsed and origin; Paused on an offline node
// (P2-D3); Stop only once P3 registers it; the pinned plan only with a todo.
import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { DESKTOP_BRIDGE_KEY } from "~/lib/desktop-shell-contract"
import { setNodeSession } from "~/modules/nodes/node-session"
import { applyNodeFrame, loadNodes, resetNodesStore } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { resetStoppedOrphans } from "./header-info"
import SessionHeader from "./SessionHeader"
import SessionPlan from "./SessionPlan"
import { registerSessionActions, resetSessionActions } from "./session-actions"
import type { NodeSessionRow } from "./session-api"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { applyRow, resetSessionStore, sessionStore } from "./session-store"

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
    title: "Add a line to the README",
    folderName: "liaison-walk-sample",
    repo: null,
    branch: "node/readme",
    pushed: true,
    prUrl: "https://example.com/pr/1",
    model: "claude-haiku-4-5",
    level: "standard",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: "2.1.7 installed /opt/homebrew/bin/claude",
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 400_000,
    tokensOut: 12_000,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: new Date(Date.now() - 23.5 * 60_000).toISOString(),
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
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

async function withNode(online: boolean) {
  const api = { get: vi.fn(async () => ({ nodes: [{ ...NODE, online }] })) }
  await loadNodes(api as never)
}

let seq = 0
function todo(items: Array<{ content: string; status: string; activeForm?: string }>) {
  seq++
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq).toISOString(),
    type: "todo",
    payload: { items, from: "TodoWrite" },
  } as NodeSessionEvent
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  setNodeSession(null)
  resetSessionActions()
  resetNodesStore()
  resetSessionCommands()
  resetStoppedOrphans()
})

function commandsApi() {
  const post = vi.fn(async (_path: string, _body?: unknown) => ({
    commandId: "00000000-0000-4000-8000-000000000001",
    seq: 1,
  }))
  const patch = vi.fn(async (_path: string, body?: unknown) => ({
    ...row(),
    ...(body as object),
  }))
  const get = vi.fn(async () => ({ commands: [] }))
  setSessionCommandsApi(() => ({ post, patch, get }) as never)
  return { post, patch }
}

describe("SessionHeader", () => {
  it("the header shows title, status, folder, branch, model, level, node, Claude Code version and source, tokens, elapsed, origin", async () => {
    await withNode(true)
    render(() => <SessionHeader session={row()} events={[]} />)
    const h = screen.getByTestId("session-header")
    for (const text of [
      "Add a line to the README",
      "Running",
      "liaison-walk-sample",
      "node/readme",
      "pushed",
      "claude-haiku-4-5",
      "Standard",
      "Mac mini",
      "Claude Code 2.1.7 (installed)",
      "412k tokens",
      "23 min",
      "Started by you at",
    ]) {
      expect(h.textContent).toContain(text)
    }
    expect(screen.getByRole("link", { name: /Pull request/ }).getAttribute("href")).toBe(
      "https://example.com/pr/1",
    )
  })

  // P1-walk D15: "Claude Code unknown (bundled)" showed the node's English word.
  it("a Claude Code version the node could not read is left out, never 'unknown' (D15)", async () => {
    await withNode(true)
    render(() => (
      <SessionHeader session={row({ claudeCode: "unknown bundled /tmp/x/claude" })} events={[]} />
    ))
    const h = screen.getByTestId("session-header")
    expect(h.textContent).toContain("Claude Code (bundled)")
    expect(h.textContent).not.toContain("unknown")
  })

  it("the Claude Code path is only in its chip's title", async () => {
    await withNode(true)
    render(() => <SessionHeader session={row()} events={[]} />)
    const h = screen.getByTestId("session-header")
    expect(h.textContent).not.toContain("/opt/homebrew")
    const withPath = [...h.querySelectorAll("[title]")].filter((e) =>
      (e.getAttribute("title") ?? "").includes("/opt/homebrew/bin/claude"),
    )
    expect(withPath).toHaveLength(1)
    expect(withPath[0].getAttribute("data-chip")).toBe("claude-code")
  })

  it("a running session on an offline node shows Paused in the tertiary tone", async () => {
    await withNode(true)
    render(() => <SessionHeader session={row()} events={[]} />)
    const pill = screen.getByTestId("status-pill")
    expect(pill.textContent).toContain("Running")
    applyNodeFrame({ nodeId: "n1", change: "presence", online: false })
    expect(pill.textContent).toContain("Paused")
    expect(pill.className).toContain("text-text-tertiary")
  })

  it("D27: the desktop header has no Stop, even with the action registered (the composer carries it)", async () => {
    await withNode(true)
    registerSessionActions({ stop: vi.fn(async () => {}) })
    render(() => <SessionHeader session={row()} events={[]} />)
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("S7: Mark done shows for needs_you and waiting, not for done; clicking posts mark_done", async () => {
    const api = commandsApi()
    const ended = "2026-10-13T10:10:00.000Z"
    const cases: Array<[Partial<NodeSessionRow>, boolean]> = [
      [{ status: "waiting", state: "needs_you", endedAt: ended }, true],
      [{ status: "waiting", state: "waiting", pendingCount: 1 }, true],
      [{ status: "done", state: "done", endedAt: ended }, false],
      [{ status: "running", state: "running" }, false],
    ]
    for (const [over, shown] of cases) {
      const { unmount } = render(() => (
        <SessionHeader session={row({ muted: false, ...over })} events={[]} />
      ))
      expect(!!screen.queryByRole("button", { name: "Mark done" })).toBe(shown)
      unmount()
    }
    render(() => (
      <SessionHeader
        session={row({ status: "waiting", state: "needs_you", muted: false, endedAt: ended })}
        events={[]}
      />
    ))
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "mark_done", payload: {} },
    ])
  })

  it("S7: Mark done refused node_outdated (409) toasts our own sentence, not the API's English text", async () => {
    const api = commandsApi()
    api.post.mockRejectedValueOnce(
      new ApiError("node is outdated: it does not understand mark_done", 409, "node_outdated"),
    )
    resetToastStore()
    render(() => (
      <SessionHeader
        session={row({ status: "waiting", state: "needs_you", muted: false })}
        events={[]}
      />
    ))
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }))
    await waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]?.message).toBe(
      "Update the Liaison desktop app on this computer to mark this session done.",
    )
  })

  it("S14: the bell posts muted:true and reflects the row", async () => {
    const api = commandsApi()
    const [session, setSession] = createSignal(row({ state: "running", muted: false }))
    render(() => <SessionHeader session={session()} events={[]} />)
    const bell = screen.getByRole("button", { name: "Mute this session" })
    expect(bell.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(bell)
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    expect(api.patch.mock.calls[0]).toEqual(["/me/node-sessions/s1", { muted: true }])
    // The server's node_session frame carries the new row.
    setSession(row({ state: "running", muted: true }))
    expect(bell.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(bell)
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))
    expect(api.patch.mock.calls[1]).toEqual(["/me/node-sessions/s1", { muted: false }])
  })

  it("S7: Mark done and the bell are hidden when the row has no state/muted field", () => {
    // A new client served by an API that predates the wave (feature detection).
    render(() => (
      <SessionHeader session={row({ status: "waiting", pendingCount: 1 })} events={[]} />
    ))
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Mute this session" })).toBeNull()
  })

  it("Files changed is hidden while nothing changed", () => {
    render(() => <SessionHeader session={row()} events={[]} filesCount={0} />)
    expect(screen.queryByRole("button", { name: /Files changed/ })).toBeNull()
  })
  it("the Files changed button shows the count and opens the drawer", () => {
    const onOpenFiles = vi.fn()
    const edit = {
      seq: 1,
      at: "2026-10-13T10:00:00.000Z",
      receivedAt: "2026-10-13T10:00:00.000Z",
      type: "tool_call",
      payload: {
        id: "toolu_1",
        name: "Edit",
        input: { file_path: "/x/liaison-walk-sample/README.md", old_string: "a", new_string: "b" },
      },
    } as NodeSessionEvent
    const result = {
      seq: 2,
      at: "2026-10-13T10:00:01.000Z",
      receivedAt: "2026-10-13T10:00:01.000Z",
      type: "tool_result",
      payload: { id: "toolu_1", output: "ok" },
    } as NodeSessionEvent
    render(() => (
      <SessionHeader session={row()} events={[edit, result]} onOpenFiles={onOpenFiles} />
    ))
    const btn = screen.getByRole("button", { name: /Files changed/ })
    expect(btn.textContent).toContain("1")
    fireEvent.click(btn)
    expect(onOpenFiles).toHaveBeenCalled()
  })
})

function driverEvent(seq: number, data: Record<string, unknown>): NodeSessionEvent {
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq).toISOString(),
    type: "system",
    payload: { subtype: "driver", text: "Driven from VS Code", data },
  } as NodeSessionEvent
}

describe("SessionHeader: one driver at a time (S51, S52)", () => {
  const needsYou = { status: "waiting", state: "needs_you", endedAt: "2026-10-13T10:10:00.000Z" }

  it("S51: the badge shows after a driver elsewhere event and clears after elsewhere false", () => {
    const [events, setEvents] = createSignal<NodeSessionEvent[]>([])
    render(() => (
      <SessionHeader session={row(needsYou as Partial<NodeSessionRow>)} events={events()} />
    ))
    expect(screen.queryByTestId("session-driver")).toBeNull()
    setEvents([driverEvent(1, { elsewhere: true, via: "vscode" })])
    const badge = screen.getByTestId("session-driver")
    expect(badge.textContent).toBe("Driven from VS Code")
    expect(badge.getAttribute("title")).toBe(
      "VS Code is driving this session. Send again to resume it here as well.",
    )
    setEvents([
      driverEvent(1, { elsewhere: true, via: "vscode" }),
      driverEvent(2, { elsewhere: false, via: null }),
    ])
    expect(screen.queryByTestId("session-driver")).toBeNull()
  })

  it("S51: a terminal reads as a terminal; a running session shows no badge", () => {
    const events = [driverEvent(1, { elsewhere: true, via: "cli" })]
    const { unmount } = render(() => (
      <SessionHeader session={row(needsYou as Partial<NodeSessionRow>)} events={events} />
    ))
    expect(screen.getByTestId("session-driver").textContent).toBe("Driven from a terminal")
    unmount()
    render(() => <SessionHeader session={row({ state: "running" })} events={events} />)
    expect(screen.queryByTestId("session-driver")).toBeNull()
  })

  const CLI_ID = "41173e76-dc0a-4f5f-8c7a-fde5d5329047"
  const orphanEvent = (seq: number) =>
    driverEvent(seq, { elsewhere: true, via: null, orphanPid: 5093, cliSessionId: CLI_ID })

  it("D33 (batch-4 F3): an orphan's badge names its pid; Stop it, on this computer, stops it through the shell and clears the badge", async () => {
    const stopOrphanClaude = vi.fn(async (_id: string, _pid: number) => true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = { version: 1, stopOrphanClaude }
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    render(() => (
      <SessionHeader session={row(needsYou as Partial<NodeSessionRow>)} events={[orphanEvent(1)]} />
    ))
    const badge = screen.getByTestId("session-driver")
    expect(badge.textContent).toContain("An orphaned Claude process (pid 5093) holds this session")
    fireEvent.click(screen.getByRole("button", { name: "Stop it" }))
    await waitFor(() => expect(stopOrphanClaude).toHaveBeenCalledTimes(1))
    expect(stopOrphanClaude.mock.calls[0]).toEqual([CLI_ID, 5093])
    await waitFor(() => expect(screen.queryByTestId("session-driver")).toBeNull())
  })

  it("D33 (batch-4 F3): no Stop it outside the desktop shell or for another computer; a refused stop says so and keeps the badge", async () => {
    const session = row(needsYou as Partial<NodeSessionRow>)
    // A browser: the badge, no button.
    const browser = render(() => <SessionHeader session={session} events={[orphanEvent(1)]} />)
    expect(screen.getByTestId("session-driver").textContent).toContain("(pid 5093)")
    expect(screen.queryByRole("button", { name: "Stop it" })).toBeNull()
    browser.unmount()
    const stopOrphanClaude = vi.fn(async () => false)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = { version: 1, stopOrphanClaude }
    // Another computer's session: no button.
    setNodeSession({ nodeId: "n2", credential: "c", enabled: true })
    const other = render(() => <SessionHeader session={session} events={[orphanEvent(1)]} />)
    expect(screen.queryByRole("button", { name: "Stop it" })).toBeNull()
    other.unmount()
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    resetToastStore()
    render(() => <SessionHeader session={session} events={[orphanEvent(1)]} />)
    fireEvent.click(screen.getByRole("button", { name: "Stop it" }))
    await waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]?.message).toBe("Couldn't stop the orphaned Claude process (pid 5093).")
    expect(screen.getByTestId("session-driver")).toBeTruthy()
  })

  it("S52: the button is absent outside the desktop shell and for a non-local node", () => {
    const openFolderInEditor = vi.fn(async () => true)
    // A browser: no bridge.
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    const browser = render(() => <SessionHeader session={row()} events={[]} />)
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull()
    browser.unmount()
    // The desktop app, but the session runs on another computer.
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      openFolderInEditor,
    }
    setNodeSession({ nodeId: "n2", credential: "c", enabled: true })
    const other = render(() => <SessionHeader session={row()} events={[]} />)
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull()
    other.unmount()
    // A session run for others (isolated, not in the folder itself).
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    const isolated = render(() => (
      <SessionHeader session={row({ configKind: "isolated" })} events={[]} />
    ))
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull()
    isolated.unmount()
    expect(openFolderInEditor).not.toHaveBeenCalled()
  })

  it("S52: on this computer the button asks the shell to open the folder by its name, never a path", async () => {
    const openFolderInEditor = vi.fn(async (_name: string) => true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      openFolderInEditor,
    }
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    render(() => <SessionHeader session={row()} events={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }))
    await waitFor(() => expect(openFolderInEditor).toHaveBeenCalledTimes(1))
    expect(openFolderInEditor.mock.calls[0]).toEqual(["liaison-walk-sample"])
  })
})

describe("SessionHeader: Open in VS Code for a subfolder session (S52)", () => {
  it("S52: a session whose cwd is below its shared folder names the folder and the path below it, never an absolute path", async () => {
    const openFolderInEditor = vi.fn(async (_name: string, _rel?: string) => true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      openFolderInEditor,
    }
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    const start: NodeSessionEvent = {
      seq: 2,
      at: "2026-10-13T10:00:01.000Z",
      receivedAt: "2026-10-13T10:00:01.000Z",
      type: "system",
      payload: {
        subtype: "start",
        text: "Claude Code started at strict",
        data: {
          cwd: "/Users/o/code/liaison-walk-sample/apps/web",
          folderRelPath: "apps/web",
        },
      },
    } as NodeSessionEvent
    render(() => <SessionHeader session={row()} events={[start]} />)
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }))
    await waitFor(() => expect(openFolderInEditor).toHaveBeenCalledTimes(1))
    expect(openFolderInEditor.mock.calls[0]).toEqual(["liaison-walk-sample", "apps/web"])
  })

  const startAt = (data: Record<string, unknown>) =>
    ({
      seq: 2,
      at: "2026-10-13T10:00:01.000Z",
      receivedAt: "2026-10-13T10:00:01.000Z",
      type: "system",
      payload: { subtype: "start", text: "Claude Code started at strict", data },
    }) as NodeSessionEvent

  it("batch-4 F5: a subfolder bearing the shared folder's name opens the path the node matched exactly, not the part after the last match of the name", async () => {
    const openFolderInEditor = vi.fn(async (_name: string, _rel?: string) => true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      openFolderInEditor,
    }
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    const start = startAt({ cwd: "/Users/me/code/tools/code/api", folderRelPath: "tools/code/api" })
    render(() => <SessionHeader session={row({ folderName: "code" })} events={[start]} />)
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }))
    await waitFor(() => expect(openFolderInEditor).toHaveBeenCalledTimes(1))
    expect(openFolderInEditor.mock.calls[0]).toEqual(["code", "tools/code/api"])
  })

  it("batch-4 F5: a start event without the node's matched path opens the folder itself, never a guessed subfolder", async () => {
    const openFolderInEditor = vi.fn(async (_name: string, _rel?: string) => true)
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
      version: 1,
      openFolderInEditor,
    }
    setNodeSession({ nodeId: "n1", credential: "c", enabled: true })
    const start = startAt({ cwd: "/Users/me/code/tools/code/api" })
    render(() => <SessionHeader session={row({ folderName: "code" })} events={[start]} />)
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }))
    await waitFor(() => expect(openFolderInEditor).toHaveBeenCalledTimes(1))
    expect(openFolderInEditor.mock.calls[0]).toEqual(["code"])
  })
})

describe("SessionHeader information chips (S20, S22, S55)", () => {
  const T0 = Date.parse("2026-10-15T12:00:00.000Z")
  let n = 0
  const ev = (
    atMs: number,
    type: NodeSessionEvent["type"],
    payload: Record<string, unknown>,
    parentToolUseId?: string,
  ) =>
    ({
      seq: ++n,
      at: new Date(atMs).toISOString(),
      receivedAt: new Date(atMs).toISOString(),
      type,
      payload,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    }) as NodeSessionEvent
  const chip = (name: string) =>
    screen.getByTestId("session-header").querySelector(`[data-chip="${name}"]`)

  afterEach(() => vi.useRealTimers())

  it("S22: the cache chip ticks with a fake clock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    vi.setSystemTime(T0 + 4 * 60_000)
    const usage = ev(T0, "usage", {
      tokensIn: 1000,
      tokensOut: 10,
      model: "m",
      cacheRead: 0,
      cacheWrite5m: 900,
      cacheWrite1h: 0,
    })
    render(() => (
      <SessionHeader session={row({ status: "done", state: "done" })} events={[usage]} />
    ))
    expect(chip("cache")?.textContent).toBe("Cache 1:00")
    vi.advanceTimersByTime(1000)
    expect(chip("cache")?.textContent).toBe("Cache 0:59")
    vi.advanceTimersByTime(59_000)
    expect(chip("cache")?.textContent).toBe("Cache cold")
  })

  it("S22: before any model call the cache is cold and there is no context chip", () => {
    render(() => <SessionHeader session={row()} events={[]} />)
    expect(chip("cache")?.textContent).toBe("Cache cold")
    expect(chip("context")).toBeNull()
  })

  it("S22: the context chip shows the latest main-thread context over the window", () => {
    const events = [
      ev(T0, "usage", { tokensIn: 1, tokensOut: 1, model: "m", contextTokens: 100_000 }),
      ev(T0 + 1, "result", { text: "ok", contextWindow: 200_000 }),
    ]
    render(() => <SessionHeader session={row()} events={events} />)
    expect(chip("context")?.textContent).toBe("Context 100k / 200k · 50%")
  })

  it("S55: the Tokens chip reads in · out, and its popover gives the breakdown and the hit rate", async () => {
    render(() => (
      <SessionHeader
        session={row({
          tokensIn: 1_000_000,
          tokensOut: 12_000,
          tokensCacheRead: 900_000,
          tokensCacheWrite5m: 40_000,
          tokensCacheWrite1h: 20_000,
        })}
        events={[]}
      />
    ))
    const tokens = screen.getByRole("button", { name: /Tokens/ })
    expect(tokens.textContent).toBe("Tokens in 100k · out 12k")
    // The inflated sum of every call is gone.
    expect(screen.getByTestId("session-header").textContent).not.toContain("1M")
    fireEvent.click(tokens)
    const pop = await screen.findByTestId("session-tokens-breakdown")
    for (const text of [
      "Uncached input40k",
      "Cache write (5 min)40k",
      "Cache write (1 h)20k",
      "Cache read900k",
      "Output12k",
      "Cache hit rate90%",
    ]) {
      expect(pop.textContent).toContain(text)
    }
  })

  it("S55: a row without the split shows the old single figure, labelled as a total", () => {
    render(() => <SessionHeader session={row()} events={[]} />)
    expect(chip("tokens")?.textContent).toBe("412k tokens in total")
    expect(screen.queryByRole("button", { name: /Tokens/ })).toBeNull()
  })

  it("S20/S54: the subagent chip counts running · stuck · done and opens the panel", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    vi.setSystemTime(T0 + 5 * 60_000)
    const task = (atMs: number, subtype: string, data: Record<string, unknown>) =>
      ev(atMs, "system", { subtype, text: "", data })
    const events = [
      task(T0, "task_started", { taskId: "a", toolUseId: "tu_a", taskType: "local_agent" }),
      task(T0, "task_started", { taskId: "b", toolUseId: "tu_b", taskType: "local_agent" }),
      task(T0, "task_started", { taskId: "c", toolUseId: "tu_c", taskType: "local_agent" }),
      task(T0, "task_started", { taskId: "sh", taskType: "local_bash" }),
      task(T0 + 4.5 * 60_000, "task_progress", { taskId: "b", toolUses: 3 }),
      task(T0 + 60_000, "task_notification", { taskId: "c", status: "completed" }),
    ]
    const onOpenSubagents = vi.fn()
    render(() => (
      <SessionHeader session={row()} events={events} onOpenSubagents={onOpenSubagents} />
    ))
    const btn = screen.getByRole("button", { name: /running/ })
    expect(btn.textContent).toBe("1 running · 1 stuck · 1 done")
    fireEvent.click(btn)
    expect(onOpenSubagents).toHaveBeenCalledTimes(1)
  })

  it("S20: no subagent chip without a subagent (a background shell is not one)", () => {
    const events = [
      ev(T0, "system", {
        subtype: "task_started",
        text: "",
        data: { taskId: "sh", taskType: "local_bash" },
      }),
    ]
    render(() => <SessionHeader session={row()} events={events} />)
    expect(chip("subagents")).toBeNull()
  })

  it("D7: the effort chip shows when the session has a reasoning level", () => {
    const { unmount } = render(() => <SessionHeader session={row()} events={[]} />)
    expect(chip("effort")).toBeNull()
    unmount()
    render(() => <SessionHeader session={row({ effort: "high" })} events={[]} />)
    expect(chip("effort")?.textContent).toBe("Reasoning: High")
  })
})

describe("SessionPlan", () => {
  it("the plan shows 3 of 10 and the current item, and nothing without a todo", () => {
    seq = 0
    const items = Array.from({ length: 10 }, (_, i) => ({
      content: `step ${i}`,
      status: i < 3 ? "completed" : i === 3 ? "in_progress" : "pending",
      activeForm: i === 3 ? "Doing step 3" : undefined,
    }))
    const { unmount } = render(() => (
      <SessionPlan events={[todo(items)]} pathContext={{ sessionId: "s1" }} />
    ))
    const plan = screen.getByTestId("session-plan")
    expect(plan.textContent).toContain("Plan")
    expect(plan.textContent).toContain("3 of 10")
    expect(plan.textContent).toContain("Doing step 3")
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("30")
    unmount()
    render(() => <SessionPlan events={[]} pathContext={{ sessionId: "s1" }} />)
    expect(screen.queryByTestId("session-plan")).toBeNull()
  })
})

describe("SessionHeader: autonomy (S30, S33)", () => {
  it("S30: an autonomous row shows the Autonomous chip on the web header; a guided one does not", () => {
    const { unmount } = render(() => (
      <SessionHeader session={row({ autonomy: "autonomous" })} events={[]} />
    ))
    expect(screen.getByTestId("session-autonomous").textContent).toBe("Autonomous")
    unmount()
    render(() => <SessionHeader session={row({ autonomy: "guided" })} events={[]} />)
    expect(screen.queryByTestId("session-autonomous")).toBeNull()
  })

  it("S33: the switch sends set_autonomy and a row_only answer shows the update note", async () => {
    const api = commandsApi()
    api.post.mockResolvedValueOnce({
      commandId: "00000000-0000-4000-8000-000000000002",
      seq: 2,
      applied: "row_only",
    } as never)
    resetToastStore()
    const [session, setSession] = createSignal(row({ autonomy: "guided" }))
    render(() => <SessionHeader session={session()} events={[]} />)
    const toggle = screen.getByRole("switch", { name: "Run on its own" })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "set_autonomy", payload: { autonomy: "autonomous" } },
    ])
    await waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]?.message).toBe("Applies when this computer's Liaison updates.")
    // The server's node_session frame carries the new row; switching back sends guided.
    setSession(row({ autonomy: "autonomous" }))
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(toggle)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[1]?.[1]).toEqual({
      type: "set_autonomy",
      payload: { autonomy: "guided" },
    })
    expect(toasts()).toHaveLength(1)
  })

  it("a narrow header's More menu carries the folded actions: Run on its own flips autonomy from there", async () => {
    const api = commandsApi()
    render(() => <SessionHeader session={row({ autonomy: "guided", muted: false })} events={[]} />)
    const more = screen.getByRole("button", { name: "More actions" })
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    const item = await screen.findByRole("menuitem", { name: /Run on its own/ })
    expect(screen.getByRole("menuitem", { name: "Mute this session" })).toBeTruthy()
    fireEvent.keyDown(item, { key: "Enter" })
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post.mock.calls[0]?.[1]).toEqual({
      type: "set_autonomy",
      payload: { autonomy: "autonomous" },
    })
  })
  it("S30: a row without autonomy hides the switch (an older API)", () => {
    render(() => <SessionHeader session={row()} events={[]} />)
    expect(screen.queryByRole("switch", { name: "Run on its own" })).toBeNull()
    expect(screen.queryByTestId("session-autonomous")).toBeNull()
  })
})

describe("SessionHeader: Atelier and the Needs-you reason (S35, S32, S57)", () => {
  const ATELIER = {
    id: "2026-10-16-feature-ab12",
    rung: "R3",
    phase: "spec",
    plan: ["frame", "spec", "execute"],
    done: ["frame"],
    status: "running" as const,
    awaiting: null,
  }

  it("S35: the web header shows the Atelier stepper from row.atelier; no field, no stepper", () => {
    const { unmount } = render(() => (
      <SessionHeader session={row({ atelier: ATELIER })} events={[]} />
    ))
    const stepper = screen
      .getByTestId("session-header")
      .querySelector("[data-testid=atelier-stepper]")
    expect(
      [...(stepper?.querySelectorAll("[data-testid=atelier-step]") ?? [])].map(
        (s) => (s as HTMLElement).dataset.state,
      ),
    ).toEqual(["done", "current", "pending"])
    unmount()
    render(() => <SessionHeader session={row()} events={[]} />)
    expect(screen.queryByTestId("atelier-stepper")).toBeNull()
  })

  it("S32/S57: the header says a needs_you row's reason code; an unknown code shows the summary", () => {
    const needs = { status: "waiting" as const, state: "needs_you" as const }
    const { unmount } = render(() => (
      <SessionHeader
        session={row({ ...needs, reasonCode: "pr_missing", resultSummary: "node words" })}
        events={[]}
      />
    ))
    expect(screen.getByTestId("session-header-reason").textContent).toBe(
      "Finished without a pull request.",
    )
    unmount()
    render(() => (
      <SessionHeader
        session={row({
          ...needs,
          reasonCode: "a_code_from_the_future" as NodeSessionRow["reasonCode"],
          resultSummary: "The remote refused the push.",
        })}
        events={[]}
      />
    ))
    expect(screen.getByTestId("session-header-reason").textContent).toBe(
      "The session says: The remote refused the push.",
    )
  })

  it("final recheck: the computer's own park reason says Your computer, never The session says", () => {
    render(() => (
      <SessionHeader
        session={row({
          status: "waiting",
          state: "needs_you",
          reasonCode: "workspace_blocked",
          resultSummary: "Another Liaison session, Fix cart, is using this folder on main.",
        })}
        events={[]}
      />
    ))
    expect(screen.getByTestId("session-header-reason").textContent).toBe(
      "Your computer says: Another Liaison session, Fix cart, is using this folder on main.",
    )
  })

  it("W2-D7: the Needs-you banner shows the session's words without their markdown", () => {
    render(() => (
      <SessionHeader
        session={row({
          status: "waiting",
          state: "needs_you",
          resultSummary: "Which name should the variable use: **foo** or **bar**? See `NAME.txt`.",
        })}
        events={[]}
      />
    ))
    expect(screen.getByTestId("session-header-reason").textContent).toBe(
      "The session says: Which name should the variable use: foo or bar? See NAME.txt.",
    )
  })
})

describe("SessionHeader: imports (W3, S41, A44, A49)", () => {
  const followed = (over: Partial<NodeSessionRow> = {}) =>
    row({
      source: "import",
      importMode: "follow",
      importFrom: "vscode",
      following: true,
      cwdSubdir: "sub",
      ...over,
    })

  function withDeleteApi(del: (path: string) => Promise<unknown>) {
    const api = { delete: vi.fn(del) }
    return {
      api,
      wrap: (ui: () => JSX.Element) => () => (
        <ApiContext.Provider value={api as never}>{ui()}</ApiContext.Provider>
      ),
    }
  }

  it("S41: a following follow-mode import shows the chips, Take over and Stop following", async () => {
    const api = commandsApi()
    render(() => <SessionHeader session={followed()} events={[]} />)
    expect(screen.getByTestId("session-imported").textContent).toBe("Imported")
    expect(screen.getByTestId("session-following").textContent).toBe("Following VS Code")
    fireEvent.click(screen.getByRole("button", { name: "Take over" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post.mock.calls[0]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "take_over", payload: {} },
    ])
    fireEvent.click(screen.getByRole("button", { name: "Stop following" }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[1]).toEqual([
      "/me/node-sessions/s1/commands",
      { type: "stop", payload: {} },
    ])
  })

  it("A44: a taken-over import offers no Take over; a stopped follow no Stop following", () => {
    render(() => (
      <SessionHeader
        session={followed({ importMode: "take_over", following: false })}
        events={[]}
      />
    ))
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop following" })).toBeNull()
    expect(screen.queryByTestId("session-following")).toBeNull()
    expect(screen.getByTestId("session-imported").textContent).toBe("Imported")
  })

  it("A45: an in-place session followed while a terminal drives it says Following Terminal", () => {
    render(() => (
      <SessionHeader
        session={row({ following: true, importMode: null, importFrom: null })}
        events={[
          {
            seq: 1,
            at: "2026-10-16T10:00:00.000Z",
            receivedAt: "2026-10-16T10:00:00.000Z",
            type: "system",
            payload: { subtype: "driver", text: "", data: { elsewhere: true, via: "cli" } },
          } as NodeSessionEvent,
        ]}
      />
    ))
    expect(screen.getByTestId("session-following").textContent).toBe("Following Terminal")
    expect(screen.queryByTestId("session-imported")).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete from Liaison" })).toBeNull()
  })

  it("A49: Delete asks a confirmation, calls DELETE, and the session leaves the store", async () => {
    applyRow(followed())
    const { api, wrap } = withDeleteApi(async () => ({ id: "s1", deleted: true }))
    render(wrap(() => <SessionHeader session={followed()} events={[]} />))
    fireEvent.click(screen.getByRole("button", { name: "Delete from Liaison" }))
    const dialog = await screen.findByTestId("session-delete-dialog")
    expect(dialog.textContent).toContain(
      "The session's transcript stays on your computer. Liaison's copy is deleted.",
    )
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1))
    expect(api.delete.mock.calls[0][0]).toBe("/me/node-sessions/s1")
    await waitFor(() => expect(sessionStore.row("s1")).toBeUndefined())
    resetSessionStore()
  })

  it("A49: a refused delete (409 session_live) says so and keeps the row", async () => {
    resetToastStore()
    applyRow(followed({ importMode: "take_over", following: false }))
    const { wrap } = withDeleteApi(async () => {
      throw new ApiError("live", 409, "session_live")
    })
    render(
      wrap(() => (
        <SessionHeader
          session={followed({ importMode: "take_over", following: false })}
          events={[]}
        />
      )),
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete from Liaison" }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain(
        "This session is running. Stop it first, then delete it.",
      ),
    )
    expect(sessionStore.row("s1")?.id).toBe("s1")
    resetSessionStore()
  })

  it("A49: Delete is absent on a dispatch session", () => {
    render(() => <SessionHeader session={row({ source: "dispatch" })} events={[]} />)
    expect(screen.queryByRole("button", { name: "Delete from Liaison" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull()
    expect(screen.queryByTestId("session-imported")).toBeNull()
  })

  // Walk 3 (wf6): a read-only follow is driven elsewhere, so Run on its own
  // (switch, More menu item, Autonomous chip) cannot apply; Take over brings it back.
  it("a read-only follow offers no autonomy control; Take over brings them back", async () => {
    const [session, setSession] = createSignal(followed({ autonomy: "autonomous", muted: false }))
    render(() => <SessionHeader session={session()} events={[]} />)
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "Run on its own" })).toBeNull()
    expect(screen.queryByTestId("session-autonomous")).toBeNull()
    const more = screen.getByRole("button", { name: "More actions" })
    more.focus()
    fireEvent.keyDown(more, { key: "ArrowDown" })
    await screen.findByRole("menuitem", { name: "Mute this session" })
    expect(screen.queryByRole("menuitem", { name: /Run on its own/ })).toBeNull()
    fireEvent.keyDown(more, { key: "Escape" })
    setSession(followed({ importMode: "take_over", following: false, autonomy: "autonomous" }))
    expect(screen.getByRole("switch", { name: "Run on its own" })).toBeTruthy()
    expect(screen.getByTestId("session-autonomous").textContent).toBe("Autonomous")
  })

  // Walk 3 (wf6): with the subagent drawer open the title row was too narrow and
  // Take over overflowed onto the Following chip (shrink-0 chips and actions in a
  // row that could not wrap). The row now wraps: nothing in it refuses to shrink.
  it("the title row wraps rather than overflows: chips and actions never overlap", () => {
    render(() => <SessionHeader session={followed({ autonomy: "guided" })} events={[]} />)
    const rowEl = screen.getByTestId("session-title-row")
    expect(rowEl.classList.contains("flex-wrap")).toBe(true)
    const block = screen.getByTestId("session-title-block")
    expect(block.classList.contains("flex-wrap")).toBe(true)
    const actions = screen.getByTestId("session-header-actions")
    expect(actions.classList.contains("flex-wrap")).toBe(true)
    // The chips' group sits in the title block and may shrink and wrap.
    const chips = screen.getByTestId("session-following").parentElement as HTMLElement
    expect(block.contains(chips)).toBe(true)
    for (const el of [block, chips, actions]) {
      expect(el.classList.contains("shrink-0")).toBe(false)
    }
    expect(actions.contains(screen.getByRole("button", { name: "Take over" }))).toBe(true)
  })
})
