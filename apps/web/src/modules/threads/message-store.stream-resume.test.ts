// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * S10 / M1: a turn another process takes over. Process A streamed step 1 (a
 * tool call and its result, seq 1 to 3) and part of step 2 (text and
 * reasoning, seq 4 and 5), then died. Process B claims the turn, deletes the
 * cut step's frames from the live stream and publishes a `resume` frame
 * (seq 6, `rewindToSeq` 3); it then re-issues step 2, whose frames follow from
 * seq 7. The viewer must not keep A's half of step 2 next to B's whole one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import {
  getAgentStream,
  handleWsAgentStreamEvent,
  loadMessages,
  resetMessageStore,
} from "~/modules/threads/message-store"

const threadId = "t-resume"
const agentId = "agent-1"
const turnId = "ask-1"
const base = { threadId, agentId, turnId, askId: turnId }

const CUT_TEXT = "Found the tick"
const STEP2_TEXT = "Found the ticket. "
const STEP3_TEXT = "It shipped yesterday."

function frame(action: string, data: Record<string, unknown>): void {
  handleWsAgentStreamEvent(action, { ...base, ...data })
}

/** A's frames: step 1 complete, step 2 cut after part of its text and reasoning. */
function streamOnA(): void {
  frame("start", { seq: 0 })
  frame("tool_call", {
    toolCallId: "A",
    toolName: "search_tickets",
    args: {},
    seq: 1,
    itemId: "A",
    itemKind: "tool",
  })
  frame("tool_result", {
    toolCallId: "A",
    result: { ok: true },
    seq: 2,
    itemId: "A",
    itemKind: "tool",
  })
  frame("delta", { delta: "", seq: 3, itemId: "b1", itemKind: "text" })
  frame("delta", { delta: CUT_TEXT, seq: 4, itemId: "t-cut", itemKind: "text" })
  frame("reasoning", { delta: "Half a thought", seq: 5, itemId: "r-cut", itemKind: "reasoning" })
}

/** The server after the takeover: the frames through the boundary, at the resume's seq. */
function server(snapshotSeq: number) {
  const state = { calls: 0 }
  const run = {
    agentId,
    turnId,
    askId: turnId,
    state: "streaming",
    content: "",
    reasoning: "",
    reasoningStreaming: false,
    toolCalls: [
      {
        toolCallId: "A",
        toolName: "search_tickets",
        args: {},
        status: "completed",
        result: { ok: true },
      },
    ],
    timeline: [{ kind: "tool", toolCallId: "A", itemId: "A" }],
    startedAt: Date.now(),
    seq: snapshotSeq,
  }
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/agent/stream-state/")) {
        state.calls += 1
        return { data: { active: true, ...run, streams: [run] } }
      }
      return { data: [] }
    }),
  }
  return { api, state }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("a resumed turn's live view (S10)", () => {
  beforeEach(() => resetMessageStore())
  afterEach(() => resetMessageStore())

  it("the resume frame drops the cut step's text, and the re-issued step draws once", async () => {
    const { api, state } = server(6)
    await loadMessages(api, threadId)
    state.calls = 0
    streamOnA()
    expect(getAgentStream(threadId, agentId).content).toBe(CUT_TEXT)

    frame("resume", { seq: 6, rewindToSeq: 3 })
    // B's re-issued step 2 can overtake the snapshot's answer: it waits for it.
    frame("delta", { delta: STEP2_TEXT, seq: 7, itemId: "t2", itemKind: "text" })
    frame("delta", { delta: STEP3_TEXT, seq: 8, itemId: "t2", itemKind: "text" })
    await settle()

    expect(state.calls).toBe(1)
    const stream = getAgentStream(threadId, agentId)
    expect(stream.content).toBe(STEP2_TEXT + STEP3_TEXT)
    expect(stream.content).not.toContain(CUT_TEXT + STEP2_TEXT)
    expect(stream.reasoning ?? "").not.toContain("Half a thought")
    expect(stream.timeline.map((e) => e.kind)).toEqual(["tool", "text"])
    expect(stream.toolCalls.map((c) => c.toolCallId)).toEqual(["A"])
  })

  it("a late copy of a cut frame after the resume is not drawn", async () => {
    const { api } = server(6)
    await loadMessages(api, threadId)
    streamOnA()
    frame("resume", { seq: 6, rewindToSeq: 3 })
    await settle()
    // A's frame 5 arrives late (a publish retry): the snapshot is past it.
    frame("reasoning", { delta: "Half a thought", seq: 5, itemId: "r-cut", itemKind: "reasoning" })
    frame("delta", { delta: STEP2_TEXT, seq: 7, itemId: "t2", itemKind: "text" })
    const stream = getAgentStream(threadId, agentId)
    expect(stream.content).toBe(STEP2_TEXT)
    expect(stream.reasoning ?? "").toBe("")
  })
})
