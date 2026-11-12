// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Op errors carry the HTTP status they answer with: a refusal, a missing setting or an answer
// from Pennylane is not a server fault, so it must not read as a 500 (which pages the watchdog).
import { describe, expect, test } from "bun:test"
import { PennylaneApiError, PennylaneRateLimitError } from "../lib/pennylane-client"
import { fromException, opError } from "./errors"

describe("op error statuses", () => {
  test("a missing public address and bad input are 422", () => {
    expect(opError("callback_base_url_missing", "x").error.status).toBe(422)
    expect(opError("invalid_input", "x").error.status).toBe(422)
  })

  test("Pennylane refusing the token is a failed dependency, not a server fault", () => {
    const e = fromException(new PennylaneApiError(403, '{"error":"scope"}'), "webhooks_setup")
    expect(e.error).toMatchObject({ code: "provider_unauthorized", status: 424 })
  })

  test("a rate limit is 429 and a Pennylane outage 502", () => {
    expect(fromException(new PennylaneRateLimitError(Date.now() + 1000), "x").error.status).toBe(
      429,
    )
    expect(fromException(new PennylaneApiError(503, ""), "x").error.status).toBe(502)
  })

  test("an unanticipated failure keeps the kernel's default (no status)", () => {
    expect(fromException(new Error("boom"), "x").error.status).toBeUndefined()
  })
})
