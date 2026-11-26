// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { humanizeToolName, shownToolCall } from "~/modules/approvals/tool-name"

describe("shownToolCall", () => {
  it("reads a call through kernel:call_tool as the tool it calls", () => {
    const shown = shownToolCall("kernel:call_tool", {
      name: "kernel__contacts_write",
      arguments: { name: "Hélène Marchand" },
    })
    expect(shown).toEqual({
      toolName: "kernel:contacts_write",
      payload: { name: "Hélène Marchand" },
    })
    expect(humanizeToolName(shown.toolName)).toBe("Workspace: contacts write")
  })

  it("takes a canonical name too, and leaves every other call as it is", () => {
    expect(shownToolCall("kernel:call_tool", { name: "projects:create" }).toolName).toBe(
      "projects:create",
    )
    const reply = { ticketId: "t1" }
    expect(shownToolCall("tickets:reply", reply)).toEqual({
      toolName: "tickets:reply",
      payload: reply,
    })
    // Nothing to unwrap: the entry stays itself.
    expect(shownToolCall("kernel:call_tool", { arguments: {} }).toolName).toBe("kernel:call_tool")
  })
})
