// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M0.3 — surfacing Boxtal's validation detail on a 422. Without this, a rejected
// shipment returned an opaque "rejected (422)" with no actionable field; the
// live run proved Boxtal's body carries the exact field (e.g. fromAddress.contact.email).
import { describe, expect, it } from "bun:test"
import { summarizeBoxtalError } from "./shipment"

describe("summarizeBoxtalError", () => {
  it("joins the texts from a v3 messages[] body", () => {
    const body = JSON.stringify({
      messages: [
        { severity: "ERROR", text: "shipment.fromAddress.contact.email: missing value" },
        { severity: "ERROR", text: "shipment.toAddress.contact.email: missing value" },
      ],
    })
    expect(summarizeBoxtalError(body)).toBe(
      "shipment.fromAddress.contact.email: missing value; shipment.toAddress.contact.email: missing value",
    )
  })

  it("falls back to a single `message` field", () => {
    expect(summarizeBoxtalError(JSON.stringify({ message: "no offer found" }))).toBe("no offer found")
  })

  it("returns a truncated raw body for non-JSON / unknown shapes", () => {
    expect(summarizeBoxtalError("plain text error")).toBe("plain text error")
    expect(summarizeBoxtalError("x".repeat(400)).length).toBe(300)
  })

  it("returns empty string for an empty body", () => {
    expect(summarizeBoxtalError("")).toBe("")
  })
})
