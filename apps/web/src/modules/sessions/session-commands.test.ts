// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T11: the web side of steering. A command is validated before any
// request, posted, and held as pending until the session's own events show it
// landed: a `user_message` or `command_applied` carrying its id. A message
// cancelled by a Stop shows as not delivered. After a reload the open
// commands come back from the server. D22: a held message says its true
// phase: "Starting the session…" while a resume for it is in flight, "Waiting
// for the current step" while a turn runs; never a bare "Queued".
import type { NodeSessionEvent } from "@liaison/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NodeSessionRow } from "./session-api"
import {
  answer,
  approvePlan,
  decide,
  isRequestPending,
  keepPlanning,
  markDone,
  openCommands,
  pendingCommands,
  queuedMessages,
  resetSessionCommands,
  sendCommand,
  sendMessage,
  setMuted,
  setSessionCommandsApi,
  stopSession,
} from "./session-commands"
import {
  applyEvent,
  applyRow,
  resetSessionStore,
  sessionStore,
  setSessionStoreApi,
  watchSession,
} from "./session-store"

const ID = "11111111-2222-4333-8444-555555555555"

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: ID,
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
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...over,
  }
}

let seq = 0
function event(type: NodeSessionEvent["type"], payload: Record<string, unknown>) {
  seq++
  return {
    sessionId: ID,
    ownerUserId: "u1",
    seq,
    at: new Date(1_800_000_000_000 + seq).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq).toISOString(),
    type,
    payload,
  }
}

function fakeApi(open: unknown[] = [], served: Partial<NodeSessionRow> = {}) {
  let n = 0
  const post = vi.fn(async (_path: string, _body?: unknown) => {
    n++
    return { commandId: `00000000-0000-4000-8000-00000000000${n}`, seq: n }
  })
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/commands?open=1")) return { commands: open }
    if (path.includes("/events?")) return { events: [], lastSeq: 0 }
    return row(served)
  })
  const patch = vi.fn(async (_path: string, body?: unknown) => ({
    ...row(served),
    ...(body as object),
  }))
  return { post, get, patch }
}

beforeEach(async () => {
  seq = 0
  resetSessionStore()
  resetSessionCommands()
})
afterEach(() => {
  resetSessionStore()
  resetSessionCommands()
})

async function watched(api: ReturnType<typeof fakeApi>) {
  setSessionStoreApi(() => api as never)
  setSessionCommandsApi(() => api as never)
  await watchSession(ID)
}

