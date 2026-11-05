// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S56 (owner D30): the Sessions view's memory stays bounded on a long running
// session. The store holds a recent window of the main thread outside Solid's
// store (no copy per frame), folds what no transcript line comes from (usage,
// task_progress), elides old large outputs to a stub read again on demand,
// loads older history on request; the transcript is updated per event, not
// rebuilt; the header figures are folded once per event, not rescanned per tick.

import type { NodeSessionEvent } from "@liaison/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import { syntheticSession } from "./__fixtures__/synthetic-session"
import { cacheState, context, driver, subagents } from "./header-info"
import {
  applyEvent,
  fetchEventInput,
  fetchEventOutput,
  loadEarlier,
  resetSessionStore,
  sessionStore,
  setSessionStoreApi,
  unwatchSession,
  watchSession,
} from "./session-store"
import * as transcript from "./transcript"
import { buildTranscript, latestPlan, pendingRequests, startCwd } from "./transcript"

type Frame = NodeSessionEvent & { sessionId: string }

const T0 = Date.parse("2026-10-15T12:00:00.000Z")
const ctx = { cwd: "/home/me/code", folderName: "code", sessionId: "s1", repo: null }
const opts = { sessionStatus: "running", pathContext: ctx }

function ev(seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>): Frame {
  const at = new Date(T0 + seq * 1000).toISOString()
  return { sessionId: "s1", seq, at, receivedAt: at, type, payload } as Frame
}
const text = (seq: number) => ev(seq, "assistant_text", { text: `step ${seq}` })

/** A server answering the event reads like the API (after/before, scope=top, limit). */
function server(all: Frame[] = []) {
  const get = vi.fn(async (path: string) => {
    const m = /^\/me\/node-sessions\/([^/?]+)(\/events\?(.*))?$/.exec(path)
    if (!m) throw new Error(`unexpected path ${path}`)
    if (!m[2]) return { id: "s1", status: "running", lastSeq: 0, folderName: "code", repo: null }
    const q = new URLSearchParams(m[3])
    const limit = Number(q.get("limit"))
    const lastSeq = all.at(-1)?.seq ?? 0
    if (q.has("before")) {
      const before = Number(q.get("before"))
      return { events: all.filter((e) => e.seq < before).slice(-limit), lastSeq }
    }
    const after = Number(q.get("after"))
    const events = all.filter((e) => e.seq > after).slice(0, limit)
    return { events, lastSeq, through: events.length === limit ? events.at(-1)?.seq : lastSeq }
  })
  return { get }
}

async function watched(all: Frame[] = []) {
  const api = server(all)
  setSessionStoreApi(() => api as never)
  await watchSession("s1")
  return api
}

/** An array that counts reads of its elements. */
function counted<T>(list: T[]): { list: T[]; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  return { list: proxy, reads: () => reads }
}

afterEach(() => resetSessionStore())

