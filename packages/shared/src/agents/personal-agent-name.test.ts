// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  agentSpeakerName,
  ownerFirstName,
  PERSONAL_AGENT_DISPLAY_NAME,
  personalAgentLabel,
} from "./personal-agent-name"

describe("personal agent names", () => {
  it("names a personal agent after its owner's first name", () => {
    expect(personalAgentLabel("Tobias Braun")).toBe("Tobias's agent")
    expect(personalAgentLabel("  Avery   Lin ")).toBe("Avery's agent")
    expect(ownerFirstName("Tobias Braun")).toBe("Tobias")
  })

  it("an unnamed owner falls back to the product default, never an empty possessive", () => {
    expect(personalAgentLabel("")).toBe(PERSONAL_AGENT_DISPLAY_NAME)
    expect(personalAgentLabel(null)).toBe(PERSONAL_AGENT_DISPLAY_NAME)
  })
})

// A personal agent posted into its owner's DM with a teammate signed as the bare
// "Personal agent": the teammate could not tell whose agent spoke.
describe("agentSpeakerName", () => {
  it("signs a personal agent as its owner's, whatever its stored name", () => {
    expect(
      agentSpeakerName({
        displayName: "Personal agent",
        kind: "personal",
        ownerName: "Tobias Braun",
      }),
    ).toBe("Tobias's agent")
    expect(
      agentSpeakerName({ displayName: "Jarvis", kind: "personal", ownerName: "Tobias Braun" }),
    ).toBe("Tobias's agent")
  })

  it("keeps a named agent's own display name", () => {
    expect(agentSpeakerName({ displayName: "Finance Desk", kind: "role", ownerName: null })).toBe(
      "Finance Desk",
    )
    expect(agentSpeakerName({ displayName: "Liaison", kind: "system" })).toBe("Liaison")
  })

  it("a personal agent with a nameless owner keeps its stored name; nothing names nobody", () => {
    expect(
      agentSpeakerName({ displayName: "Personal agent", kind: "personal", ownerName: "" }),
    ).toBe("Personal agent")
    expect(agentSpeakerName({ displayName: "  ", kind: "role" })).toBeNull()
  })
})
