// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { type LevelNoteEvent, levelNoteState } from "./level-note"

const ev = (seq: number, type: string, payload: Record<string, unknown>): LevelNoteEvent => ({
  seq,
  type,
  payload,
})
const request = { level: "standard", afterSeq: 5 } as const

describe("S46: the level note is derived from events and state", () => {
  it("S46: the note stays while level_changed has not reported it", () => {
    expect(levelNoteState([ev(4, "assistant_text", {})], request, "running")).toBe("pending")
    expect(
      levelNoteState([ev(6, "level_changed", { from: "strict", to: "open" })], request, "waiting"),
    ).toBe("pending")
  })

  it("S46: a set_level standard followed by level_changed to standard clears the note", () => {
    const events = [ev(6, "level_changed", { from: "strict", to: "standard" })]
    expect(levelNoteState(events, request, "running")).toBe("none")
  })

  it("S46: the next run's start event reporting the level clears the note", () => {
    const events = [ev(7, "system", { subtype: "start", data: { level: "standard" } })]
    expect(levelNoteState(events, request, "running")).toBe("none")
  })

  it("S46: an event from before the request does not clear it", () => {
    const events = [ev(5, "level_changed", { from: "open", to: "standard" })]
    expect(levelNoteState(events, request, "running")).toBe("pending")
  })

  it("S46: an ended session shows no note", () => {
    for (const state of ["done", "failed", "stopped", "queued", "paused"]) {
      expect(levelNoteState([], request, state)).toBe("none")
    }
  })

  it("S46: no request, no note", () => {
    expect(levelNoteState([], null, "running")).toBe("none")
  })
})
