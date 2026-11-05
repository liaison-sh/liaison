// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { refuseTool, ToolError } from "./errors"

describe("ToolError", () => {
  it("carries a safe, code-tagged message and is an Error", () => {
    const err = new ToolError("No invoicing document found for X", {
      code: "no_anchor_document",
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ToolError")
    expect(err.safe).toBe(true)
    expect(err.code).toBe("no_anchor_document")
    expect(err.message).toBe("No invoicing document found for X")
  })

  it("defaults retryable to false when not supplied", () => {
    const err = new ToolError("boom", { code: "some_code" })
    expect(err.retryable).toBe(false)
  })

  it("honors an explicit retryable override", () => {
    const err = new ToolError("boom", { code: "some_code", retryable: true })
    expect(err.retryable).toBe(true)
  })

  it("exposes enumerable fields so a QuickJS ctx.dump preserves them across the sandbox boundary", () => {
    // The sandbox host detects a safe tool error by the DUMPED error's fields.
    // ctx.dump serializes an Error's own enumerable properties, so name/safe/code/
    // retryable must be own-enumerable (a plain object spread must see them).
    const err = new ToolError("safe message", { code: "no_anchor_document", retryable: false })
    const dumped: Record<string, unknown> = { ...(err as unknown as Record<string, unknown>) }
    expect(dumped.name).toBe("ToolError")
    expect(dumped.safe).toBe(true)
    expect(dumped.code).toBe("no_anchor_document")
    expect(dumped.retryable).toBe(false)
  })
})

describe("refuseTool", () => {
  it("builds the error envelope a handler returns, marked as a deliberate refusal", () => {
    expect(
      refuseTool("buyer_vat_id_required", "Nothing was created. Find the VAT number."),
    ).toEqual({
      status: "error",
      error: {
        code: "buyer_vat_id_required",
        message: "Nothing was created. Find the VAT number.",
        retryable: false,
        refusal: true,
      },
    })
  })

  it("carries retryable and a body when given", () => {
    const r = refuseTool("some_code", "msg", { retryable: true, body: { candidates: [1] } })
    expect(r.error.retryable).toBe(true)
    expect(r.error.body).toEqual({ candidates: [1] })
  })
})
