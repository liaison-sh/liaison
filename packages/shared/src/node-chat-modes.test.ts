// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { NODE_CHAT_PERMISSION_MODES } from "./node-chat-modes"

describe("My node chat permission modes (L23, D29)", () => {
  it("the list is exactly auto, manual, edit, plan, in that order", () => {
    expect([...NODE_CHAT_PERMISSION_MODES]).toEqual(["auto", "manual", "edit", "plan"])
  })
})
