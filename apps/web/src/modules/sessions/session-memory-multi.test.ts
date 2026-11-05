// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S58 (owner D34): several sessions open at once. A view hidden for
// RELEASE_AFTER_MS lets its events go and reads them back when shown (the
// disk cache first, then the server); one byte budget spans every session's
// held events and never touches the session on screen or an open request;
// the disk cache serves a revisit and a stub without the network, and the
// app works without IndexedDB.

import type { NodeSessionEvent } from "@liaison/shared"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  _resetDiskCache,
  diskCache,
  diskCacheAvailable,
  flushDiskCache,
  setDiskCacheOwner,
} from "./session-disk-cache"
import {
  applyEvent,
  applyRow,
  ELIDE_MIN_CHARS,
  fetchEventOutput,
  fetchEventText,
  hideSession,
  MEMORY_BUDGET_BYTES,
  openSubagent,
  RELEASE_AFTER_MS,
  resetSessionData,
  resetSessionStore,
  retryReadBack,
  SCREEN_KEEP,
  sessionStore,
  setSessionStoreApi,
  settleSession,
  showSession,
  watchSession,
} from "./session-store"
import { pendingRequests, TranscriptModel } from "./transcript"

type Frame = NodeSessionEvent & { sessionId: string }

const T0 = Date.parse("2026-10-15T12:00:00.000Z")

function ev(
  sessionId: string,
  seq: number,
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  over: Partial<NodeSessionEvent> = {},
): Frame {
  const at = new Date(T0 + seq * 1000).toISOString()
  return { sessionId, seq, at, receivedAt: at, type, payload, ...over } as Frame
}

const BIG = "a line of build output\n".repeat(600)
const LONG = "A long explanation of the change. ".repeat(400)

/** An hour-like main thread in miniature: text, tools with large outputs, a pending request, subagent events. */
function sessionEvents(sessionId: string, n: number): Frame[] {
  const out: Frame[] = [
    ev(sessionId, 1, "system", { subtype: "start", text: "", data: { cwd: "/home/me/code" } }),
    ev(sessionId, 2, "user_message", { text: "Fix the build" }),
  ]
  let seq = 2
  while (seq < n) {
    const k = seq
    out.push(
      ev(sessionId, ++seq, "assistant_text", { text: (k - 2) % 25 === 0 ? LONG : `step ${k}` }),
    )
    out.push(
      ev(sessionId, ++seq, "tool_call", { id: `t${k}`, name: "Bash", input: { command: "make" } }),
    )
    out.push(ev(sessionId, ++seq, "tool_result", { id: `t${k}`, output: k % 7 === 0 ? BIG : "ok" }))
    // A subagent's event: the main thread's reads skip it (scope=top).
    out.push(
      ev(sessionId, ++seq, "assistant_text", { text: "sub" }, { parentToolUseId: "toolu_sub" }),
    )
    out.push(ev(sessionId, ++seq, "usage", { contextTokens: 1000 + k }))
  }
  out.push(
    ev(sessionId, ++seq, "permission_request", {
      requestId: `req-${sessionId}`,
      tool: "Bash",
      input: { command: "rm -rf build" },
      reason: "",
    }),
  )
  return out
}

/** A server answering like the API, per session (after/before, scope=top, parent, limit). */
function server(bySession: Record<string, Frame[]>) {
  const get = vi.fn(async (path: string) => {
    const m = /^\/me\/node-sessions\/([^/?]+)(\/events\?(.*))?$/.exec(path)
    if (!m) throw new Error(`unexpected path ${path}`)
    const id = decodeURIComponent(m[1])
    const all = bySession[id] ?? []
    const lastSeq = all.at(-1)?.seq ?? 0
    if (!m[2]) return { id, status: "running", lastSeq, folderName: "code", repo: null }
    const q = new URLSearchParams(m[3])
    const limit = Number(q.get("limit"))
    const parent = q.get("parent")
    const scoped = all.filter((e) =>
      parent ? e.parentToolUseId === parent : q.get("scope") === "top" ? !e.parentToolUseId : true,
    )
    if (q.has("before")) {
      const before = Number(q.get("before"))
      return { events: scoped.filter((e) => e.seq < before).slice(-limit), lastSeq }
    }
    const after = Number(q.get("after"))
    const events = scoped.filter((e) => e.seq > after).slice(0, limit)
    const through = events.length === limit ? (events.at(-1)?.seq ?? after) : lastSeq
    return { events, lastSeq, through }
  })
  return { get }
}

