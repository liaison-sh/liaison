// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { historyUsedNotificationTools, NOTIFICATION_CHANGE_NOTE } from "./settings-change-note"

const call = (toolName: string) => ({
  role: "assistant",
  content: [
    { type: "text", text: "Done." },
    { type: "tool-call", toolCallId: "c1", toolName, input: {} },
  ],
})

describe("historyUsedNotificationTools", () => {
  it("fires once the history holds a notification tool call, whatever its prefix", () => {
    for (const name of [
      "notifications_set",
      "kernel__notifications_set",
      "kernel:thread_mute_set",
      "notification_rules_set",
      "notifications_get",
    ]) {
      expect(historyUsedNotificationTools([{ role: "user", content: "hi" }, call(name)])).toBe(true)
    }
  })

  it("stays silent in every other conversation", () => {
    expect(historyUsedNotificationTools([])).toBe(false)
    expect(
      historyUsedNotificationTools([
        { role: "user", content: "turn off notifications_set please" },
        { role: "assistant", content: "notifications_set is a tool" },
        call("tickets__search"),
        call("notify_user"),
      ]),
    ).toBe(false)
  })

  it("the note tells the model a change needs a tool result in this turn", () => {
    expect(NOTIFICATION_CHANGE_NOTE).toContain("THIS turn")
    expect(NOTIFICATION_CHANGE_NOTE).toContain("never say it did")
  })
})
