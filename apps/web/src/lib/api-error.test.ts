// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"

describe("ApiError constructor", () => {
  it("sets message, status, code, retryAfter and details as given", () => {
    const error = new ApiError("boom", 429, "rate_limited", 30, { reason: "too fast" })
    expect(error.message).toBe("boom")
    expect(error.status).toBe(429)
    expect(error.code).toBe("rate_limited")
    expect(error.retryAfter).toBe(30)
    expect(error.details).toEqual({ reason: "too fast" })
  })
})

describe("ApiError#retryable", () => {
  it.each([
    [429, true],
    [500, true],
    [503, true],
    [0, true],
    [200, false],
    [400, false],
    [404, false],
  ])("status %i -> retryable %s", (status, expected) => {
    expect(new ApiError("msg", status).retryable).toBe(expected)
  })
})
