// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The prod watchdog pages on every NEW error-level signature, so the levels of
// two agent runtime lines are policy: an expected condition the runtime already
// handles is a warn, a fault is an error.
import { describe, expect, test } from "bun:test"
import { InvalidToolInputError, NoSuchToolError } from "ai"
import { checkpointSkipLogLevel, toolErrorLogLevel } from "~/modules/agent/runtime/agent-service"

describe("checkpointSkipLogLevel", () => {
  test("no line when the advance landed or the tail is under the budget", () => {
    expect(checkpointSkipLogLevel({ advanced: true, overBudget: true })).toBeNull()
    expect(
      checkpointSkipLogLevel({ advanced: false, overBudget: false, reason: "under-budget" }),
    ).toBeNull()
  })

  test("a brief writer that produced nothing (provider refused, no model, no credits) is a warn", () => {
    expect(
      checkpointSkipLogLevel({ advanced: false, overBudget: true, reason: "no-summary" }),
    ).toBe("warn")
  })

  test("an over budget tail the advance found no boundary in stays an error", () => {
    expect(
      checkpointSkipLogLevel({ advanced: false, overBudget: true, reason: "under-reserve" }),
    ).toBe("error")
    expect(checkpointSkipLogLevel({ advanced: false, overBudget: true, reason: "empty" })).toBe(
      "error",
    )
  })
})

describe("toolErrorLogLevel", () => {
  test("a call to a tool the model does not hold is the model's mistake: warn", () => {
    const err = new NoSuchToolError({
      toolName: "kernel__approvals_list",
      availableTools: ["kernel__memory_view"],
    })
    expect(toolErrorLogLevel(err)).toBe("warn")
  })

  test("input that fails the tool's schema is the model's mistake: warn", () => {
    const err = new InvalidToolInputError({
      toolName: "kernel__memory_view",
      toolInput: "{}",
      cause: new Error("path is required"),
    })
    expect(toolErrorLogLevel(err)).toBe("warn")
  })

  test("a throw that escaped the tool bridge is a fault: error", () => {
    expect(toolErrorLogLevel(new Error("boom"))).toBe("error")
  })
})
