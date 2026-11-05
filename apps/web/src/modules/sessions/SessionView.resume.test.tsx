// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D22 (S18): the whole resume-by-message path, from the client side. The owner
// sends a message to an ended session; the bubble says the session is
// starting (never a bare "Queued"); the session's row and status events come
// over the live channel (`node_session` / `node_session_event` frames, the
// handlers bootstrap.ts wires to applyRow / applyEvent); then the resumed run's
// `user_message` and `command_applied` carrying the command id arrive the same
// way, and the bubble clears. Rules out a client live-update gap behind the
// owner's "stays Queued" report.

import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { resetNodesStore } from "~/modules/nodes/nodes-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import SessionView from "./SessionView"

// The composer's writing helpers read the API from context, as under the
// shell's ApiProvider; this runtime cannot record, so dictation stays hidden
// and the client is never called.
vi.mock("~/modules/shell/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/ApiContext")>()
  const client: Partial<ApiClient> = {}
  return { ...actual, useApi: () => client as ApiClient }
})

import type { NodeSessionRow } from "./session-api"
import { resetSessionCommands, setSessionCommandsApi } from "./session-commands"
import { applyEvent, applyRow, resetSessionStore, setSessionStoreApi } from "./session-store"

beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

const COMMAND = "00000000-0000-4000-8000-0000000000c1"

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
    level: "standard",
    status: "waiting",
    state: "needs_you",
    muted: false,
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 3,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: "Which branch should I push to?",
    error: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:05:00.000Z",
    updatedAt: "2026-10-15T10:05:00.000Z",
    ...over,
  }
}

function ev(seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>) {
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    type,
    payload,
  } as NodeSessionEvent
}

/** The server: the row and the event log it serves, which the test advances. */
function server() {
  const state = {
    row: row(),
    events: [
      ev(1, "user_message", { text: "Fix the flaky test" }),
      ev(2, "assistant_text", { text: "Fixed. Which branch should I push to?" }),
      ev(3, "status", { status: "needs_you", reason: "turn_ended" }),
    ],
  }
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/commands?open=1")) return { commands: [] }
    if (path.includes("/events?")) {
      const after = Number(new URL(path, "http://x").searchParams.get("after"))
      const out = state.events.filter((e) => e.seq > after)
      return { events: out, lastSeq: out.at(-1)?.seq ?? after }
    }
    if (path.includes("/nodes")) return { nodes: [] }
    return state.row
  })
  const post = vi.fn(async () => ({ commandId: COMMAND, seq: 1 }))
  setSessionStoreApi(() => ({ get }) as never)
  setSessionCommandsApi(() => ({ get, post }) as never)
  /** One frame over the live channel: the row changed, or one event appended. */
  const live = {
    row(over: Partial<NodeSessionRow>) {
      state.row = { ...state.row, ...over, lastSeq: state.events.length }
      applyRow(state.row)
    },
    event(type: NodeSessionEvent["type"], payload: Record<string, unknown>) {
      const e = ev(state.events.length + 1, type, payload)
      state.events.push(e)
      applyEvent({ sessionId: "s1", ownerUserId: "u1", ...e })
    },
  }
  return { post, live }
}

const bubble = () => document.querySelector(`[data-command-id="${COMMAND}"]`) as HTMLElement | null

afterEach(() => {
  resetSessionStore()
  resetSessionCommands()
  resetNodesStore()
  resetTabStore()
})

describe("D22: a message to an ended session, through the resume, over the live channel", () => {
  it("S18: send to an ended session, status events arrive, then user_message and command_applied clear the bubble", async () => {
    const { post, live } = server()
    render(() => <SessionView entityId="s1" />)
    const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement
    await waitFor(() => expect(screen.getAllByTestId("session-event").length).toBeGreaterThan(0))

    fireEvent.input(input, { target: { value: "Push to main" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(bubble()).not.toBeNull())
    expect(bubble()?.dataset.state).toBe("starting")
    expect(bubble()?.textContent).toContain("Starting the session…")

    // The server queues the resume run, the node claims it and starts the CLI.
    live.event("resumed", { after: "message" })
    live.event("status", { status: "queued" })
    live.row({ status: "queued", state: "queued", endedAt: null })
    live.event("status", { status: "running" })
    live.row({ status: "running", state: "running" })
    expect(bubble()?.dataset.state).toBe("starting")

    // The resumed run reads the message: user_message then command_applied.
    live.event("user_message", { text: "Push to main", commandId: COMMAND })
    live.event("command_applied", { commandId: COMMAND, type: "message", outcome: "applied" })
    await waitFor(() => expect(bubble()).toBeNull())
  })

  it("S18: a message sent mid-turn waits for the current step and clears on its user_message", async () => {
    const { live } = server()
    live.row({ status: "running", state: "running", endedAt: null })
    render(() => <SessionView entityId="s1" />)
    const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Also run the linter" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(bubble()).not.toBeNull())
    expect(bubble()?.dataset.state).toBe("waiting")
    expect(bubble()?.textContent).toContain("Waiting for the current step")
    live.event("tool_result", { id: "toolu_1", output: "ok" })
    expect(bubble()).not.toBeNull()
    live.event("user_message", { text: "Also run the linter", commandId: COMMAND })
    await waitFor(() => expect(bubble()).toBeNull())
  })
})
