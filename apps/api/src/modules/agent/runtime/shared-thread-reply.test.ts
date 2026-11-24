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
    gate.toolCall("str__probeTool")
    gate.stepFinished()
    gate.text(RETRY)
    gate.toolCall("str__probeTool")
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
    gate.toolCall("str__probeTool")
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

// A reply's next steps are drawn under the answer, so the tool that offers them closes the reply: it
// is not the work a shared thread leaves out, and the words before it are the answer.
describe("an answer closed by its next steps", () => {
  const CHIPS = { kind: "tool", toolCallId: "chips", closes: true } as const
  const shared = (entries: TurnTimelineEntry[]) =>
    replyForAudience({ shared: true, text: "unused", timeline: entries })

  /** The gate driven by `entries`, every entry after the first of a step ending it at a tool. */
  function live(entries: TurnTimelineEntry[]): string {
    const sent: string[] = []
    const gate = createLiveTextGate(true, (delta) => sent.push(delta))
    for (const entry of entries) {
      if (entry.kind === "text") gate.text(entry.text)
      if (entry.kind === "tool") {
        gate.toolCall(entry.closes ? "kernel__suggest_next_steps" : "str__probeTool")
        gate.stepFinished()
      }
    }
    gate.stepFinished()
    gate.flush()
    return sent.join("")
  }

  const cases: Array<[string, TurnTimelineEntry[], string]> = [
    [
      "is the reply when the chips are the turn's end",
      [{ kind: "text", text: ANSWER }, CHIPS],
      ANSWER,
    ],
    [
      "is the reply when the chips were refused and asked for again",
      [{ kind: "text", text: ANSWER }, CHIPS, CHIPS],
      ANSWER,
    ],
    [
      "leaves out the notes before the last tool that gathered",
      [
        { kind: "text", text: NARRATION },
        { kind: "tool", toolCallId: "c1" },
        { kind: "text", text: ANSWER },
        CHIPS,
      ],
      ANSWER,
    ],
    [
      "keeps what follows the chips as a paragraph of its own",
      [{ kind: "text", text: ANSWER }, CHIPS, { kind: "text", text: "Pick one and I start." }],
      `${ANSWER}\n\nPick one and I start.`,
    ],
    [
      "is said once when the model says it again after the chips",
      [
        { kind: "text", text: ANSWER },
        CHIPS,
        { kind: "text", text: ` ${ANSWER.replace(/\.$/, "!")}` },
      ],
      ` ${ANSWER.replace(/\.$/, "!")}`,
    ],
    [
      "is kept alone when what follows the chips only repeats a part of it",
      [{ kind: "text", text: ANSWER }, CHIPS, { kind: "text", text: "Three subtasks are filed." }],
      ANSWER,
    ],
    [
      "is a note when a tool that gathers follows the chips",
      [
        { kind: "text", text: NARRATION },
        CHIPS,
        { kind: "tool", toolCallId: "c1" },
        { kind: "text", text: ANSWER },
      ],
      ANSWER,
    ],
  ]
  for (const [name, entries, reply] of cases) {
    test(name, () => {
      expect(shared(entries).text).toBe(reply)
      expect(live(entries)).toBe(reply)
    })
  }

  test("is kept when it is no more than a sign", () => {
    expect(shared([{ kind: "text", text: "👍" }, CHIPS]).text).toBe("👍")
    expect(live([{ kind: "text", text: "👍" }, CHIPS])).toBe("👍")
  })

  test("is said once when the model words it again after the chips", () => {
    const long =
      "The harbour job bills 800 a month for ten hours, 80 an hour, and 95 above that rate. " +
      "The planner is off until Thursday, so the March hours wait for the approval of the owner."
    const again = `To recap: ${long.replace("bills", "is billed at").replace("wait for", "need")}`
    expect(shared([{ kind: "text", text: long }, CHIPS, { kind: "text", text: again }]).text).toBe(
      again,
    )
    const other = "Nothing else is open on the account this week, and no invoice is late for it."
    expect(shared([{ kind: "text", text: long }, CHIPS, { kind: "text", text: other }]).text).toBe(
      `${long}\n\n${other}`,
    )
  })

  test("the timeline keeps the answer before the chips, and drops one said again", () => {
    expect(shared([{ kind: "text", text: ANSWER }, CHIPS]).timeline).toEqual([
      { kind: "text", text: ANSWER },
      CHIPS,
    ])
    expect(
      shared([{ kind: "text", text: ANSWER }, CHIPS, { kind: "text", text: ANSWER }]).timeline,
    ).toEqual([CHIPS, { kind: "text", text: ANSWER }])
  })
})
