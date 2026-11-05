// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  LIVE_RESULT_LIMITS,
  REPLAY_RESULT_LIMITS,
  truncateReplayedToolResult,
  truncateToolResult,
  truncateToolResultForModel,
} from "~/modules/agent/runtime/result-truncation"

describe("truncateToolResult", () => {
  it("passes small results through by reference", () => {
    const v = { ticket: { id: "t1" }, messages: { items: [{ textBody: "hello" }] } }
    expect(truncateToolResultForModel(v)).toBe(v)
    expect(truncateReplayedToolResult(v)).toBe(v)
  })

  it("clips long strings but preserves the JSON shape (the tickets:get case)", () => {
    const html = "x".repeat(90_000)
    const v = {
      ticket: { id: "t1" },
      messages: { items: [{ id: "m0", htmlBody: html }] },
    }
    const out = truncateToolResult(v, LIVE_RESULT_LIMITS) as typeof v
    expect(out).not.toBe(v)
    expect(out.ticket.id).toBe("t1")
    expect(out.messages.items).toHaveLength(1)
    expect(out.messages.items[0]!.id).toBe("m0")
    expect(out.messages.items[0]!.htmlBody.length).toBeLessThan(41_000)
    expect(out.messages.items[0]!.htmlBody).toContain("truncated by the platform")
    // Original input untouched (no in-place mutation of the tool's result).
    expect(v.messages.items[0]!.htmlBody.length).toBe(90_000)
  })

  it("a multi-message blob over the total cap degrades to the serialized-head envelope", () => {
    const html = "x".repeat(90_000)
    const v = {
      ticket: { id: "t1" },
      messages: { items: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, htmlBody: html })) },
    }
    const out = truncateToolResult(v, LIVE_RESULT_LIMITS) as { truncatedResult?: string }
    expect(typeof out.truncatedResult).toBe("string")
    expect(out.truncatedResult!.length).toBeLessThanOrEqual(LIVE_RESULT_LIMITS.maxTotal)
  })

  it("live cap is 48k total with a 40k per-string floor (a full knowledge doc survives)", () => {
    // The total cap must stay ABOVE the per-string floor: skill bodies (~11k)
    // and knowledge docs (~33k) arrive as ONE string; a tighter total would
    // envelope-clip playbooks mid-procedure.
    expect(LIVE_RESULT_LIMITS.maxString).toBe(40_000)
    expect(LIVE_RESULT_LIMITS.maxTotal).toBe(48_000)
    expect(LIVE_RESULT_LIMITS.maxTotal).toBeGreaterThan(LIVE_RESULT_LIMITS.maxString)
    const doc = "k".repeat(33_000)
    const out = truncateToolResult({ body: doc, title: "returns playbook" }, LIVE_RESULT_LIMITS)
    expect((out as { body: string }).body).toBe(doc)
  })

  it("replay limits are far tighter than live limits", () => {
    expect(REPLAY_RESULT_LIMITS.maxTotal).toBeLessThan(LIVE_RESULT_LIMITS.maxTotal)
    const body = "y".repeat(30_000)
    const v = { items: [{ body }] }
    const live = truncateToolResult(v, LIVE_RESULT_LIMITS) as { items: Array<{ body: string }> }
    const replay = truncateToolResult(v, REPLAY_RESULT_LIMITS) as {
      items: Array<{ body: string }>
    }
    expect(live.items[0]!.body.length).toBeGreaterThan(replay.items[0]!.body.length)
  })

  it("degrades to a serialized-head envelope when clipping strings is not enough", () => {
    // 20k tiny items — no single string is long, but the total blows the cap.
    const v = { items: Array.from({ length: 20_000 }, (_, i) => ({ id: `item-${i}` })) }
    const out = truncateToolResult(v, REPLAY_RESULT_LIMITS) as {
      truncatedResult?: string
      note?: string
    }
    expect(typeof out.truncatedResult).toBe("string")
    expect(out.truncatedResult!.length).toBeLessThanOrEqual(REPLAY_RESULT_LIMITS.maxTotal)
    expect(out.note).toContain("size cap")
  })

  it("handles plain-string results", () => {
    const s = "z".repeat(40_000)
    const out = truncateToolResult(s, REPLAY_RESULT_LIMITS) as string
    expect(typeof out).toBe("string")
    expect(out.length).toBeLessThan(3_000)
    expect(out).toContain("truncated by the platform")
  })
})

describe("a demo visitor's live tool results", () => {
  it("are cut to the visitor limits, which are far below the live ones", async () => {
    const { truncateToolResultForModel, VISITOR_RESULT_LIMITS, LIVE_RESULT_LIMITS } = await import(
      "./result-truncation"
    )
    const big = { body: "x".repeat(30_000), rows: Array.from({ length: 50 }, (_, i) => `row ${i}`) }
    const live = JSON.stringify(truncateToolResultForModel(big)).length
    const visitor = JSON.stringify(truncateToolResultForModel(big, { visitor: true })).length
    expect(live).toBeGreaterThan(20_000)
    expect(visitor).toBeLessThanOrEqual(VISITOR_RESULT_LIMITS.maxTotal + 400)
    expect(VISITOR_RESULT_LIMITS.maxTotal).toBeLessThan(LIVE_RESULT_LIMITS.maxTotal / 4)
  })
})
