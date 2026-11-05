// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the per-run input-token runaway guard policy: a run whose CUMULATIVE
// input tokens cross the hard cap is aborted as a bug (finishReason
// "token_budget_exceeded", error-logged so the watchdog pages); crossing the
// warn threshold logs once for the daily digest. The thresholds encode the
// operator contract: a healthy support/routine turn costs well under 500k input
// tokens — anything above 1M is a pathology to investigate, never normal load.
import { describe, expect, test } from "bun:test"
import {
  AGENT_RUN_INPUT_TOKEN_CAP,
  AGENT_RUN_INPUT_TOKEN_WARN,
  runawayGuardDecision,
} from "~/modules/agent/runtime/agent-service"

describe("runawayGuardDecision", () => {
  test("the hard cap is 1.5M uncached input tokens and the warn threshold is half of it", () => {
    expect(AGENT_RUN_INPUT_TOKEN_CAP).toBe(1_500_000)
    expect(AGENT_RUN_INPUT_TOKEN_WARN).toBe(750_000)
  })

  test("under the warn threshold: none", () => {
    expect(runawayGuardDecision(0, false)).toBe("none")
    expect(runawayGuardDecision(749_999, false)).toBe("none")
    expect(runawayGuardDecision(AGENT_RUN_INPUT_TOKEN_WARN, false)).toBe("none")
  })

  test("over the warn threshold: warn once, then none while under the cap", () => {
    expect(runawayGuardDecision(750_001, false)).toBe("warn")
    // Already logged → no repeat warns for the same run.
    expect(runawayGuardDecision(900_000, true)).toBe("none")
  })

  test("over the hard cap: abort, regardless of warn state", () => {
    expect(runawayGuardDecision(1_500_001, false)).toBe("abort")
    expect(runawayGuardDecision(1_500_001, true)).toBe("abort")
    // Exactly at the cap is still allowed — the guard fires strictly above it.
    expect(runawayGuardDecision(AGENT_RUN_INPUT_TOKEN_CAP, true)).toBe("none")
  })

  test("a single oversized step jumps straight to abort (no warn required first)", () => {
    expect(runawayGuardDecision(9_348_347, false)).toBe("abort")
  })
})
