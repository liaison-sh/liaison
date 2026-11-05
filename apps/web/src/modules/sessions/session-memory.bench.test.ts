// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S56 (D30) MEASUREMENT, not a gate: the heap a watched hour-long session
// leaves in the client (about 30,000 main-thread events, 10 subagents, one
// tool output in five of 10-60 KB), after ingesting it frame by frame and
// deriving the transcript and the header figures as the view does. Opt-in
// (`SESSION_MEM_BENCH=1`): it prints before/after figures for the ledger; the
// real budget is measured with vmmap on the desktop app at the gate.

import { afterEach, describe, expect, it, vi } from "vitest"
import { syntheticSession } from "./__fixtures__/synthetic-session"
import { cacheState, subagents } from "./header-info"
import {
  applyEvent,
  hideSession,
  RELEASE_AFTER_MS,
  resetSessionStore,
  sessionStore,
  setSessionStoreApi,
  showSession,
  watchSession,
} from "./session-store"
import * as transcript from "./transcript"

const { buildTranscript, pendingRequests } = transcript

const run = process.env.SESSION_MEM_BENCH === "1"
const EVENTS = Number(process.env.SESSION_MEM_EVENTS ?? 30_000)

type Bun = { gc(force: boolean): void }
function heapMb(): { heapUsed: number; jscHeap?: number } {
  const g = globalThis as { Bun?: Bun }
  g.Bun?.gc(true)
  g.Bun?.gc(true)
  let jscHeap: number | undefined
  try {
    const jsc = require("bun:jsc") as any
    jscHeap = jsc.heapStats().heapSize / 2 ** 20
  } catch {
    // not under bun
  }
  return { heapUsed: process.memoryUsage().heapUsed / 2 ** 20, jscHeap }
}

afterEach(() => resetSessionStore())

