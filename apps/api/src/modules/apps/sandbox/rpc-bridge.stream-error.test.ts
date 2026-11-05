// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (marco-mondial-relay-pickup-expiry-followup, 1-of-3 gate run): a provider
// stream error whose envelope carried NO nested `.message` collapsed to a bare, opaque
// "agent stream error" in the judge transcript — indistinguishable from a real product
// fault. `formatStreamError` now assembles an actionable message from the richest
// envelope signal fields (name/statusCode/code/responseBody/cause) so a swallowed stream
// hiccup can never look like a content fault again (conventions: field-level error
// observability).
import { describe, expect, it } from "bun:test"
import { formatStreamError } from "~/modules/apps/sandbox/rpc-bridge"

describe("formatStreamError", () => {
  it("returns a nested provider message verbatim (error.error.error.message)", () => {
    const e = { error: { error: { message: "Quota exceeded for model" } } }
    expect(formatStreamError(e)).toBe("Quota exceeded for model")
  })

  it("returns a top-level message verbatim", () => {
    expect(formatStreamError(new Error("boom"))).toBe("boom")
  })

  it("passes a plain string through unchanged", () => {
    expect(formatStreamError("rate limited")).toBe("rate limited")
  })

  it("assembles an actionable message from envelope fields when no nested message exists", () => {
    // The exact shape that previously collapsed to the bare opaque string: an envelope
    // with signal fields but no human `.message` anywhere.
    const e = {
      name: "APICallError",
      statusCode: 529,
      code: "overloaded_error",
      responseBody: '{"type":"overloaded_error"}',
    }
    const out = formatStreamError(e)
    expect(out).not.toBe("agent stream error")
    expect(out).toContain("APICallError")
    expect(out).toContain("status=529")
    expect(out).toContain("code=overloaded_error")
    expect(out).toContain("body=")
  })

  it("surfaces a cause when the outer envelope is bare", () => {
    const e = { cause: { name: "ConnectionError", code: "ECONNRESET" } }
    const out = formatStreamError(e)
    expect(out).not.toBe("agent stream error")
    expect(out).toContain("cause=ConnectionError")
  })

  it("falls back to a JSON dump for an unrecognised non-empty object (never opaque)", () => {
    const out = formatStreamError({ weird: "shape" })
    expect(out).not.toBe("agent stream error")
    expect(out).toContain("weird")
  })

  it("returns the bare default only for a genuinely empty/unknown error", () => {
    expect(formatStreamError({})).toBe("agent stream error")
    expect(formatStreamError(null)).toBe("agent stream error")
    expect(formatStreamError(undefined)).toBe("agent stream error")
  })
})
