// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T23 (C4, D40, K21, K22): a watched session's rows and events stay live
// from the socket and heal by pull. Events apply in seq order, a duplicate is
// dropped, a gap pulls after the last seq; a row frame whose lastSeq is above
// the store's pulls the tail a dropped frame lost; a reconnect pulls every
// watched session; each kept event carries when this client received it.
import type { NodeSessionEvent } from "@liaison/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import { requestResync } from "~/framework/resync"
import type { NodeSessionRow } from "./session-api"
import {
  applyEvent,
  applyRow,
  closeSubagent,
  FEED_WINDOW,
  installSessionStoreSync,
  openSubagent,
  resetSessionStore,
  sessionStore,
  setSessionStoreApi,
  TRIM_SLACK,
  watchSession,
} from "./session-store"

function event(seq: number, text = `step ${seq}`): NodeSessionEvent & { sessionId: string } {
  return {
    sessionId: "s1",
    seq,
    at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq * 1000 + 50).toISOString(),
    type: "assistant_text",
    payload: { text },
  }
}

function row(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  return {
    id: "s1",
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "dispatch",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    prompt: "Fix the flaky test",
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

/**
 * A server holding `events` for s1 (and s2), answering the T15 routes like the
 * API: `scope=top` and `parent=` filter and answer `through` (S53).
 */
function fakeServer(all: Record<string, NodeSessionEvent[]>, rows: Record<string, NodeSessionRow>) {
  const get = vi.fn(async (path: string) => {
    const m = /^\/me\/node-sessions\/([^/?]+)(\/events\?(.*))?$/.exec(path)
    if (!m) throw new Error(`unexpected path ${path}`)
    const id = decodeURIComponent(m[1])
    if (!m[2]) return rows[id]
    const q = new URLSearchParams(m[3])
    const after = Number(q.get("after"))
    const limit = Number(q.get("limit"))
    const parent = q.get("parent")
    const top = q.get("scope") === "top"
    const held = all[id] ?? []
    const lastSeq = held.at(-1)?.seq ?? 0
    const events = held
      .filter((e) => e.seq > after)
      .filter((e) => (parent ? e.parentToolUseId === parent : top ? !e.parentToolUseId : true))
      .slice(0, limit)
    if (!parent && !top) return { events, lastSeq }
    const last = events.at(-1)?.seq ?? after
    return { events, lastSeq, through: events.length === limit ? last : Math.max(lastSeq, last) }
  })
  return { get }
}

/** S53: an event of the subagent started by the Agent call `parent`. */
function subEvent(seq: number, parent: string): NodeSessionEvent & { sessionId: string } {
  return { ...event(seq, `${parent} step ${seq}`), parentToolUseId: parent }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  resetSessionStore()
})

describe("node session store", () => {
  it("events apply in seq order and a duplicate is dropped", async () => {
    const server = fakeServer({ s1: [] }, { s1: row() })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    applyEvent(event(1))
    applyEvent(event(2))
    applyEvent(event(2, "a re-sent copy"))
    applyEvent(event(1))
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 2])
    expect(sessionStore.events("s1")[1].payload.text).toBe("step 2")
    expect(sessionStore.lastSeq("s1")).toBe(2)
  })

  it("a gap pulls after lastSeq and fills it", async () => {
    const all = { s1: [event(1), event(2), event(3), event(4)] }
    const server = fakeServer({ s1: [] }, { s1: row() })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    applyEvent(all.s1[0])
    // The server now holds 1-4; frames 2 and 3 were dropped.
    server.get.mockImplementation(fakeServer(all, { s1: row({ lastSeq: 4 }) }).get)
    applyEvent(all.s1[3])
    await flush()
    await flush()
    expect(server.get).toHaveBeenCalledWith(
      "/me/node-sessions/s1/events?after=1&limit=500&scope=top",
    )
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it("watching loads the row and every event, page after page, until empty", async () => {
    const events = Array.from({ length: 501 }, (_, i) => event(i + 1))
    const server = fakeServer({ s1: events }, { s1: row({ lastSeq: 501 }) })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    expect(sessionStore.row("s1")?.title).toBe("Fix the flaky test")
    expect(sessionStore.events("s1")).toHaveLength(501)
    expect(server.get).toHaveBeenCalledWith(
      "/me/node-sessions/s1/events?after=500&limit=500&scope=top",
    )
  })

  it("reconnect pulls every watched session", async () => {
    const all: Record<string, NodeSessionEvent[]> = { s1: [], s2: [] }
    const rows = { s1: row(), s2: row({ id: "s2" }) }
    const server = fakeServer(all, rows)
    setSessionStoreApi(() => server as never)
    installSessionStoreSync()
    await watchSession("s1")
    await watchSession("s2")
    all.s1 = [event(1)]
    all.s2 = [{ ...event(1), sessionId: "s2" } as NodeSessionEvent]
    rows.s1 = row({ status: "done", lastSeq: 1 })
    requestResync("ws-reconnect")
    await flush()
    await flush()
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1])
    expect(sessionStore.events("s2").map((e) => e.seq)).toEqual([1])
    expect(sessionStore.row("s1")?.status).toBe("done")
  })

  it("a row frame whose lastSeq is above the store's pulls the missing tail", async () => {
    const all = { s1: [event(1), event(2), event(3)] }
    const server = fakeServer({ s1: [] }, { s1: row() })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    server.get.mockImplementation(fakeServer(all, { s1: row({ lastSeq: 3 }) }).get)
    // The events' own frames were all dropped; only the row frame arrived.
    applyRow(row({ lastSeq: 3, latestActivity: "Running the tests" }))
    expect(sessionStore.row("s1")?.latestActivity).toBe("Running the tests")
    await flush()
    await flush()
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it("each kept event carries clientReceivedAt", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_123_456)
    try {
      const server = fakeServer({ s1: [] }, { s1: row() })
      setSessionStoreApi(() => server as never)
      await watchSession("s1")
      applyEvent(event(1))
      expect(sessionStore.events("s1")[0].clientReceivedAt).toBe(1_800_000_123_456)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("a session nobody watches keeps its row, not its events", () => {
    applyRow(row({ id: "s9", lastSeq: 7 }))
    applyEvent({ ...event(8), sessionId: "s9" })
    expect(sessionStore.row("s9")?.lastSeq).toBe(7)
    expect(sessionStore.events("s9")).toEqual([])
  })

  it("a row frame without the prompt keeps the prompt a GET brought (P1a S6)", () => {
    applyRow(row({ id: "s8", prompt: "Fix the flaky test", lastSeq: 1 }))
    const { prompt: _omitted, ...frame } = row({ id: "s8", lastSeq: 2, status: "waiting" })
    applyRow(frame)
    expect(sessionStore.row("s8")).toMatchObject({
      prompt: "Fix the flaky test",
      lastSeq: 2,
      status: "waiting",
    })
  })
  it("S53: a session with 10 running subagents keeps no subagent events in the store until one is expanded", async () => {
    // Top-level 1, then ten subagents' events interleaved, then top-level 32.
    const all: NodeSessionEvent[] = [event(1)]
    for (let i = 0; i < 30; i++) all.push(subEvent(i + 2, `tu_${i % 10}`))
    all.push(event(32))
    const server = fakeServer({ s1: all }, { s1: row({ lastSeq: 32 }) })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 32])
    expect(sessionStore.lastSeq("s1")).toBe(32)
    // A live subagent frame (an older API still sends them) is not kept either.
    applyEvent(subEvent(33, "tu_3"))
    expect(sessionStore.events("s1").every((e) => !e.parentToolUseId)).toBe(true)
    // The subagents' tail moved the store past it: the next top-level frame appends.
    all.push(subEvent(33, "tu_3"), subEvent(34, "tu_4"))
    applyRow(row({ lastSeq: 34 }))
    await flush()
    await flush()
    expect(sessionStore.lastSeq("s1")).toBe(34)
    applyEvent(event(35))
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 32, 35])
    expect(sessionStore.subagentEvents("s1", "tu_3")).toEqual([])
  })

  it("S56: an open drawer holds its subagent in a bounded window, appended in place, never copied per batch", async () => {
    const all: NodeSessionEvent[] = [event(1)]
    for (let seq = 2; seq <= 3_000; seq++) all.push(subEvent(seq, "tu_a"))
    const server = fakeServer({ s1: all }, { s1: row({ lastSeq: 3_000 }) })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    await openSubagent("s1", "tu_a")
    const held = sessionStore.subagentEvents("s1", "tu_a")
    expect(held.length).toBeLessThanOrEqual(FEED_WINDOW + TRIM_SLACK)
    expect(held.at(-1)?.seq).toBe(3_000)
    // The next batch lands in the same array (no whole-array copy).
    all.push(subEvent(3_001, "tu_a"))
    applyRow(row({ lastSeq: 3_001 }))
    await flush()
    await flush()
    expect(sessionStore.subagentEvents("s1", "tu_a")).toBe(held)
    expect(held.at(-1)?.seq).toBe(3_001)
    expect(held.length).toBeLessThanOrEqual(FEED_WINDOW + TRIM_SLACK)
  })

  it("S53: expanding a subagent fetches its events with parent=<id> and collapsing releases them", async () => {
    const all: NodeSessionEvent[] = [event(1), subEvent(2, "tu_a"), subEvent(3, "tu_b")]
    all.push(subEvent(4, "tu_a"))
    const server = fakeServer({ s1: all }, { s1: row({ lastSeq: 4 }) })
    setSessionStoreApi(() => server as never)
    await watchSession("s1")
    expect(server.get.mock.calls.some(([p]) => String(p).includes("parent="))).toBe(false)

    await openSubagent("s1", "tu_a")
    expect(server.get).toHaveBeenCalledWith(
      "/me/node-sessions/s1/events?after=0&limit=500&parent=tu_a",
    )
    expect(sessionStore.subagentEvents("s1", "tu_a").map((e) => e.seq)).toEqual([2, 4])
    // Streamed while open: the row moving on pulls the subagent's new events.
    all.push(subEvent(5, "tu_a"))
    applyRow(row({ lastSeq: 5 }))
    await flush()
    await flush()
    expect(sessionStore.subagentEvents("s1", "tu_a").map((e) => e.seq)).toEqual([2, 4, 5])

    closeSubagent("s1", "tu_a")
    expect(sessionStore.subagentEvents("s1", "tu_a")).toEqual([])
    // Closed: the row moving on fetches nothing for it any more.
    server.get.mockClear()
    all.push(subEvent(6, "tu_a"))
    applyRow(row({ lastSeq: 6 }))
    await flush()
    await flush()
    expect(server.get.mock.calls.some(([p]) => String(p).includes("parent="))).toBe(false)
    expect(sessionStore.subagentEvents("s1", "tu_a")).toEqual([])
  })
})

describe("an import deleted from Liaison (W3, A49)", () => {
  it("A49: the deleted frame drops the row from the store and leaves the others", () => {
    applyRow(row({ id: "s1", source: "import", importMode: "follow" }))
    applyRow(row({ id: "s2" }))
    expect(sessionStore.row("s1")?.id).toBe("s1")
    applyRow({ ownerUserId: "u1", sessionId: "s1", deleted: true })
    expect(sessionStore.row("s1")).toBeUndefined()
    expect(sessionStore.rows().map((r) => r.id)).toEqual(["s2"])
  })
})