describe("S56: bounded session memory", () => {
  it("S56: the store holds a bounded window after 50,000 events, and knows older ones exist", async () => {
    await watched()
    for (let seq = 1; seq <= 50_000; seq++) applyEvent(text(seq))
    const held = sessionStore.events("s1")
    expect(held.length).toBeLessThanOrEqual(2_200)
    expect(held.length).toBeGreaterThanOrEqual(2_000)
    expect(held.at(-1)?.seq).toBe(50_000)
    expect(sessionStore.lastSeq("s1")).toBe(50_000)
    expect(sessionStore.received("s1")).toBe(50_000)
    expect(sessionStore.hasEarlier("s1")).toBe(true)
  })

  it("S56: a task's progress events are compacted to its latest figures and usage folds into totals", async () => {
    await watched()
    let seq = 0
    applyEvent(
      ev(++seq, "tool_call", {
        id: "toolu_a",
        name: "Agent",
        input: { description: "Scan", model: "haiku" },
      }),
    )
    applyEvent(
      ev(++seq, "system", {
        subtype: "task_started",
        data: { taskId: "t1", toolUseId: "toolu_a", description: "Scan", taskType: "local_agent" },
      }),
    )
    for (let i = 1; i <= 1_000; i++) {
      applyEvent(
        ev(++seq, "system", {
          subtype: "task_progress",
          data: { taskId: "t1", toolUses: i, lastToolName: i % 2 ? "Read" : "Grep" },
        }),
      )
      applyEvent(
        ev(++seq, "usage", {
          cacheRead: 10,
          cacheWrite5m: 0,
          cacheWrite1h: 5,
          contextTokens: 1000 + i,
        }),
      )
    }
    applyEvent(ev(++seq, "result", { text: "ok", subtype: "success", contextWindow: 200_000 }))
    const held = sessionStore.events("s1")
    const progress = held.filter(
      (e) => e.type === "system" && e.payload.subtype === "task_progress",
    )
    expect(progress.length).toBeLessThanOrEqual(1)
    expect(held.filter((e) => e.type === "usage")).toEqual([])
    expect(held.length).toBeLessThan(10)
    // The figures are the latest ones all the same.
    const now = T0 + seq * 1000
    const sub = subagents(held, now).list[0]
    expect([sub.toolUses, sub.lastToolName, sub.model, sub.description]).toEqual([
      1_000,
      "Grep",
      "haiku",
      "Scan",
    ])
    expect(context(held)).toEqual({ tokens: 2_000, window: 200_000, percent: 1 })
    const cache = cacheState(held, now)
    expect(cache.state === "warm" && cache.ttl).toBe("1h")
  })

  it("S56: a frame appends in place: the held array is never copied", async () => {
    await watched()
    for (let seq = 1; seq <= 10; seq++) applyEvent(text(seq))
    const before = sessionStore.events("s1")
    applyEvent(text(11))
    const after = sessionStore.events("s1")
    expect(after).toBe(before)
    expect(after.length).toBe(11)
    expect(after[10].seq).toBe(11)
  })

  it("S56: the transcript appends per event instead of rebuilding, and unchanged items keep their identity", () => {
    const Model = (transcript as { TranscriptModel?: new () => transcript.TranscriptModel })
      .TranscriptModel
    expect(Model).toBeTypeOf("function")
    const model = new (Model as new () => transcript.TranscriptModel)()
    const events: NodeSessionEvent[] = []
    for (let seq = 1; seq <= 1_000; seq++) events.push(text(seq))
    events.push(ev(1_001, "tool_call", { id: "toolu_1", name: "Bash", input: { command: "ls" } }))
    const first = model.sync(events, opts)
    const item0 = first[0]
    const call = first.at(-1)
    for (let seq = 1_002; seq <= 1_200; seq++) {
      events.push(
        seq === 1_002 ? ev(seq, "tool_result", { id: "toolu_1", output: "a\nb" }) : text(seq),
      )
      model.sync(events, opts)
    }
    const items = model.sync(events, opts)
    expect(model.rebuilds).toBe(1)
    expect(model.processed).toBe(1_200)
    expect(items[0]).toBe(item0)
    // The call's item was replaced by its result, the others left alone.
    const tool = items[1_000]
    expect(tool).not.toBe(call)
    expect(tool.kind === "tool" && tool.result?.output).toBe("a\nb")
    // Same items as a build from scratch.
    expect(items).toEqual(buildTranscript(events, opts))
  })

  it("S56: synced per event over an hour-like session, the transcript equals a full build", () => {
    const model = new transcript.TranscriptModel()
    const events: NodeSessionEvent[] = []
    const extra: NodeSessionEvent[] = [
      ev(0, "status", { status: "running" }),
      ev(0, "permission_request", { requestId: "r1", tool: "Bash", input: { command: "rm x" } }),
      ev(0, "decision", { requestId: "r1", outcome: "allow", by: "owner" }),
      ev(0, "result", { text: "turn", subtype: "success" }),
      ev(0, "result", { text: "end", subtype: "success" }),
      ev(0, "status", { status: "queued" }),
      ev(0, "status", { status: "running" }),
      ev(0, "result", { text: "again", subtype: "success" }),
    ]
    let k = 0
    for (const e of syntheticSession({ events: 3_000 })) {
      const { sessionId: _s, ...rest } = e
      events.push(rest)
      if (e.seq % 300 === 0 && k < extra.length) {
        events.push({ ...extra[k++], seq: e.seq + 0.5 })
      }
      model.sync(events, opts)
    }
    expect(model.rebuilds).toBe(1)
    expect(model.sync(events, opts)).toEqual(buildTranscript(events, opts))
  })

  it("S56: the transcript follows the store's window as it trims, without rebuilding", async () => {
    await watched()
    const model = new transcript.TranscriptModel()
    for (let seq = 1; seq <= 5_000; seq++) {
      applyEvent(text(seq))
      if (seq % 10 === 0) model.sync(sessionStore.events("s1"), opts)
    }
    const items = model.sync(sessionStore.events("s1"), opts)
    expect(model.rebuilds).toBe(1)
    expect(items.map((i) => i.seq)).toEqual(sessionStore.events("s1").map((e) => e.seq))
  })

  it("S56: header figures fold each event once; ticking the clock rescans nothing", () => {
    const all = [...syntheticSession({ events: 3_000 })].map(({ sessionId: _s, ...e }) => e)
    const { list, reads } = counted(all as NodeSessionEvent[])
    for (let tick = 0; tick < 60; tick++) {
      const now = T0 + 3_000 * 120 + tick * 1000
      subagents(list, now)
      cacheState(list, now)
      context(list)
      driver(list)
      pendingRequests(list)
      latestPlan(list, ctx)
      startCwd(list)
    }
    expect(reads()).toBeLessThan(2 * all.length)
    expect(subagents(list, T0).list).toHaveLength(10)
  })

  it("S56: an old large output is elided to a stub, the transcript follows, and the row reads it again by seq", async () => {
    const big = "line of output\n".repeat(2_000)
    const all: Frame[] = [
      ev(1, "tool_call", { id: "toolu_big", name: "Bash", input: { command: "cat log" } }),
      ev(2, "tool_result", { id: "toolu_big", output: big }),
    ]
    for (let seq = 3; seq <= 400; seq++) all.push(text(seq))
    const api = await watched()
    const model = new transcript.TranscriptModel()
    applyEvent(all[0])
    applyEvent(all[1])
    const fresh = model.sync(sessionStore.events("s1"), opts)[0]
    expect(fresh.kind === "tool" && fresh.result?.output).toBe(big)
    for (const e of all.slice(2)) applyEvent(e)
    const held = sessionStore.events("s1").find((e) => e.seq === 2)
    expect(held?.payload.output).toBe("")
    const item = model.sync(sessionStore.events("s1"), opts)[0]
    expect(model.rebuilds).toBe(1)
    expect(item.kind === "tool" && item.result?.output).toBe("")
    expect(item.kind === "tool" && item.result?.elided).toMatchObject({ seq: 2, lines: 2_000 })
    expect(item.kind === "tool" && transcript.toolMeta(item).lines).toBe(2_000)
    // The row opened: one event read again by its seq.
    api.get.mockImplementation(server(all).get)
    expect(await fetchEventOutput("s1", 2)).toBe(big)
    expect(api.get).toHaveBeenLastCalledWith(
      "/me/node-sessions/s1/events?after=1&limit=1&scope=top",
    )
  })

  it("S56: an old large tool input is elided to a stub that keeps its short fields, the transcript follows, and the row reads it again by seq", async () => {
    const content = "a line of the new file\n".repeat(1_000)
    const input = { file_path: "/home/me/code/notes.md", content }
    const all: Frame[] = [ev(1, "tool_call", { id: "toolu_w", name: "Write", input })]
    all.push(ev(2, "tool_result", { id: "toolu_w", output: "ok" }))
    for (let seq = 3; seq <= 400; seq++) all.push(text(seq))
    const api = await watched()
    const model = new transcript.TranscriptModel()
    applyEvent(all[0])
    applyEvent(all[1])
    const fresh = model.sync(sessionStore.events("s1"), opts)[0]
    expect(fresh.kind === "tool" && fresh.input).toEqual(input)
    for (const e of all.slice(2)) applyEvent(e)
    const held = sessionStore.events("s1").find((e) => e.seq === 1)
    expect(held?.payload.input).toEqual({ file_path: "/home/me/code/notes.md", content: "" })
    const item = model.sync(sessionStore.events("s1"), opts)[0]
    expect(model.rebuilds).toBe(1)
    expect(item.kind === "tool" && item.inputElided).toMatchObject({ seq: 1 })
    expect(item.kind === "tool" && item.argument).toBe("notes.md")
    // The row opened: one event read again by its seq.
    api.get.mockImplementation(server(all).get)
    expect(await fetchEventInput("s1", 1)).toEqual(input)
    expect(api.get).toHaveBeenLastCalledWith(
      "/me/node-sessions/s1/events?after=0&limit=1&scope=top",
    )
  })

  it("S56: a drawer's elided output is read again with its subagent's parent, not scope=top", async () => {
    const api = await watched()
    api.get.mockImplementation((async () => ({
      events: [
        {
          seq: 7,
          at: new Date(T0).toISOString(),
          type: "tool_result",
          payload: { id: "c1", output: "full" },
          parentToolUseId: "tu_a",
        },
      ],
      lastSeq: 7,
    })) as never)
    expect(await fetchEventOutput("s1", 7, "tu_a")).toBe("full")
    expect(api.get).toHaveBeenLastCalledWith(
      "/me/node-sessions/s1/events?after=6&limit=1&parent=tu_a",
    )
  })

  it("S56: load earlier reads below the oldest held seq and adds that page in front", async () => {
    const all: Frame[] = []
    for (let seq = 1; seq <= 3_000; seq++) all.push(text(seq))
    const api = await watched()
    for (const e of all) applyEvent(e)
    const first = sessionStore.events("s1")[0].seq
    expect(first).toBeGreaterThan(500)
    api.get.mockImplementation(server(all).get)
    await loadEarlier("s1")
    expect(api.get).toHaveBeenLastCalledWith(
      `/me/node-sessions/s1/events?before=${first}&limit=500&scope=top`,
    )
    const held = sessionStore.events("s1")
    expect(held[0].seq).toBe(first - 500)
    expect(held.map((e) => e.seq)).toEqual(
      Array.from({ length: 3_000 - first + 501 }, (_, i) => first - 500 + i),
    )
    expect(sessionStore.hasEarlier("s1")).toBe(first - 500 > 1)
  })

  it("S56 (F4): load earlier advances page by page to the start of the session, never re-reading a page", async () => {
    const all: Frame[] = []
    for (let seq = 1; seq <= 3_000; seq++) all.push(text(seq))
    const api = await watched()
    for (const e of all) applyEvent(e)
    const first = sessionStore.events("s1")[0].seq
    api.get.mockImplementation(server(all).get)
    const expected: string[] = []
    for (let before = first; before > 1; before -= 500) {
      expected.push(`/me/node-sessions/s1/events?before=${before}&limit=500&scope=top`)
    }
    for (let i = 0; i < 10 && sessionStore.hasEarlier("s1"); i++) await loadEarlier("s1")
    const reads = api.get.mock.calls.map((c) => c[0]).filter((p) => p.includes("before="))
    expect(reads).toEqual(expected)
    const seqs = sessionStore.events("s1").map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 3_000 }, (_, i) => i + 1))
    // The last page was short: the start of the session, nothing earlier.
    expect(sessionStore.hasEarlier("s1")).toBe(false)
  })

  it("S56: closing the view drops the session's window", async () => {
    await watched()
    for (let seq = 1; seq <= 100; seq++) applyEvent(text(seq))
    unwatchSession("s1")
    expect(sessionStore.events("s1")).toEqual([])
    expect(sessionStore.lastSeq("s1")).toBe(0)
  })
})

