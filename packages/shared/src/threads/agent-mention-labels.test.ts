// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { relabelAgentMentions } from "./agent-mention-labels"

const ID = "6f0c2a52-6b8e-4f5e-9a59-0d3c9a1e2b7f"
const handles = new Map([[ID, "@adas-agent"]])
const handleOf = (id: string) => handles.get(id)

describe("relabelAgentMentions", () => {
  it("names an agent mention by its current handle, not the stored label", () => {
    expect(relabelAgentMentions(`@[ada](agent:${ID}) can you check?`, handleOf)).toBe(
      `@[adas-agent](agent:${ID}) can you check?`,
    )
  })

  it("keeps the stored label when the agent is unknown", () => {
    const other = "11111111-2222-4333-8444-555555555555"
    expect(relabelAgentMentions(`@[ada](agent:${other}) hi`, handleOf)).toBe(
      `@[ada](agent:${other}) hi`,
    )
  })

  it("leaves people and entity mentions alone", () => {
    const text = `@[Ada](user:${ID}) and @[Spec](knowledge:document:${ID})`
    expect(relabelAgentMentions(text, handleOf)).toBe(text)
  })

  it("handles an escaped label", () => {
    expect(relabelAgentMentions(`@[a\\]b](agent:${ID})`, handleOf)).toBe(
      `@[adas-agent](agent:${ID})`,
    )
  })
})