const ctx = { cwd: "/home/me/code", folderName: "code", sessionId: "s1", repo: null }
const opts = { sessionStatus: "running", pathContext: ctx }

/** The rows a view shows, without the arrival time (a server read back stamps a new one). */
function rows(model: TranscriptModel, id: string): string {
  const items = model.sync(sessionStore.events(id), {
    ...opts,
    pathContext: { ...ctx, sessionId: id },
  })
  return JSON.stringify(items.map(({ clientReceivedAt: _c, ...it }) => it))
}

const eventReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(([p]) => String(p).includes("/events")).map(([p]) => String(p))

function installIndexedDb(): void {
  const g = globalThis as Record<string, unknown>
  g.indexedDB = new IDBFactory()
  g.IDBKeyRange = IDBKeyRange
}

function removeIndexedDb(): void {
  const g = globalThis as Record<string, unknown>
  delete g.indexedDB
  delete g.IDBKeyRange
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.setSystemTime(T0)
  removeIndexedDb()
  await _resetDiskCache()
  // F3: the cache is the signed-in user's on this server.
  setDiskCacheOwner(() => ({ server: "https://liaison.test", userId: "u1" }))
})

afterEach(async () => {
  resetSessionStore()
  await _resetDiskCache()
  removeIndexedDb()
  vi.useRealTimers()
})

async function openSession(id: string, all: Frame[], api: ReturnType<typeof server>) {
  setSessionStoreApi(() => api as never)
  await watchSession(id)
  showSession(id)
  expect(sessionStore.lastSeq(id)).toBe(all.at(-1)?.seq ?? 0)
}

describe("S58: a hidden view lets its events go and reads them back when shown", () => {
  it("S58: hidden for 30 s, the window is released (header figures kept); shown again it reads back the same rows from the disk cache, without a network read", async () => {
    installIndexedDb()
    expect(await diskCacheAvailable()).toBe(true)
    const all = sessionEvents("s1", 600)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const model = new TranscriptModel()
    const before = rows(model, "s1")
    const held = sessionStore.events("s1").length
    const bytes = sessionStore.sessionBytes("s1")
    expect(held).toBeGreaterThan(300)
    await flushDiskCache()

    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS - 1_000)
    expect(sessionStore.isReleased("s1")).toBe(false)
    expect(sessionStore.events("s1").length).toBe(held)
    vi.advanceTimersByTime(1_000)
    expect(sessionStore.isReleased("s1")).toBe(true)
    // The screen it left and its open request stay; everything else goes.
    const kept = sessionStore.events("s1")
    expect(kept.length).toBeLessThanOrEqual(SCREEN_KEEP + 1)
    expect(sessionStore.sessionBytes("s1")).toBeLessThan(bytes / 10)
    expect(kept.some((e) => e.type === "permission_request")).toBe(true)
    // The header, the list and the composer still read the fold.
    expect(pendingRequests(kept).map((r) => r.requestId)).toEqual(["req-s1"])
    expect(sessionStore.received("s1")).toBeGreaterThan(held)

    api.get.mockClear()
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.isReleased("s1")).toBe(false)
    expect(eventReads(api.get)).toEqual([])
    expect(rows(model, "s1")).toBe(before)
  })

  it("S58: an event arriving while released is folded, not held, and is in the window read back", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 200)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    const keptBefore = sessionStore.events("s1").length
    const next = ev("s1", all.length + 1, "assistant_text", { text: "while hidden" })
    all.push(next)
    applyEvent(next)
    expect(sessionStore.events("s1").length).toBe(keptBefore)
    expect(sessionStore.lastSeq("s1")).toBe(next.seq)
    api.get.mockClear()
    showSession("s1")
    await settleSession("s1")
    expect(eventReads(api.get)).toEqual([])
    expect(sessionStore.events("s1").at(-1)?.payload.text).toBe("while hidden")
  })

  it("S58: shown again before the delay, nothing is released", async () => {
    const all = sessionEvents("s1", 200)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const held = sessionStore.events("s1").length
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS / 2)
    showSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS * 2)
    expect(sessionStore.isReleased("s1")).toBe(false)
    expect(sessionStore.events("s1").length).toBe(held)
  })
})

