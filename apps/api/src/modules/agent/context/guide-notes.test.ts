// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import {
  GUIDE_NOTES_META_KEY,
  guidePartsInMessages,
  lastToolResultCallId,
  readGuideNotes,
  renderGuideNote,
  withGuideNotes,
} from "~/modules/agent/context/guide-notes"

describe("guide notes", () => {
  it("names the parts it carries, and only a guide note counts", () => {
    const note = renderGuideNote(["### tickets\nUse tickets."], ["tickets", "tickets#2"])
    expect(note.startsWith("<runtime-context")).toBe(true)
    const parts = guidePartsInMessages([
      { role: "user", content: note },
      { role: "user", content: '<runtime-context note="ephemeral" parts="mail">' },
      { role: "assistant", content: note },
    ])
    expect([...parts].sort()).toEqual(["tickets", "tickets#2"])
  })

  it("keeps each note where it was sent among the step responses", () => {
    const n1 = { role: "user", content: "n1" }
    const n2 = { role: "user", content: "n2" }
    const r = ["a0", "t0", "a1", "t1"].map((content) => ({ role: "x", content }))
    expect(
      withGuideNotes(r, [
        { at: 2, message: n1 },
        { at: 4, message: n2 },
      ]).map((m) => m.content),
    ).toEqual(["a0", "t0", "n1", "a1", "t1", "n2"])
    expect(withGuideNotes(r, []).map((m) => m.content)).toEqual(["a0", "t0", "a1", "t1"])
  })

  it("finds the last tool result's call", () => {
    expect(
      lastToolResultCallId([
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1" }] },
        { role: "assistant", content: "x" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c2" },
            { type: "tool-result", toolCallId: "c3" },
          ],
        },
      ]),
    ).toBe("c3")
    expect(lastToolResultCallId([{ role: "assistant", content: "x" }])).toBeNull()
  })

  it("reads only well-formed stored notes", () => {
    expect(
      readGuideNotes({
        [GUIDE_NOTES_META_KEY]: [
          { afterToolCallId: null, content: "a" },
          { afterToolCallId: "c1", content: "b" },
          { afterToolCallId: 3, content: "c" },
          { afterToolCallId: "c2" },
        ],
      }),
    ).toEqual([
      { afterToolCallId: null, content: "a" },
      { afterToolCallId: "c1", content: "b" },
    ])
    expect(readGuideNotes(null)).toEqual([])
  })

  it("replays a turn's notes where the turn sent them", () => {
    const call = (id: string) => ({
      toolCallId: id,
      toolName: "kernel__tool_search",
      args: { query: id },
      result: { ok: id },
    })
    const rows = [
      { id: "u1", authorType: "user", content: "find it", metadata: null },
      {
        id: "a1",
        authorType: "agent",
        content: "Looking.Done.",
        metadata: {
          toolCalls: [call("c1"), call("c2")],
          timeline: [
            { kind: "text", text: "Looking." },
            { kind: "tool", toolCallId: "c1" },
            { kind: "tool", toolCallId: "c2" },
            { kind: "text", text: "Done." },
          ],
          [GUIDE_NOTES_META_KEY]: [
            { afterToolCallId: null, content: "start-note" },
            { afterToolCallId: "c2", content: "step-note" },
          ],
        },
      },
    ]
    const out = convertToCoreMessages(rows)
    expect(out.map((m) => (typeof m.content === "string" ? m.content : m.role))).toEqual([
      "find it",
      "start-note",
      "assistant",
      "tool",
      "step-note",
      "Done.",
    ])
  })
})
