// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { withPriorSteps } from "~/modules/agent/runtime/agent-service"
import { createReplyText, joinStepTexts } from "~/modules/agent/runtime/reply-flatten"

describe("the stored reply of a turn", () => {
  it("a stored reply of three steps keeps a blank line between them", () => {
    const reply = createReplyText()
    for (const step of [["I checked ", "these."], ["Drafted the invoice."], ["Done."]]) {
      for (const delta of step) reply.add(delta)
      reply.endStep()
    }
    expect(reply.text).toBe("I checked these.\n\nDrafted the invoice.\n\nDone.")
  })

  it("text within one step is kept exactly as streamed", () => {
    const reply = createReplyText()
    for (const delta of ["Line one.\n", "Line two ", "and more."]) reply.add(delta)
    expect(reply.text).toBe("Line one.\nLine two and more.")
  })

  it("a step that wrote nothing, or only whitespace, adds no blank paragraph", () => {
    const reply = createReplyText()
    reply.add("First.")
    reply.endStep()
    reply.endStep()
    reply.add("\n")
    reply.endStep()
    reply.add(" Second.")
    expect(reply.text).toBe("First.\n\nSecond.")
  })

  it("a step's own trailing newlines are not doubled", () => {
    expect(joinStepTexts(["First.\n\n", "\nSecond."])).toBe("First.\n\nSecond.")
  })

  it("a resumed turn's earlier steps and its new text are separated the same way", () => {
    const view = (text: string) => ({
      text,
      reasoning: "",
      timeline: [],
      toolCalls: [],
      toolResults: [],
      toolErrors: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const merged = withPriorSteps(
      {
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
        text: "Third.",
        steps: [],
      },
      [view("First."), view("Second.")] as never,
    )
    expect(merged.text).toBe("First.\n\nSecond.\n\nThird.")
  })
})