describe("S58: an open subagent drawer follows the same rules", () => {
  it("S58: a drawer open in a hidden view is released with it and reads back from the disk cache when shown", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 20)
    let seq = all.at(-1)?.seq ?? 0
    for (let i = 0; i < 300; i++) {
      all.push(
        ev("s1", ++seq, "assistant_text", { text: `sub ${i}` }, { parentToolUseId: "toolu_d" }),
      )
    }
    const api = server({ s1: all })
    await openSession("s1", all, api)
    await openSubagent("s1", "toolu_d")
    const before = sessionStore.subagentEvents("s1", "toolu_d").map((e) => e.seq)
    expect(before.length).toBe(300)
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.subagentEvents("s1", "toolu_d").length).toBeLessThanOrEqual(SCREEN_KEEP)
    api.get.mockClear()
    showSession("s1")
    await settleSession("s1")
    expect(eventReads(api.get)).toEqual([])
    expect(sessionStore.subagentEvents("s1", "toolu_d").map((e) => e.seq)).toEqual(before)
  })
})

describe("S58: a window empty when released still reads back what arrived while released (batch-5 F1, F2)", () => {
  it("S58: a main thread released while it held nothing shows, when shown again, every event that arrived while released (P1)", async () => {
    installIndexedDb()
    const all: Frame[] = []
    const api = server({ s1: all })
    await openSession("s1", all, api)
    expect(sessionStore.events("s1")).toEqual([])
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.isReleased("s1")).toBe(true)
    for (let seq = 1; seq <= 5; seq++) {
      const e = ev("s1", seq, "assistant_text", { text: `while hidden ${seq}` })
      all.push(e)
      applyEvent(e)
    }
    expect(sessionStore.events("s1")).toEqual([])
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it("S58: the same without IndexedDB: the events are read back from the server (P1)", async () => {
    const all: Frame[] = []
    const api = server({ s1: all })
    await openSession("s1", all, api)
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    for (let seq = 1; seq <= 5; seq++) {
      const e = ev("s1", seq, "assistant_text", { text: `while hidden ${seq}` })
      all.push(e)
      applyEvent(e)
    }
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.events("s1").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it("S58: a drawer whose first events arrive while its view is released shows them when the view is shown again (P2)", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 20)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    await openSubagent("s1", "toolu_new")
    expect(sessionStore.subagentEvents("s1", "toolu_new")).toEqual([])
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    let seq = all.at(-1)?.seq ?? 0
    for (let i = 0; i < 5; i++) {
      all.push(
        ev("s1", ++seq, "assistant_text", { text: `sub ${i}` }, { parentToolUseId: "toolu_new" }),
      )
    }
    applyRow({ id: "s1", status: "running", lastSeq: seq, folderName: "code", repo: null })
    await vi.waitFor(() => expect(sessionStore.lastSeq("s1")).toBe(seq))
    await flushDiskCache()
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.subagentEvents("s1", "toolu_new").map((e) => e.payload.text)).toEqual([
      "sub 0",
      "sub 1",
      "sub 2",
      "sub 3",
      "sub 4",
    ])
  })
})

describe("S58: a read back for an older release is never reused (batch-5 F8)", () => {
  it("S58: shown, hidden and released again while the read back hangs, then shown: a new read back runs and the window is restored", async () => {
    const all = sessionEvents("s1", 200)
    const base = server({ s1: all })
    let blocking = false
    const gates: (() => void)[] = []
    const api = {
      get: vi.fn(async (path: string) => {
        if (blocking && path.includes("/events")) await new Promise<void>((r) => gates.push(r))
        return base.get(path)
      }),
    }
    await openSession("s1", all, api as never)
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    blocking = true
    showSession("s1")
    await vi.waitFor(() => expect(gates.length).toBe(1))
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.isReleased("s1")).toBe(true)
    blocking = false
    const readsBefore = eventReads(api.get).length
    showSession("s1")
    // A new read starts for this show; the hung one belongs to the older release.
    await vi.waitFor(() => expect(eventReads(api.get).length).toBeGreaterThan(readsBefore))
    for (const open of gates) open()
    await settleSession("s1")
    expect(sessionStore.isReleased("s1")).toBe(false)
    expect(sessionStore.events("s1").length).toBeGreaterThan(SCREEN_KEEP + 1)
  })
})

