// SPDX-License-Identifier: FSL-1.1-ALv2
// The journal's stored size grows with the turn, not with its square (M7): a
// step stores what it added to the prep state, and a tool result its messages
// already hold is stored once. Parsing gives back every step's full state.
import { describe, expect, it } from "bun:test"
import {
  type JournalPrepState,
  type JournalStep,
  journalPayload,
  parseJournal,
} from "~/modules/agent/runtime/turn-journal"

const prep = (over: Partial<JournalPrepState>): JournalPrepState => ({
  discoveredTools: [],
  sentTools: [],
  guidePartsDelivered: [],
  guideNotes: [],
  midTurnGuideMessages: [],
  midTurnSkillsDelivered: [],
  clippedResultIds: [],
  effectKeys: {},
  scopes: [],
  readInternalData: false,
  originRows: {},
  taintedToolCallIds: [],
  ...over,
})

/** Step n: one tool call with a large result, one clip and one guide message added. */
function step(n: number): JournalStep {
  const id = `call-${n}`
  const result = { rows: "x".repeat(10_000), n }
  return {
    stepIndex: n,
    redacted: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "t", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "t",
            output: { type: "json", value: result },
          },
        ],
      },
    ],
    view: {
      text: "",
      reasoning: "",
      timeline: [],
      toolCalls: [{ toolCallId: id, toolName: "t", args: {} }],
      toolResults: [{ toolCallId: id, result }],
      toolErrors: [],
      finishReason: "tool-calls",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
    },
    // As journaled: only this step's additions.
    prep: prep({
      clippedResultIds: [[id, { clipped: n }]],
      midTurnGuideMessages: [{ at: n, content: `guide ${n}` }],
    }),
  }
}

describe("the turn journal (M7)", () => {
  it("stores a tool result the step's messages hold once, and gives it back on parse", () => {
    const s = step(1)
    const { json } = journalPayload(s)
    expect(json.split("x".repeat(10_000)).length - 1).toBe(1)
    const [parsed] = parseJournal([{ payload: { json } }])
    expect(parsed?.view.toolResults).toEqual(s.view.toolResults)
    expect(parsed?.messages).toEqual(s.messages)
  })

  it("a step's stored size does not grow with the turn's length; parse folds the deltas", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ payload: journalPayload(step(i + 1)) }))
    const sizes = rows.map((r) => r.payload.json.length)
    // Step 40 stores about what step 1 does (a few digits more), not 40 times it.
    expect(Math.max(...sizes)).toBeLessThan((sizes[0] ?? 0) * 1.05)
    const parsed = parseJournal(rows)
    expect(parsed).toHaveLength(40)
    const last = parsed[39]
    expect(last?.prep.clippedResultIds.map(([id]) => id)).toEqual(
      Array.from({ length: 40 }, (_, i) => `call-${i + 1}`),
    )
    expect(last?.prep.midTurnGuideMessages.map((g) => g.at)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    expect(parsed[0]?.prep.clippedResultIds).toEqual([["call-1", { clipped: 1 }]])
  })
})
