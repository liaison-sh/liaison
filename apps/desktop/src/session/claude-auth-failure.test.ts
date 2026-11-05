// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which sidecar lines say "Claude on this computer is not signed in", in the
// CLI's own words (read out of the pinned CLI), and which do not.

import { describe, expect, it } from "vitest"
import { claudeAuthFailureOf, isClaudeAuthError } from "./claude-auth-failure"

describe("isClaudeAuthError", () => {
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Not logged in · Please run /login",
    "Invalid API key · Please run /login",
    "OAuth token revoked · Please run /login",
    "Failed to authenticate. API Error: 401",
    "authentication_failed",
  ])("recognises %s", (text) => {
    expect(isClaudeAuthError(text)).toBe(true)
  })

  it.each(["Claude Code process exited with code 1", "rate limited", "", null, 42])(
    "does not take %s for one",
    (text) => {
      expect(isClaudeAuthError(text)).toBe(false)
    },
  )
})

describe("claudeAuthFailureOf", () => {
  it("reads the assistant message the SDK marks authentication_failed", () => {
    expect(
      claudeAuthFailureOf({
        type: "message",
        payload: {
          type: "assistant",
          error: "authentication_failed",
          message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        },
      }),
    ).toBe("Not logged in · Please run /login")
  })

  it("reads an error result in the CLI's words, and a sidecar error line", () => {
    expect(
      claudeAuthFailureOf({
        type: "message",
        payload: { type: "result", is_error: true, result: "Invalid API key · Please run /login" },
      }),
    ).toBe("Invalid API key · Please run /login")
    expect(
      claudeAuthFailureOf({
        type: "error",
        message: "Failed to authenticate: OAuth session expired",
      }),
    ).toBe("Failed to authenticate: OAuth session expired")
  })

  it("never takes the agent's own words for a failure", () => {
    expect(
      claudeAuthFailureOf({
        type: "message",
        payload: {
          type: "assistant",
          message: { content: [{ type: "text", text: "You are not logged in to the site." }] },
        },
      }),
    ).toBeNull()
    expect(
      claudeAuthFailureOf({
        type: "message",
        payload: { type: "result", is_error: false, result: "Please run /login first" },
      }),
    ).toBeNull()
    expect(claudeAuthFailureOf({ type: "turn_done" })).toBeNull()
  })
})
