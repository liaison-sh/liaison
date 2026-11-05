// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  isNodeGuardrailLevel,
  NODE_GUARDRAIL_LEVELS,
  nodeGuardrailRiskNote,
  suggestedNodeGuardrail,
} from "./node-guardrails"
import { isNodeLevel, NODE_LEVELS } from "./node-levels"

describe("node guardrail levels (D18)", () => {
  it("suggests Strict for Haiku class, Standard for Opus class, never Open", () => {
    expect(suggestedNodeGuardrail("claude-haiku-4-5")).toBe("strict")
    expect(suggestedNodeGuardrail("claude-haiku-4-5-20251001")).toBe("strict")
    expect(suggestedNodeGuardrail("claude-opus-5-5")).toBe("standard")
    expect(suggestedNodeGuardrail("claude-fable-5")).toBe("standard")
    expect(suggestedNodeGuardrail("anthropic/claude-opus-5")).toBe("standard")
    expect(suggestedNodeGuardrail("claude-sonnet-5")).toBe("strict")
    expect(suggestedNodeGuardrail("gemini-2.5-flash-lite")).toBe("strict")
    expect(suggestedNodeGuardrail(null)).toBe("strict")
  })
})

describe("the risk note (D18, D20, L13)", () => {
  it("never names GitHub branch protection and stays agent-neutral", () => {
    for (const level of ["strict", "standard"] as const) {
      const note = nodeGuardrailRiskNote(level)
      expect(note).not.toContain("GitHub")
      expect(note).not.toContain("branch protection")
      expect(note).not.toContain("Bug Fixer")
      expect(note).toContain("Untrusted input")
    }
    expect(nodeGuardrailRiskNote("standard")).toContain(
      "Suggested level for this agent's model: Standard.",
    )
    expect(nodeGuardrailRiskNote("strict")).toContain(
      "Suggested level for this agent's model: Strict.",
    )
  })
})

describe("the old names alias the level table", () => {
  it("NODE_GUARDRAIL_LEVELS and isNodeGuardrailLevel read node-levels", () => {
    expect(NODE_GUARDRAIL_LEVELS).toBe(NODE_LEVELS)
    expect(isNodeGuardrailLevel).toBe(isNodeLevel)
  })
})