/** A promise and its resolver. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A server whose first read matching `park` waits until released. */
function parkedServer(all: Frame[], park: (path: string) => boolean) {
  const base = server(all)
  const reached = deferred()
  const release = deferred()
  let parked = false
  const get = vi.fn(async (path: string) => {
    if (!parked && park(path)) {
      parked = true
      reached.resolve()
      await release.promise
    }
    return base.get(path)
  })
  return { api: { get }, reached: reached.promise, release: release.resolve }
}

const isContiguous = (seqs: number[]) => seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)

describe("D33: a watch generation closes the reopen and load-earlier races", () => {
  it("D33 (F1): a view closed and reopened while its first pull is mid-way holds the session from seq 1, its pending request included", async () => {
    const all: Frame[] = [
      ev(1, "permission_request", { requestId: "r1", tool: "Bash", input: { command: "rm x" } }),
    ]
    for (let seq = 2; seq <= 1_200; seq++) all.push(text(seq))
    const { api, reached, release } = parkedServer(all, (p) => /[?&]after=500&/.test(p))
    setSessionStoreApi(() => api as never)
    const firstView = watchSession("s1")
    await reached
    // The owner closes the tab with page 2 (after=500) in flight, and opens it again.
    unwatchSession("s1")
    const secondView = watchSession("s1")
    release()
    await Promise.all([firstView, secondView])
    await vi.waitFor(() => expect(sessionStore.lastSeq("s1")).toBe(1_200))
    const seqs = sessionStore.events("s1").map((e) => e.seq)
    expect(seqs[0]).toBe(1)
    expect(seqs).toHaveLength(1_200)
    expect(isContiguous(seqs)).toBe(true)
    expect(pendingRequests(sessionStore.events("s1")).map((r) => r.requestId)).toEqual(["r1"])
  })

  it("D33 (F1): two views of one session: closing one keeps the other's window live", async () => {
    await watched()
    await watchSession("s1")
    for (let seq = 1; seq <= 10; seq++) applyEvent(text(seq))
    unwatchSession("s1")
    expect(sessionStore.events("s1")).toHaveLength(10)
    applyEvent(text(11))
    expect(
      sessionStore
        .events("s1")
        .map((e) => e.seq)
        .at(-1),
    ).toBe(11)
    unwatchSession("s1")
    expect(sessionStore.events("s1")).toEqual([])
  })
  it("D33 (F2): load earlier racing a live trim never leaves a gap: the moved page is discarded and read again", async () => {
    const all: Frame[] = []
    for (let seq = 1; seq <= 3_400; seq++) all.push(text(seq))
    await watched()
    for (const e of all.slice(0, 3_000)) applyEvent(e)
    const first = sessionStore.events("s1")[0].seq
    const { api, reached, release } = parkedServer(all, (p) => p.includes("before="))
    setSessionStoreApi(() => api as never)
    const loading = loadEarlier("s1")
    await reached
    // 400 live events arrive while the read is in flight: the window trims its front.
    for (const e of all.slice(3_000)) applyEvent(e)
    const moved = sessionStore.events("s1")[0].seq
    expect(moved).toBeGreaterThan(first)
    release()
    await loading
    const seqs = sessionStore.events("s1").map((e) => e.seq)
    expect(isContiguous(seqs)).toBe(true)
    expect(seqs.at(-1)).toBe(3_400)
    expect(seqs[0]).toBe(moved - 500)
    const reads = api.get.mock.calls.map((c) => c[0]).filter((p) => p.includes("before="))
    expect(reads).toEqual([
      `/me/node-sessions/s1/events?before=${first}&limit=500&scope=top`,
      `/me/node-sessions/s1/events?before=${moved}&limit=500&scope=top`,
    ])
  })

  it("D33 (F2): a load-earlier page from a previous watch is discarded, and the new watch reads its own", async () => {
    const all: Frame[] = []
    for (let seq = 1; seq <= 3_000; seq++) all.push(text(seq))
    await watched()
    for (const e of all) applyEvent(e)
    const { api, reached, release } = parkedServer(all, (p) => p.includes("before="))
    setSessionStoreApi(() => api as never)
    const stale = loadEarlier("s1")
    await reached
    unwatchSession("s1")
    await watchSession("s1")
    const first = sessionStore.events("s1")[0].seq
    expect(first).toBeGreaterThan(500)
    const fresh = loadEarlier("s1")
    release()
    await Promise.all([stale, fresh])
    const seqs = sessionStore.events("s1").map((e) => e.seq)
    expect(seqs[0]).toBe(first - 500)
    expect(seqs.at(-1)).toBe(3_000)
    expect(isContiguous(seqs)).toBe(true)
    expect(api.get.mock.calls.filter((c) => c[0].includes("before="))).toHaveLength(2)
  })
})