describe("S58: claims the batch-5 review found untested (F9)", () => {
  it("S58: sign-out (the session teardown) clears the disk cache (M7)", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 100)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    await flushDiskCache()
    expect((await diskCache.read("s1", "", 1, 100))?.events.length).toBeGreaterThan(0)
    resetSessionData()
    await flushDiskCache()
    expect(await diskCache.read("s1", "", 1, 100)).toBeNull()
    expect(await diskCache.readOne("s1", "", 2)).toBeNull()
  })

  it("S58: two sessions' cached ranges are kept apart: both read back from the disk cache, each its own rows (M3b)", async () => {
    installIndexedDb()
    const one = sessionEvents("s1", 300)
    const two = sessionEvents("s2", 200)
    const api = server({ s1: one, s2: two })
    await openSession("s1", one, api)
    await openSession("s2", two, api)
    const model1 = new TranscriptModel()
    const model2 = new TranscriptModel()
    const before1 = rows(model1, "s1")
    const before2 = rows(model2, "s2")
    hideSession("s1")
    hideSession("s2")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.isReleased("s1")).toBe(true)
    expect(sessionStore.isReleased("s2")).toBe(true)
    api.get.mockClear()
    showSession("s1")
    showSession("s2")
    await settleSession("s1")
    await settleSession("s2")
    expect(eventReads(api.get)).toEqual([])
    expect(rows(model1, "s1")).toBe(before1)
    expect(rows(model2, "s2")).toBe(before2)
  })

  it("S58: a release keeps an open request far above the screen it keeps (M5)", async () => {
    const all = sessionEvents("s1", 20)
    let seq = all.at(-1)?.seq ?? 0
    for (let i = 0; i < SCREEN_KEEP * 3; i++) {
      all.push(ev("s1", ++seq, "assistant_text", { text: `after the request ${i}` }))
    }
    const api = server({ s1: all })
    await openSession("s1", all, api)
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    const kept = sessionStore.events("s1")
    expect(kept.length).toBe(SCREEN_KEEP + 1)
    expect(pendingRequests(kept).map((r) => r.requestId)).toEqual(["req-s1"])
  })
})

describe("S58: a read back that fails or comes back short says so, with a retry (batch-5 F6, F11)", () => {
  /** A server whose event reads fail from the `failFrom`-th one on, while `down` says so. */
  function flaky(all: Frame[]) {
    const base = server({ s1: all })
    const state = { down: false, failFrom: 0, reads: 0 }
    const get = vi.fn(async (path: string) => {
      if (state.down && path.includes("/events") && state.reads++ >= state.failFrom) {
        throw new Error("offline")
      }
      return base.get(path)
    })
    return { api: { get }, state }
  }

  /** The held main-thread events are one run of the server's, with nothing missing inside. */
  function contiguous(all: Frame[]): boolean {
    const held = sessionStore.events("s1").map((e) => e.seq)
    const top = all.filter((e) => !e.parentToolUseId && e.type !== "usage").map((e) => e.seq)
    const start = top.indexOf(held[0])
    return start >= 0 && held.every((seq, i) => top[start + i] === seq)
  }

  it("S58: a read back that fails leaves the window released with a failed mark, and a retry reads it back (F11)", async () => {
    const all = sessionEvents("s1", 300)
    const { api, state } = flaky(all)
    await openSession("s1", all, api as never)
    const model = new TranscriptModel()
    const before = rows(model, "s1")
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    state.down = true
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.isReleased("s1")).toBe(true)
    expect(sessionStore.readBackFailed("s1")).toBe(true)
    state.down = false
    await retryReadBack("s1")
    expect(sessionStore.readBackFailed("s1")).toBe(false)
    expect(sessionStore.isReleased("s1")).toBe(false)
    expect(rows(model, "s1")).toBe(before)
  })

  it("S58: a read back cut short (its second page fails) never merges the part it read: no silent hole (F6)", async () => {
    const all = sessionEvents("s1", 1_500)
    const { api, state } = flaky(all)
    await openSession("s1", all, api as never)
    const first = sessionStore.events("s1")[0].seq
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    state.down = true
    state.failFrom = 1
    showSession("s1")
    await settleSession("s1")
    expect(state.reads).toBeGreaterThan(1)
    expect(contiguous(all)).toBe(true)
    expect(sessionStore.readBackFailed("s1")).toBe(true)
    // F10: released again before the missing part read back, then shown with
    // the server back: the whole window reads back, from where it began.
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    state.down = false
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.readBackFailed("s1")).toBe(false)
    expect(sessionStore.events("s1")[0].seq).toBe(first)
    expect(contiguous(all)).toBe(true)
  })

  it("S58: the part above the screen that failed to read back is read again by Retry (F6, F10)", async () => {
    const all = sessionEvents("s1", 1_500)
    const { api, state } = flaky(all)
    await openSession("s1", all, api as never)
    const first = sessionStore.events("s1")[0].seq
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    state.down = true
    state.failFrom = 1
    showSession("s1")
    await settleSession("s1")
    expect(sessionStore.readBackFailed("s1")).toBe(true)
    expect(sessionStore.events("s1")[0].seq).toBeGreaterThan(first)
    state.down = false
    await retryReadBack("s1")
    expect(sessionStore.readBackFailed("s1")).toBe(false)
    expect(sessionStore.events("s1")[0].seq).toBe(first)
    expect(contiguous(all)).toBe(true)
  })
})