describe("session commands (P3-T11)", () => {
  it("sendMessage posts the command and the message shows as queued", async () => {
    const api = fakeApi()
    await watched(api)
    const { commandId } = await sendMessage(ID, "Also list the .claude folder")
    expect(api.post).toHaveBeenCalledWith(`/me/node-sessions/${ID}/commands`, {
      type: "message",
      payload: { text: "Also list the .claude folder" },
    })
    expect(queuedMessages(ID)).toEqual([
      { commandId, text: "Also list the .claude folder", state: "waiting" },
    ])
  })

  it("a user_message with its commandId removes it from queued", async () => {
    const api = fakeApi()
    await watched(api)
    const { commandId } = await sendMessage(ID, "one")
    const other = await sendMessage(ID, "two")
    applyEvent(event("user_message", { text: "one", commandId }))
    expect(queuedMessages(ID).map((m) => m.commandId)).toEqual([other.commandId])
    applyEvent(
      event("command_applied", { commandId: other.commandId, type: "message", outcome: "applied" }),
    )
    expect(queuedMessages(ID)).toEqual([])
  })

  it("a command_applied cancelled shows it as not delivered", async () => {
    const api = fakeApi()
    await watched(api)
    const { commandId } = await sendMessage(ID, "never read")
    applyEvent(event("command_applied", { commandId, type: "message", outcome: "cancelled" }))
    expect(queuedMessages(ID)).toEqual([{ commandId, text: "never read", state: "cancelled" }])
    // The next command clears the not-delivered line.
    await sendMessage(ID, "again")
    expect(queuedMessages(ID).map((m) => m.text)).toEqual(["again"])
  })

  it("an invalid payload is refused before any request", async () => {
    const api = fakeApi()
    await watched(api)
    await expect(sendMessage(ID, "")).rejects.toMatchObject({ status: 400 })
    await expect(
      sendCommand(ID, { type: "set_level", payload: { level: "root" } } as never),
    ).rejects.toMatchObject({ status: 400 })
    expect(api.post).not.toHaveBeenCalled()
    expect(pendingCommands(ID)).toEqual([])
  })

  it("openCommands seeds the queue after a reload", async () => {
    const api = fakeApi([
      {
        commandId: "c-1",
        seq: 4,
        type: "message",
        payload: { text: "queued before the reload" },
        ackedAt: null,
        outcome: null,
      },
      {
        commandId: "c-2",
        seq: 5,
        type: "permission_decision",
        payload: { requestId: "r1", allow: true, scope: "once" },
        ackedAt: null,
        outcome: null,
      },
    ])
    await watched(api)
    await openCommands(ID)
    expect(api.get).toHaveBeenCalledWith(`/me/node-sessions/${ID}/commands?open=1`)
    expect(queuedMessages(ID)).toEqual([
      { commandId: "c-1", text: "queued before the reload", state: "waiting" },
    ])
    expect(isRequestPending(ID, "r1")).toBe(true)
    expect(isRequestPending(ID, "r2")).toBe(false)
  })

  it("D22: a message sent mid-turn is waiting for the current step until it lands", async () => {
    const api = fakeApi()
    await watched(api)
    const { commandId } = await sendMessage(ID, "also check the logs")
    expect(queuedMessages(ID).map((m) => m.state)).toEqual(["waiting"])
    applyEvent(event("user_message", { text: "also check the logs", commandId }))
    expect(queuedMessages(ID)).toEqual([])
  })

  it("D22: a message to an ended session is starting the session until it lands, through the resume", async () => {
    for (const status of ["done", "needs_you", "stopped", "failed"] as const) {
      seq = 0
      resetSessionStore()
      resetSessionCommands()
      const ended = { status: status === "needs_you" ? "waiting" : status, state: status } as const
      const api = fakeApi([], { ...ended, endedAt: "2026-10-13T10:05:00.000Z" })
      await watched(api)
      const { commandId } = await sendMessage(ID, "continue")
      expect(queuedMessages(ID).map((m) => m.state)).toEqual(["starting"])
      // The resume: queued, then running while the node starts the CLI; still starting.
      applyRow(row({ status: "queued", state: "queued" }))
      expect(queuedMessages(ID).map((m) => m.state)).toEqual(["starting"])
      applyRow(row({ status: "running", state: "running" }))
      expect(queuedMessages(ID).map((m) => m.state)).toEqual(["starting"])
      applyEvent(event("command_applied", { commandId, type: "message", outcome: "applied" }))
      expect(queuedMessages(ID)).toEqual([])
    }
  })

  it("D22: after a reload a message held for an ended or queued session reads as starting", async () => {
    const open = [{ commandId: "c-1", seq: 4, type: "message", payload: { text: "go on" } }]
    const api = fakeApi(open, { status: "queued", state: "queued" })
    await watched(api)
    await openCommands(ID)
    expect(queuedMessages(ID).map((m) => m.state)).toEqual(["starting"])
    // Running while the node starts the CLI: the resume is still in flight for it.
    applyRow(row({ status: "running", state: "running" }))
    expect(queuedMessages(ID).map((m) => m.state)).toEqual(["starting"])
  })

  it("S7: markDone posts mark_done, with the summary when given", async () => {
    const api = fakeApi()
    await watched(api)
    await markDone(ID)
    await markDone(ID, "Shipped in #12")
    expect(api.post.mock.calls.map((c) => c[1])).toEqual([
      { type: "mark_done", payload: {} },
      { type: "mark_done", payload: { summary: "Shipped in #12" } },
    ])
  })

  it("S14: setMuted patches the row and keeps the answer", async () => {
    const api = fakeApi()
    await watched(api)
    await setMuted(ID, true)
    expect(api.patch).toHaveBeenCalledWith(`/me/node-sessions/${ID}`, { muted: true })
    expect(sessionStore.row(ID)?.muted).toBe(true)
  })

  it("stop, decisions, answers and plan approval post their commands", async () => {
    const api = fakeApi()
    await watched(api)
    await stopSession(ID)
    await decide(ID, "r1", true, "session")
    await answer(ID, "q1", { "A or B?": "B" })
    await approvePlan(ID, "p1")
    await keepPlanning(ID, "p2")
    expect(api.post.mock.calls.map((c) => c[1])).toEqual([
      { type: "stop", payload: {} },
      { type: "permission_decision", payload: { requestId: "r1", allow: true, scope: "session" } },
      { type: "answer", payload: { requestId: "q1", answers: { "A or B?": "B" } } },
      { type: "permission_decision", payload: { requestId: "p1", allow: true, scope: "once" } },
      { type: "permission_decision", payload: { requestId: "p2", allow: false, scope: "once" } },
    ])
    expect(isRequestPending(ID, "r1")).toBe(true)
    applyEvent(
      event("command_applied", {
        commandId: "00000000-0000-4000-8000-000000000002",
        type: "permission_decision",
        outcome: "applied",
      }),
    )
    expect(isRequestPending(ID, "r1")).toBe(false)
  })
})
