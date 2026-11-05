// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { type DmWindowTag, dmReplyWindow, dmWindowTag } from "./dm-window"

const NOW = Date.parse("2026-06-01T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const H = 3_600_000
const D = 24 * H

const cases: Array<[string, string, DmWindowTag]> = [
  ["just now", ago(0), "none"],
  ["23h59m", ago(24 * H - 60_000), "none"],
  ["exactly 24h", ago(24 * H), "none"], // Δ ≤ 24h → none (inclusive)
  ["24h + 1s", ago(24 * H + 1000), "human_agent"],
  ["3 days", ago(3 * D), "human_agent"],
  ["exactly 7d", ago(7 * D), "human_agent"], // Δ ≤ 7d → human_agent (inclusive)
  ["7d + 1s", ago(7 * D + 1000), "closed"],
  ["30 days", ago(30 * D), "closed"],
]

describe("dmWindowTag (B2)", () => {
  test.each(cases)("%s → %s", (_label, ts, expected) => {
    expect(dmWindowTag(ts, new Date(NOW))).toBe(expected)
  })

  test("null lastInboundAt → closed (no inbound ever)", () => {
    expect(dmWindowTag(null, new Date(NOW))).toBe("closed")
  })

  test("NaN timestamp → closed", () => {
    expect(dmWindowTag("not-a-date", new Date(NOW))).toBe("closed")
  })
})

describe("dmReplyWindow — agent-readable descriptor (aged-DM-window honesty)", () => {
  test("standard window (≤24h): canSend, tag none, explanation says normal in-platform reply", () => {
    const w = dmReplyWindow(ago(2 * H), new Date(NOW))
    expect(w.tag).toBe("none")
    expect(w.canSend).toBe(true)
    expect(w.daysSinceLastInbound).toBe(0)
    expect(w.explanation).toContain("24-hour")
    expect(w.explanation.toLowerCase()).toContain("approval")
  })

  test("~5-day inbound → HUMAN-AGENT window: canSend true, tag human_agent, surfaces outside-24h", () => {
    const w = dmReplyWindow(ago(5 * D), new Date(NOW))
    expect(w.tag).toBe("human_agent")
    expect(w.canSend).toBe(true)
    expect(w.daysSinceLastInbound).toBe(5)
    // The descriptor must SAY it is outside the standard window and goes as a human-agent message —
    // this is the exact signal the flash-lite agent surfaces (instead of computing it from a raw ts).
    expect(w.explanation).toContain("human-agent")
    expect(w.explanation).toContain("24-hour")
  })

  test("exactly 7d → still human_agent (inclusive boundary), canSend", () => {
    const w = dmReplyWindow(ago(7 * D), new Date(NOW))
    expect(w.tag).toBe("human_agent")
    expect(w.canSend).toBe(true)
  })

  test("closed window (>7d): canSend false, tag closed, explanation points to native app", () => {
    const w = dmReplyWindow(ago(8 * D), new Date(NOW))
    expect(w.tag).toBe("closed")
    expect(w.canSend).toBe(false)
    expect(w.explanation.toLowerCase()).toContain("native app")
    expect(w.explanation.toLowerCase()).toContain("closed")
  })

  test("no inbound on record: closed, canSend false, daysSinceLastInbound null", () => {
    const w = dmReplyWindow(null, new Date(NOW))
    expect(w.tag).toBe("closed")
    expect(w.canSend).toBe(false)
    expect(w.daysSinceLastInbound).toBeNull()
    expect(w.explanation.toLowerCase()).toContain("native app")
  })
})
