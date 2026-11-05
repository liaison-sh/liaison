// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The house style rule belongs to the BASE prompt, not to one persona: agents
// were writing em dashes into customer replies, which the product forbids
// everywhere else. Both composition points are covered, so an agent with its
// own instructions and an agent with none carry the identical rule.
import { describe, expect, it } from "bun:test"
import {
  AGENT_STYLE_RULE,
  composeDefinitionSystemPrompt,
  composeTurnSystemText,
  loadPrompt,
} from "./context"

const CUSTOM = "You are Ada, the accounting agent. Always answer in French."

describe("the base system prompt carries the house style rule", () => {
  it("the rule itself uses no dash punctuation", () => {
    expect(/[–—]|\s--\s/.test(AGENT_STYLE_RULE)).toBe(false)
  })

  it("an in-app turn's base text carries it once, over the real system.md", async () => {
    const template = await loadPrompt("system.md", "")
    expect(template.length).toBeGreaterThan(100)
    const text = composeTurnSystemText(template, "Acme")
    expect(text).toContain(AGENT_STYLE_RULE)
    expect(text.split(AGENT_STYLE_RULE).length - 1).toBe(1)
    expect(text).not.toContain("{{orgName}}")
    expect(text).toContain("Acme")
  })

  it("a default agent, with no custom instructions, still gets the rule", () => {
    expect(composeDefinitionSystemPrompt([])).toBe(AGENT_STYLE_RULE)
  })

  it("a custom-instruction agent keeps its instructions AND gets the rule", () => {
    const out = composeDefinitionSystemPrompt([CUSTOM, "<agent-charter>...</agent-charter>"])
    expect(out).toContain(CUSTOM)
    expect(out).toContain("<agent-charter>")
    expect(out).toContain(AGENT_STYLE_RULE)
  })

  it("an agent whose own instructions already quote the rule is not given it twice", () => {
    const out = composeDefinitionSystemPrompt([`${CUSTOM} ${AGENT_STYLE_RULE}`])
    expect(out.split(AGENT_STYLE_RULE).length - 1).toBe(1)
  })
})

describe("the base system prompt grounds every figure in a tool result", () => {
  // The live QA of the role agents on gemini-flash-lite: a KPI answered 394
  // where the tool said 126, a proposal called "submitted" while the tool was
  // unavailable, and the matching skill read in 5 turns of 31.
  const base = async () =>
    composeTurnSystemText(await loadPrompt("system.md", ""), "Acme").replace(/\s+/g, " ")

  it("a business figure comes only from a tool call that succeeded in this conversation", async () => {
    const text = await base()
    expect(text).toContain(
      "State a business figure (an amount, a count, a rate, a KPI) only when a tool call that succeeded in this conversation returned it",
    )
    expect(text).toContain("never estimate, recall or fill one in")
  })

  it("a failed or unavailable tool is said plainly and never reported as done", async () => {
    expect(await base()).toContain(
      "When a tool fails or is unavailable, say so plainly, give no figure, and never say the action happened.",
    )
  })

  it("an answer that needs a lookup is written after its result, never guessed first (walk 4, N16)", async () => {
    expect(await base()).toContain(
      "When an answer needs a lookup, call the tool first and write the answer after its result: never write a guessed record, field list or status before reading it, and never answer twice in one reply.",
    )
  })

  it("the matching skill is read before a multi-step or customer-facing task", async () => {
    expect(await base()).toContain(
      "Read the matching skill before a multi-step or customer-facing task",
    )
  })
})
