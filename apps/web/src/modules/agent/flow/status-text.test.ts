// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  describeStep,
  describeTrigger,
  type FlowNames,
  markedNames,
  statusTextParts,
} from "./flow-model"

const S_NEW = "11111111-1111-4111-8111-111111111111"
const S_DONE = "33333333-3333-4333-8333-333333333333"

const NAMES: FlowNames = {
  t: (key: string, vars?: Record<string, unknown>) =>
    key === "kernel.routineFlow.triggerTo"
      ? `When a task in ${vars?.project} moves to ${vars?.to}`
      : key === "kernel.routineFlow.setStatus"
        ? `Move it to ${vars?.status}`
        : key,
  project: {
    id: "p",
    name: "Website",
    statuses: [
      { id: S_NEW, label: "New", color: "#3b82f6" },
      { id: S_DONE, label: "Done" },
    ],
    fields: [],
  },
}

const pills = (text: string) =>
  statusTextParts(NAMES, text)
    .filter((p) => p.kind === "status")
    .map((p) => p.text)

describe("status pills in flow copy", () => {
  it("pills only the status the template inserted, never the same word elsewhere", () => {
    const text = describeTrigger(
      markedNames(NAMES),
      "projects:task:status_changed",
      { projectId: "p", toStatusId: S_DONE },
      "",
    )
    expect(pills(text)).toEqual(["Done"])
    const parts = statusTextParts(NAMES, text)
    // The marks never reach the text.
    expect(parts.map((p) => p.text).join("")).toBe("When a task in Website moves to Done")
  })

  it("free text (a description) never pills, even a sentence starting with a status name", () => {
    expect(pills("New leads land here. Done means shipped.")).toEqual([])
    expect(statusTextParts(NAMES, "New leads land here.")).toEqual([
      { kind: "text", text: "New leads land here." },
    ])
  })

  it("a marked status carries its colour; unmarked copy keeps plain status names", () => {
    const step = {
      id: "s",
      type: "action",
      action: "set_status",
      args: { statusId: S_NEW },
    } as Parameters<typeof describeStep>[1]
    const marked = statusTextParts(NAMES, describeStep(markedNames(NAMES), step))
    expect(marked.find((p) => p.kind === "status")).toEqual({
      kind: "status",
      text: "New",
      color: "#3b82f6",
    })
    expect(describeStep(NAMES, step)).not.toMatch(/[⁨⁩]/)
  })
})
