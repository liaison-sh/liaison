// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  createRunTokenAccount,
  hardTokenLimitReached,
  hardTokenLimitStopText,
  stepTokens,
  withTokenBudgetSentence,
} from "~/modules/agent/runtime/run-token-limit"

describe("routine token budget + hard limit helpers (S17, A34)", () => {
  it("the budget sentence is appended to the prompt, verbatim", () => {
    expect(withTokenBudgetSentence("Do the job.", { tokenBudget: 12000 })).toBe(
      "Do the job.\n\nYou have about 12000 tokens for this job. Plan your work to finish within it.",
    )
  })

  it("no budget leaves the prompt untouched", () => {
    expect(withTokenBudgetSentence("Do the job.", {})).toBe("Do the job.")
    expect(withTokenBudgetSentence("Do the job.", { tokenBudget: null, hardTokenLimit: 9 })).toBe(
      "Do the job.",
    )
  })

  it("a step costs input (cached included) plus output", () => {
    // AI SDK 7: inputTokens already includes the cache reads and writes.
    expect(
      stepTokens({
        inputTokens: 250,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 150, cacheWriteTokens: 0 },
      }),
    ).toBe(300)
    expect(stepTokens(undefined)).toBe(0)
  })

  it("no account without either field; the limit is reached at the limit", () => {
    expect(createRunTokenAccount({})).toBeUndefined()
    expect(createRunTokenAccount({ tokenBudget: null, hardTokenLimit: null })).toBeUndefined()
    const account = createRunTokenAccount({ hardTokenLimit: 500 })
    expect(account).toEqual({
      id: expect.any(String),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    })
    if (!account) throw new Error("unreachable")
    account.used = 499
    expect(hardTokenLimitReached(account)).toBe(false)
    account.used = 500
    expect(hardTokenLimitReached(account)).toBe(true)
    expect(hardTokenLimitReached(undefined)).toBe(false)
    expect(
      hardTokenLimitReached({ id: "x", tokenBudget: 10, hardTokenLimit: null, used: 1_000_000 }),
    ).toBe(false)
  })

  it("the stop text names the limit", () => {
    expect(hardTokenLimitStopText(500)).toBe("Stopped at the hard limit of 500 tokens.")
  })
})
