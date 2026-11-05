// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a turn persists: its whole text in a private chat, only the final step
// in a conversation other people read.
import { describe, expect, test } from "bun:test"
import type { TurnTimelineEntry } from "~/modules/agent/runtime/agent-service"
import {
  createLiveTextGate,
  replyForAudience,
  textAfterLastTool,
  withoutInterimText,
} from "~/modules/agent/runtime/shared-thread-reply"

const NARRATION = "I'll read the task first, then break it into subtasks.\n\n"
const RETRY = "I need to name the parent. Retrying with the parent id.\n\n"
const ANSWER = "Three subtasks are filed under the task. @Sam, the stand plan is in the first one."

const timeline: TurnTimelineEntry[] = [
  { kind: "text", text: NARRATION },
  { kind: "tool", toolCallId: "c1" },
  { kind: "reasoning", text: "the parent is missing" },
  { kind: "text", text: RETRY },
  { kind: "tool", toolCallId: "c2" },
  { kind: "reasoning", text: "done" },
  { kind: "text", text: ANSWER },
]
const fullText = NARRATION + RETRY + ANSWER

describe("replyForAudience", () => {
  test("a shared thread persists only the text after the last tool call", () => {
    const out = replyForAudience({ shared: true, text: fullText, timeline })
    expect(out.text).toBe(ANSWER)
    expect(out.text).not.toContain("Retrying")
    // The interim lines leave the stored timeline too; tools and reasoning stay.
    expect(out.timeline).toEqual([
      { kind: "tool", toolCallId: "c1" },
      { kind: "reasoning", text: "the parent is missing" },
      { kind: "tool", toolCallId: "c2" },
      { kind: "reasoning", text: "done" },
      { kind: "text", text: ANSWER },
    ])
  })

  test("a private chat keeps every line, drawn where it was written", () => {
    const out = replyForAudience({ shared: false, text: fullText, timeline })
    expect(out.text).toBe(fullText)
    expect(out.timeline).toBe(timeline)
  })

  test("a caller's own final-step text wins over the joined text", () => {
    expect(replyForAudience({ shared: true, text: fullText, finalStepText: ANSWER }).text).toBe(
      ANSWER,
    )
  })

  test("a shared turn that ended on a tool call has no answer, so the stop line applies", () => {
    const endedOnTool: TurnTimelineEntry[] = [
      { kind: "text", text: NARRATION },
      { kind: "tool", toolCallId: "c1" },
    ]
    expect(replyForAudience({ shared: true, text: NARRATION, timeline: endedOnTool }).text).toBe("")
  })

  test("a turn with no tool call keeps all its text", () => {
    const plain: TurnTimelineEntry[] = [{ kind: "text", text: ANSWER }]
    expect(textAfterLastTool(plain)).toBe(ANSWER)
    expect(withoutInterimText(plain)).toEqual(plain)
  })
})

describe("createLiveTextGate", () => {
  /** Drives the gate through `timeline`'s shape, one step per tool boundary. */
  function stream(shared: boolean): string[] {
    const sent: string[] = []
    const gate = createLiveTextGate(shared, (delta) => sent.push(delta))
    gate.text("I'll read ")
    gate.text("the task first.")
    gate.toolCall()
    gate.stepFinished()
    gate.text(RETRY)
    gate.toolCall()
    gate.stepFinished()
    gate.text("Three subtasks ")
    gate.text("are filed.")
    gate.stepFinished()
    gate.flush()
    return sent
  }

  test("a shared thread never sends a step's text when the step calls a tool", () => {
    expect(stream(true)).toEqual(["Three subtasks are filed."])
  })

  test("a private chat sends every delta as it arrives", () => {
    expect(stream(false)).toEqual([
      "I'll read ",
      "the task first.",
      RETRY,
      "Three subtasks ",
      "are filed.",
    ])
  })

  test("text after a step's last tool call is the answer when no tool follows", () => {
    const sent: string[] = []
    const gate = createLiveTextGate(true, (delta) => sent.push(delta))
    gate.text("checking")
    gate.toolCall()
    gate.text("Done: ")
    gate.stepFinished()
    expect(sent).toEqual([])
    gate.text("the stand plan is filed.")
    gate.stepFinished()
    expect(sent).toEqual(["Done: the stand plan is filed."])
    gate.flush()
    expect(sent).toHaveLength(1)
  })

  test("a turn that stops mid-answer sends what it holds, as the stored reply does", () => {
    const sent: string[] = []
    const gate = createLiveTextGate(true, (delta) => sent.push(delta))
    gate.text("Half an answ")
    gate.flush()
    expect(sent).toEqual(["Half an answ"])
  })
})