describe.runIf(run)("S56: memory of an hour-long watched session", () => {
  it("S56: heap after ingesting a 1 h synthetic session", async () => {
    const api = {
      get: async (path: string) =>
        path.includes("/events")
          ? { events: [], lastSeq: 0, through: 0 }
          : {
              id: "s1",
              status: "running",
              lastSeq: 0,
              folderName: "code",
              repo: null,
            },
    }
    setSessionStoreApi(() => api as never)
    await watchSession("s1")
    const before = heapMb()
    const t0 = performance.now()
    let items = 0
    let n = 0
    // The view's own derivation: the incremental model when there is one (S56), else a rebuild.
    const Model = (transcript as any).TranscriptModel as
      | (new () => { sync(e: unknown, o: unknown): unknown[] })
      | undefined
    const model = Model ? new Model() : null
    const ctx = { cwd: "/home/me/code", folderName: "code", sessionId: "s1", repo: null }
    for (const e of syntheticSession({ events: EVENTS, subagents: 10 })) {
      applyEvent(e)
      n++
      // The view derives on every batch of frames (here every 25).
      if (n % 25 === 0) {
        const events = sessionStore.events("s1")
        const opts = { sessionStatus: "running", pathContext: ctx }
        items = (model ? model.sync(events, opts) : buildTranscript(events, opts)).length
        subagents(events, Date.now())
        cacheState(events, Date.now())
        pendingRequests(events)
      }
    }
    const ms = performance.now() - t0
    const held = sessionStore.events("s1")
    const built = buildTranscript(held, { sessionStatus: "running", pathContext: ctx })
    const after = heapMb()
    const line =
      `S56-BENCH events=${n} held=${held.length} items=${built.length}/${items} ` +
      `heapUsed ${before.heapUsed.toFixed(1)} -> ${after.heapUsed.toFixed(1)} MB ` +
      `(+${(after.heapUsed - before.heapUsed).toFixed(1)}) jscHeap ${before.jscHeap?.toFixed(1)} -> ${after.jscHeap?.toFixed(1)} MB ` +
      `ingest+derive ${(ms / 1000).toFixed(1)} s`
    console.log(line)
    if (process.env.SESSION_MEM_OUT) {
      const fs = await import("node:fs")
      fs.appendFileSync(process.env.SESSION_MEM_OUT, `${line}\n`)
    }
    expect(n).toBe(EVENTS)
  }, 1_800_000)

  it("S58: heap with 5 hour-long sessions open, 1 focused and 4 in the background", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const ids = ["s1", "s2", "s3", "s4", "s5"]
    const api = {
      get: async (path: string) => {
        if (path.includes("/events")) return { events: [], lastSeq: 0, through: 0 }
        const id = /node-sessions\/([^/?]+)/.exec(path)?.[1] ?? "s1"
        return { id, status: "running", lastSeq: 0, folderName: "code", repo: null }
      },
    }
    setSessionStoreApi(() => api as never)
    for (const id of ids) {
      await watchSession(id)
      showSession(id)
    }
    const before = heapMb()
    const t0 = performance.now()
    const ctx = { cwd: "/home/me/code", folderName: "code", sessionId: "s1", repo: null }
    const model = new transcript.TranscriptModel()
    const streams = ids.map((id) =>
      syntheticSession({ sessionId: id, events: EVENTS, subagents: 10 }),
    )
    let n = 0
    let maxRss = 0
    for (let live = streams.length; live > 0; ) {
      live = 0
      for (const stream of streams) {
        // Round robin, 25 frames per session per turn (the sessions run at once).
        for (let k = 0; k < 25; k++) {
          const next = stream.next()
          if (next.done) break
          applyEvent(next.value)
          n++
          if (k === 24) live++
        }
      }
      // The focused view derives its transcript and header as frames arrive.
      const events = sessionStore.events("s1")
      model.sync(events, { sessionStatus: "running", pathContext: ctx })
      subagents(events, Date.now())
      cacheState(events, Date.now())
      pendingRequests(events)
      if (n % 25_000 < 125) maxRss = Math.max(maxRss, process.memoryUsage().rss)
    }
    const ms = performance.now() - t0
    const allOpen = heapMb()
    const heldAll = sessionStore.heldBytes()
    // Four of them go to the background: hidden, then released after the delay.
    for (const id of ids.slice(1)) hideSession(id)
    vi.advanceTimersByTime(RELEASE_AFTER_MS)
    const released = ids.slice(1).every((id) => sessionStore.isReleased(id))
    const after = heapMb()
    const heldAfter = sessionStore.heldBytes()
    maxRss = Math.max(maxRss, process.memoryUsage().rss)
    const mb = (b: number) => (b / 2 ** 20).toFixed(1)
    const line =
      `S58-BENCH sessions=5 events=${n} focused-held=${sessionStore.events("s1").length} ` +
      `background-held=${ids
        .slice(1)
        .map((id) => sessionStore.events(id).length)
        .join("/")} released=${released} ` +
      `heldBytes all-open ${mb(heldAll)} MB -> 4-background ${mb(heldAfter)} MB; ` +
      `heapUsed ${before.heapUsed.toFixed(1)} -> all-open ${allOpen.heapUsed.toFixed(1)} -> 4-background ${after.heapUsed.toFixed(1)} MB; ` +
      `jscHeap ${before.jscHeap?.toFixed(1)} -> ${allOpen.jscHeap?.toFixed(1)} -> ${after.jscHeap?.toFixed(1)} MB; ` +
      `max rss ${mb(maxRss)} MB; ingest+derive ${(ms / 1000).toFixed(1)} s`
    console.log(line)
    if (process.env.SESSION_MEM_OUT) {
      const fs = await import("node:fs")
      fs.appendFileSync(process.env.SESSION_MEM_OUT, `${line}\n`)
    }
    vi.useRealTimers()
    expect(n).toBe(EVENTS * 5)
    expect(released).toBe(true)
  }, 1_800_000)
})
