// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S58 (owner D34): the session view tells the store when it is on screen. A
// view whose document is hidden lets its events go after RELEASE_AFTER_MS
// (the header and the open request stay); shown again, its rows come back.

import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetTabStore } from "~/modules/shell/tab-store"
import type { SessionComposerProps } from "./SessionComposer"
import SessionView from "./SessionView"
import type { NodeSessionRow } from "./session-api"
import {
  RELEASE_AFTER_MS,
  resetSessionStore,
  SCREEN_KEEP,
  sessionStore,
  setSessionStoreApi,
  settleSession,
} from "./session-store"

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

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

afterEach(() => {
  vi.useRealTimers()
  setHidden(false)
})

describe("S58: a background session view", () => {
  it("S58: hidden for 30 s it releases its events but keeps the header and the open request; shown again its rows come back", async () => {
    const many = [...EVENTS]
    for (let seq = 4; seq <= 120; seq++)
      many.push(ev(seq, "assistant_text", { text: `step ${seq}` }))
    api({ row: row({ lastSeq: 120 }), events: many })
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getAllByTestId("session-event").length).toBe(120))
    const seqs = () => screen.getAllByTestId("session-event").map((r) => Number(r.dataset.seq))
    const before = seqs()

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    setHidden(true)
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.isReleased("s1")).toBe(true)
    expect(seqs().length).toBeLessThanOrEqual(SCREEN_KEEP + 1)
    expect(seqs()).toContain(3)
    expect(screen.getByTestId("request-card").dataset.requestId).toBe("r1")

    setHidden(false)
    await settleSession("s1")
    vi.useRealTimers()
    await waitFor(() => expect(seqs()).toEqual(before))
    expect(sessionStore.isReleased("s1")).toBe(false)
  })

  it("S58 (batch-5 F6, F11): shown again while the server is unreachable, it says part of the session could not be loaded; Retry brings the rows back", async () => {
    const many = [...EVENTS]
    for (let seq = 4; seq <= 120; seq++)
      many.push(ev(seq, "assistant_text", { text: `step ${seq}` }))
    const opts = { row: row({ lastSeq: 120 }), events: many, fail: false }
    api(opts)
    render(() => <SessionView entityId="s1" />)
    await waitFor(() => expect(screen.getAllByTestId("session-event").length).toBe(120))
    const seqs = () => screen.getAllByTestId("session-event").map((r) => Number(r.dataset.seq))
    const before = seqs()

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    setHidden(true)
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    opts.fail = true
    setHidden(false)
    await settleSession("s1")
    vi.useRealTimers()
    await waitFor(() => expect(screen.getByTestId("read-back-failed")).toBeTruthy())
    expect(seqs().length).toBeLessThanOrEqual(SCREEN_KEEP + 1)

    opts.fail = false
    fireEvent.click(screen.getByTestId("read-back-retry"))
    await waitFor(() => expect(seqs()).toEqual(before))
    expect(screen.queryByTestId("read-back-failed")).toBeNull()
  })
})
