// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  isModelSelectable,
  resolveEffectiveAgentModel,
} from "~/modules/agent/runtime/model-override"

describe("effective model for an agent turn", () => {
  it("prefers the conversation's override over the agent's default", () => {
    expect(
      resolveEffectiveAgentModel({
        threadModelId: "gemini-2.5-flash",
        agentModelPreference: "claude-opus-4-5",
      }),
    ).toBe("gemini-2.5-flash")
  })

  it("falls back to the agent's OWN default when the chat pins nothing", () => {
    // The default used to be a column nothing read: an unpinned chat went
    // straight to the org's auto-select and the agent's model was ignored.
    expect(
      resolveEffectiveAgentModel({
        threadModelId: null,
        agentModelPreference: "claude-opus-4-5",
      }),
    ).toBe("claude-opus-4-5")
  })

  it("falls through to auto-select when neither is set", () => {
    expect(resolveEffectiveAgentModel({})).toBeNull()
    expect(
      resolveEffectiveAgentModel({ threadModelId: null, agentModelPreference: null }),
    ).toBeNull()
  })
})

describe("who may pin a conversation to a model", () => {
  it("refuses a model the org cannot call", () => {
    expect(isModelSelectable("gpt-5", ["claude-haiku-4-5"])).toBe(false)
  })

  it("accepts a model the picker offers", () => {
    expect(isModelSelectable("claude-haiku-4-5", ["claude-haiku-4-5"])).toBe(true)
  })

  it("always lets a chat go back to the default", () => {
    expect(isModelSelectable(null, [])).toBe(true)
    expect(isModelSelectable(undefined, [])).toBe(true)
  })
})
