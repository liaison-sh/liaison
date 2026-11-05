// SPDX-License-Identifier: FSL-1.1-ALv2
// The "is the user already in this conversation" decision a message push asks
// before it interrupts: a focused client showing the thread, or a recent post
// or keystroke there with a focused client still touched, holds it back.
import { describe, expect, it } from "bun:test"
import type { NotifyPresenceEntry } from "~/infra/websocket"
import {
  isActiveInThread,
  isViewingSession,
  isViewingThread,
  SESSION_VIEWING_IDLE_MS,
  THREAD_INTERACTION_WINDOW_MS,
  THREAD_VIEWING_IDLE_MS,
} from "./thread-activity"

const NOW = 1_800_000_000_000

function entry(over: Partial<NotifyPresenceEntry> = {}): NotifyPresenceEntry {
  return { connId: "c1", instanceId: "i1", kind: "desktop_app", lastActiveAt: NOW, ...over }
}

// An agent's finished answer to the person who asked asks only this: is that
// conversation on a focused screen right now? Having posted there a moment ago
// and moved on to another one does not hold it back (etiquette rule 1).
describe("isViewingThread", () => {
  it("is the thread on a focused, recently touched screen, and nothing else", () => {
    const on = entry({ viewing: { threadIds: ["t1"], focused: true } })
    expect(isViewingThread([on], "t1", NOW)).toBe(true)
    const elsewhere = entry({ viewing: { threadIds: ["other"], focused: true } })
    expect(isViewingThread([elsewhere], "t1", NOW)).toBe(false)
    // The interaction rule would call this active; viewing alone does not.
    expect(isActiveInThread([elsewhere], "t1", NOW - 5_000, NOW)).toBe(true)
    const blurred = entry({ viewing: { threadIds: ["t1"], focused: false } })
    expect(isViewingThread([blurred], "t1", NOW)).toBe(false)
    const idle = entry({
      lastActiveAt: NOW - THREAD_VIEWING_IDLE_MS - 1,
      viewing: { threadIds: ["t1"], focused: true },
    })
    expect(isViewingThread([idle], "t1", NOW)).toBe(false)
  })
})

describe("isActiveInThread", () => {
  it("a focused client showing the thread is active in it", () => {
    const e = entry({ viewing: { threadIds: ["t1"], focused: true } })
    expect(isActiveInThread([e], "t1", null, NOW)).toBe(true)
    expect(isActiveInThread([e], "t2", null, NOW)).toBe(false)
  })

  it("an unfocused or hidden client showing the thread is not", () => {
    const e = entry({ viewing: { threadIds: ["t1"], focused: false } })
    expect(isActiveInThread([e], "t1", null, NOW)).toBe(false)
  })

  it("a client that reports nothing never suppresses", () => {
    expect(isActiveInThread([entry()], "t1", NOW, NOW)).toBe(false)
  })

  it("a focused client left untouched past the idle bound is not", () => {
    const e = entry({
      lastActiveAt: NOW - THREAD_VIEWING_IDLE_MS - 1,
      viewing: { threadIds: ["t1"], focused: true },
    })
    expect(isActiveInThread([e], "t1", null, NOW)).toBe(false)
  })

  it("a recent post in the thread with a focused, recently touched client is active", () => {
    const e = entry({ viewing: { threadIds: ["other"], focused: true } })
    expect(isActiveInThread([e], "t1", NOW - 5_000, NOW)).toBe(true)
    // The post is too old, or the user left the keyboard.
    expect(isActiveInThread([e], "t1", NOW - THREAD_INTERACTION_WINDOW_MS - 1, NOW)).toBe(false)
    const away = entry({
      lastActiveAt: NOW - THREAD_INTERACTION_WINDOW_MS - 1,
      viewing: { threadIds: ["other"], focused: true },
    })
    expect(isActiveInThread([away], "t1", NOW - 5_000, NOW)).toBe(false)
  })

  it("a recent post with every client hidden or unfocused is not (the phone was locked)", () => {
    const phone = entry({ kind: "mobile_app", viewing: { threadIds: [], focused: false } })
    expect(isActiveInThread([phone], "t1", NOW - 5_000, NOW)).toBe(false)
  })
})

describe("isViewingSession", () => {
  const S = "5e55-1011"
  const shows = (over: Partial<NotifyPresenceEntry> = {}) =>
    entry({ viewing: { threadIds: [S], focused: true }, ...over })

  it("S13: a focused client showing the session, touched within 2 min, is viewing it", () => {
    expect(SESSION_VIEWING_IDLE_MS).toBe(120_000)
    expect(isViewingSession([shows()], S, NOW)).toBe(true)
    expect(isViewingSession([shows({ lastActiveAt: NOW - 120_000 })], S, NOW)).toBe(true)
  })

  it("S13: after 2 min idle, unfocused, another session on screen or no report, it is not", () => {
    expect(isViewingSession([shows({ lastActiveAt: NOW - 120_001 })], S, NOW)).toBe(false)
    expect(isViewingSession([entry({ viewing: { threadIds: [S], focused: false } })], S, NOW)).toBe(
      false,
    )
    expect(
      isViewingSession([entry({ viewing: { threadIds: ["other"], focused: true } })], S, NOW),
    ).toBe(false)
    expect(isViewingSession([entry()], S, NOW)).toBe(false)
  })

  it("S13: any one of the owner's devices showing it is enough", () => {
    const phone = entry({ connId: "c2", viewing: { threadIds: [], focused: false } })
    expect(isViewingSession([phone, shows({ connId: "c3" })], S, NOW)).toBe(true)
  })
})
