// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { detectAutoResponder } from "./inbound-auto-responder"

describe("detectAutoResponder", () => {
  it.each([
    [{ "Auto-Submitted": [" auto-replied "] }, "auto_submitted:auto-replied"],
    [{ "auto-submitted": ["auto-generated"] }, "auto_submitted:auto-generated"],
    [{ "auto-submitted": ["auto-notified"] }, "auto_submitted:auto-notified"],
    [{ precedence: ["bulk"] }, "precedence:bulk"],
    [{ precedence: ["junk"] }, "precedence:junk"],
    [{ precedence: ["list"] }, "precedence:list"],
    [{ "list-id": ["<news.list.test>"] }, "list-id"],
    [{ "x-auto-response-suppress": ["All"] }, "x-auto-response-suppress"],
  ])("flags %p as %s", (headers, expected) => {
    expect(detectAutoResponder(headers as never)).toBe(expected)
  })

  it("passes a normal customer email", () => {
    expect(
      detectAutoResponder({ from: ["alice@cust.test"], subject: ["help"] } as never),
    ).toBeNull()
  })

  it("does not false-flag Reply-To: noreply@", () => {
    expect(detectAutoResponder({ "reply-to": ["noreply@x.test"] } as never)).toBeNull()
  })

  it("does not false-flag Auto-Submitted: no", () => {
    expect(detectAutoResponder({ "Auto-Submitted": [" no "] } as never)).toBeNull()
  })
})