describe("S58: a read back is incremental: the screen first, the rest after, sizes as stored (batch-5 F10)", () => {
  it("S58: shown again, the window reads back the screen it kept first, then the events above it, and ends with the same rows", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 600)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const model = new TranscriptModel()
    const before = rows(model, "s1")
    const first = sessionStore.events("s1")[0].seq
    await flushDiskCache()
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    const screenFirst = sessionStore.events("s1").find((e) => e.type !== "permission_request")?.seq
    const reads = vi.spyOn(diskCache, "read")
    showSession("s1")
    await settleSession("s1")
    expect(reads.mock.calls[0]?.[2]).toBe(screenFirst)
    expect(reads.mock.calls.some(([, , from]) => from === first)).toBe(true)
    reads.mockRestore()
    expect(rows(model, "s1")).toBe(before)
  })

  it("S58: a read back from the disk cache takes each event's size as stored instead of measuring it again", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 600)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    await flushDiskCache()
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    const stringify = vi.spyOn(JSON, "stringify")
    showSession("s1")
    await settleSession("s1")
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    const held = sessionStore.events("s1").length
    expect(held).toBeGreaterThan(300)
    expect(calls).toBeLessThan(held / 2)
  })
})

describe("S58: without IndexedDB the app works and reads back from the server", () => {
  it("S58: no IndexedDB: released and shown again, the window reads back from the server (scope=top, from where it began) with the same rows; a stub reads from the server", async () => {
    expect(await diskCacheAvailable()).toBe(false)
    const all = sessionEvents("s1", 600)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const model = new TranscriptModel()
    const before = rows(model, "s1")
    const first = sessionStore.events("s1")[0].seq
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    expect(sessionStore.isReleased("s1")).toBe(true)
    const kept = sessionStore.events("s1").find((e) => e.type !== "permission_request")?.seq ?? 0
    api.get.mockClear()
    showSession("s1")
    await settleSession("s1")
    // F10: the screen it kept first, then the rest from where the window began.
    const reads = eventReads(api.get)
    expect(reads[0]).toBe(`/me/node-sessions/s1/events?after=${kept - 1}&limit=500&scope=top`)
    expect(reads.slice(1)).toContain(
      `/me/node-sessions/s1/events?after=${first - 1}&limit=500&scope=top`,
    )
    expect(rows(model, "s1")).toBe(before)
    const stub = sessionStore
      .events("s1")
      .find((e) => e.type === "tool_result" && (e.payload.elided as { chars?: number })?.chars)
    expect(stub).toBeDefined()
    api.get.mockClear()
    expect(await fetchEventOutput("s1", stub?.seq as number)).toBe(BIG)
    expect(eventReads(api.get)).toHaveLength(1)
  })

  it("S58: without IndexedDB a stub read again (a row scrolled away and back) does not read the server again (batch-5 F12)", async () => {
    const all = sessionEvents("s1", 400)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const stub = sessionStore
      .events("s1")
      .find((e) => e.type === "assistant_text" && e.payload.textElided)
    expect(stub).toBeDefined()
    api.get.mockClear()
    expect(await fetchEventText("s1", stub?.seq as number)).toBe(LONG)
    expect(await fetchEventText("s1", stub?.seq as number)).toBe(LONG)
    expect(eventReads(api.get)).toHaveLength(1)
  })

  it("S58: an IndexedDB that refuses to open (a private window) leaves the app working", async () => {
    const g = globalThis as Record<string, unknown>
    g.indexedDB = {
      open() {
        throw new Error("SecurityError")
      },
    }
    g.IDBKeyRange = IDBKeyRange
    const all = sessionEvents("s1", 300)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const model = new TranscriptModel()
    const before = rows(model, "s1")
    hideSession("s1")
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    showSession("s1")
    await settleSession("s1")
    expect(rows(model, "s1")).toBe(before)
    expect(await diskCacheAvailable()).toBe(false)
  })
})

