// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isProviderCreditBlockError } from "./provider-errors"

describe("isProviderCreditBlockError", () => {
  it("matches the Gemini monthly-spend-cap error (the captured BL-177 message)", () => {
    // The exact AI_RetryError last-error string captured from a capped chaos run.
    const msg =
      "Failed after 3 attempts. Last error: Your project has exceeded its monthly spending cap. " +
      "Please go to AI Studio at https://ai.studio/spend to manage your project spend cap."
    expect(isProviderCreditBlockError(new Error(msg))).toBe(true)
    expect(isProviderCreditBlockError(msg)).toBe(true)
  })

  it("matches the credit/quota-exhaustion family across providers", () => {
    for (const m of [
      "RESOURCE_EXHAUSTED: quota exceeded",
      "429 insufficient_quota",
      "You exceeded your current quota, please check your plan and billing",
      "Billing hard limit has been reached",
      "spend cap reached",
      "monthly spending limit",
    ]) {
      expect(isProviderCreditBlockError(new Error(m))).toBe(true)
    }
  })

  it("does NOT match a transient rate-limit or unrelated errors (must stay retryable, not hard-block)", () => {
    for (const m of [
      "429 Too Many Requests: rate limit exceeded, retry after 2s",
      "fetch failed: ECONNRESET",
      "503 Service Unavailable",
      "tool execution failed: invalid_params",
      "waitForSelector: Timeout 60000ms exceeded",
      "",
    ]) {
      expect(isProviderCreditBlockError(new Error(m))).toBe(false)
    }
    expect(isProviderCreditBlockError(null)).toBe(false)
    expect(isProviderCreditBlockError(undefined)).toBe(false)
  })
})
