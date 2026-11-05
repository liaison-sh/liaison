// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins intra-run micro-compaction: as a run accumulates steps, tool results
// older than the keep-window are clipped IN THE STEP MESSAGES down to the
// replay cap, once each. Without this, a 48k-char result from step 2 rides
// verbatim in every one of the remaining ~38 steps (the dominant uncached
// token sink measured in prod routine ticks). The clip-once set guarantees
// byte-stability after the first clip, so each clip costs exactly one
// prompt-cache re-anchor near the tail and then re-caches.
import { describe, expect, test } from "bun:test"
import { REPLAY_RESULT_LIMITS } from "~/modules/agent/runtime/result-truncation"
import {
  type ClipLedger,
  clipStaleToolResults,
  KEEP_RECENT_TOOL_RESULTS,
  STALE_CLIP_BATCH_CHARS,
} from "~/modules/agent/runtime/stale-result-clipper"

function toolMsg(id: string, value: unknown) {
  return {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: id,
        toolName: "tickets__get",
        output: { type: "json" as const, value },
      },
    ],
  }
}

const big = () => ({ blob: "x".repeat(60_000) })

describe("clipStaleToolResults", () => {
  test("keep-window is 4 recent results", () => {
    expect(KEEP_RECENT_TOOL_RESULTS).toBe(4)
  })

  test("clips results older than the keep-window to the replay cap, keeps recent ones verbatim", () => {
    const msgs = [
      { role: "user", content: "go" },
      toolMsg("old-1", big()),
      toolMsg("old-2", big()),
      ...[1, 2, 3, 4].map((i) => toolMsg(`recent-${i}`, big())),
    ]
    const clippedIds: ClipLedger = new Map()
    const out = clipStaleToolResults(msgs, clippedIds)
    // Old results clipped under the replay cap.
    for (const idx of [1, 2]) {
      const part = (out.messages[idx] as ReturnType<typeof toolMsg>).content[0]!
      expect(JSON.stringify(part.output.value).length).toBeLessThanOrEqual(
        REPLAY_RESULT_LIMITS.maxTotal + 500,
      )
    }
    // Recent 4 untouched — same references.
    for (const idx of [2, 3, 4, 5]) {
      expect(out.messages[idx + 1]).toBe(msgs[idx + 1] as never)
    }
    expect(out.clippedCount).toBe(2)
    expect([...clippedIds.keys()]).toEqual(["old-1", "old-2"])
  })

  test("clip-once: a second pass changes nothing (byte-stability for the prompt cache)", () => {
    const msgs = [toolMsg("a", big()), ...[1, 2, 3, 4].map((i) => toolMsg(`r${i}`, big()))]
    const clippedIds: ClipLedger = new Map()
    const first = clipStaleToolResults(msgs, clippedIds)
    const second = clipStaleToolResults(first.messages, clippedIds)
    expect(second.clippedCount).toBe(0)
    expect(second.messages).toBe(first.messages)
  })

  // The SDK hands prepareStep ITS message list, which never carries our clips:
  // a result clipped at step N arrives full at step N+1. It must come back
  // clipped to the very same bytes, or the prefix changes twice per result
  // (full again, then clipped again) and each change is a fresh cache write.
  test("a clipped result stays clipped, byte-identical, when the SDK re-sends it full", () => {
    const step1 = [
      toolMsg("a", big()),
      toolMsg("b", big()),
      ...[1, 2, 3, 4].map((i) => toolMsg(`r${i}`, big())),
    ]
    const ledger: ClipLedger = new Map()
    const first = clipStaleToolResults(step1, ledger)
    expect(first.clippedCount).toBe(2)
    // Next step: the SDK's own (unclipped) history plus one new result. r1
    // leaves the keep window alone, under the batch: it waits, unclipped.
    const step2 = [...step1, toolMsg("r5", big())]
    const second = clipStaleToolResults(step2, ledger)
    expect(second.clippedCount).toBe(0)
    expect(second.rewrittenCount).toBe(2) // a and b re-applied
    expect(JSON.stringify(second.messages.slice(0, 2))).toBe(
      JSON.stringify(first.messages.slice(0, 2)),
    )
    expect(second.messages[2]).toBe(step2[2] as never)
    expect(second.firstMutableIndex).toBe(2)
    // One more: r1 and r2 together pass the batch and are clipped in one rewrite.
    const step3 = [...step2, toolMsg("r6", big())]
    const third = clipStaleToolResults(step3, ledger)
    expect(third.clippedCount).toBe(2)
    expect(JSON.stringify(third.messages.slice(0, 2))).toBe(
      JSON.stringify(first.messages.slice(0, 2)),
    )
    expect(third.firstMutableIndex).toBe(4)
  })

  // A clip re-bills everything after it at the full input price, while the
  // stale result it shrinks is read from cache. One result per step was one
  // re-read of the keep window per step; a batch is one re-read per batch.
  test("stale results wait until they add up to a batch", () => {
    expect(STALE_CLIP_BATCH_CHARS).toBeGreaterThan(60_000)
    const msgs = [toolMsg("a", big()), ...[1, 2, 3, 4].map((i) => toolMsg(`r${i}`, big()))]
    const ledger: ClipLedger = new Map()
    const out = clipStaleToolResults(msgs, ledger)
    expect(out.clippedCount).toBe(0)
    expect(out.messages).toBe(msgs)
    expect(ledger.has("a")).toBe(false)
    expect(out.firstMutableIndex).toBe(0)
  })

  test("small old results pass through by reference (no gratuitous rewrites)", () => {
    const msgs = [toolMsg("s", { ok: true }), ...[1, 2, 3, 4].map((i) => toolMsg(`r${i}`, big()))]
    const out = clipStaleToolResults(msgs, new Map())
    expect(out.messages[0]).toBe(msgs[0] as never)
    expect(out.clippedCount).toBe(0)
  })

  test("non-tool messages and unknown part shapes are untouched", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]
    const out = clipStaleToolResults(msgs, new Map())
    expect(out.messages).toBe(msgs)
    expect(out.clippedCount).toBe(0)
  })

  test("text outputs clip too", () => {
    const msgs = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "t",
            toolName: "web_fetch",
            output: { type: "text" as const, value: "y".repeat(STALE_CLIP_BATCH_CHARS + 1_000) },
          },
        ],
      },
      ...[1, 2, 3, 4].map((i) => toolMsg(`r${i}`, big())),
    ]
    const out = clipStaleToolResults(msgs, new Map())
    const part = (out.messages[0] as { content: Array<{ output: { value: string } }> }).content[0]!
    expect(part.output.value.length).toBeLessThan(20_000)
    expect(part.output.value).toContain("truncated by the platform")
    expect(out.clippedCount).toBe(1)
  })
})