describe("S58: the disk cache serves stubs", () => {
  it("S58: a long message is a stub off the last screen, and its whole text is read from the disk cache without the network", async () => {
    installIndexedDb()
    const all = sessionEvents("s1", 400)
    const api = server({ s1: all })
    await openSession("s1", all, api)
    const stub = sessionStore
      .events("s1")
      .find((e) => e.type === "assistant_text" && e.payload.textElided)
    expect(stub).toBeDefined()
    expect(String(stub?.payload.text).length).toBeLessThan(ELIDE_MIN_CHARS)
    api.get.mockClear()
    expect(await fetchEventText("s1", stub?.seq as number)).toBe(LONG)
    expect(eventReads(api.get)).toEqual([])
  })
})

describe("S58: one byte budget across every session", () => {
  it("S58: past the budget the least recently viewed hidden session gives back its oldest events first; the session on screen and open requests are never touched", async () => {
    const output = "x".repeat(4_000)
    const ids = ["a", "b", "c", "d", "e"]
    const api = server({})
    setSessionStoreApi(() => api as never)
    for (const id of ids) await watchSession(id)
    showSession("a")
    // b viewed longest ago, e most recently.
    for (const id of ids.slice(1)) {
      vi.advanceTimersByTime(1_000)
      showSession(id)
      hideSession(id)
    }
    const fill = (id: string) => {
      for (let seq = 1; seq <= 2_000; seq++) {
        if (id === "b" && seq === 1_000) {
          applyEvent(
            ev(id, seq, "permission_request", { requestId: "req-b", tool: "Bash", input: {} }),
          )
        } else applyEvent(ev(id, seq, "tool_result", { id: `t${seq}`, output }))
      }
    }
    fill("a")
    const aBytes = sessionStore.sessionBytes("a")
    for (const id of ids.slice(1)) fill(id)

    expect(sessionStore.heldBytes()).toBeLessThanOrEqual(MEMORY_BUDGET_BYTES)
    // On screen: whole.
    expect(sessionStore.events("a").length).toBe(2_000)
    expect(sessionStore.events("a")[0].seq).toBe(1)
    expect(sessionStore.sessionBytes("a")).toBe(aBytes)
    // The least recently viewed gave back its oldest events, up to its open request.
    const b = sessionStore.events("b")
    expect(b[0].seq).toBe(1_000)
    expect(b[0].type).toBe("permission_request")
    expect(pendingRequests(b).map((r) => r.requestId)).toEqual(["req-b"])
    // Least recently viewed first: c gave back more than d, d no more than e.
    const len = (id: string) => sessionStore.events(id).length
    expect(len("c")).toBeLessThan(len("d"))
    expect(len("d")).toBeLessThanOrEqual(len("e"))
    expect(len("e")).toBe(2_000)
    for (const id of ids) expect(sessionStore.lastSeq(id)).toBe(2_000)
  })

  it("S58: a release the budget makes keeps the screen the owner left in that hidden session, not its last events (batch-5 F7)", async () => {
    const extra = "y".repeat(20_000)
    const api = server({})
    setSessionStoreApi(() => api as never)
    await watchSession("a")
    await watchSession("b")
    showSession("a")
    showSession("b")
    // b's first event is an open request: its front cannot be given back, only its window.
    applyEvent(ev("b", 1, "permission_request", { requestId: "req-b", tool: "Bash", input: {} }))
    for (let seq = 2; seq <= 1_000; seq++) {
      applyEvent(ev("b", seq, "tool_result", { id: `t${seq}`, output: "ok", extra }))
    }
    // The owner scrolled up to seq 500, then left b.
    hideSession("b", 500)
    expect(sessionStore.isReleased("b")).toBe(false)
    for (let seq = 1; seq <= 1_000; seq++) {
      applyEvent(ev("a", seq, "tool_result", { id: `t${seq}`, output: "ok", extra }))
    }
    expect(sessionStore.isReleased("b")).toBe(true)
    const kept = sessionStore.events("b").map((e) => e.seq)
    expect(kept[0]).toBe(1)
    expect(kept.slice(1)).toEqual(Array.from({ length: SCREEN_KEEP }, (_, i) => 500 + i))
  })
})
