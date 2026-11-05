// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SKILL INDEX'S PREAMBLE NAMES WHOSE SKILLS THESE ARE.
//
// A desktop local session runs on the Claude Agent SDK, which carries its own
// local `Skill` tool. Under the old wording ("Each line below is a pointer...")
// a small model read "## Skills available", called that LOCAL tool with a
// Liaison skill name and got "Unknown skill", twice, before falling back to
// skill_read. The preamble then said the names were Liaison's and that
// "skill_read" loads them, and Claude Haiku 4.5 still called the local tool
// first, then guessed `kernel__skill_search`: neither is a tool name inside a
// local session. It now names the exact tools (`mcp__liaison__kernel__...`),
// the sidecar no longer offers the local Skill tool at all, and the gateway
// marks the two skill tools always loaded. The desktop renders the same sentence
// (apps/desktop/src/session/agent-definition-client.ts `SKILLS_PREAMBLE`, whose
// test compares it with this file's literal), so the budget the API measures
// is the text a session carries.
import { describe, expect, it } from "bun:test"
import { AGENT_DEFINITION_SKILLS_PREAMBLE, renderAgentDefinitionText } from "./context"

const EXPECTED =
  "Each line below names a Liaison skill, served by the Liaison MCP server, never by a local Skill tool: load one by calling the tool mcp__liaison__kernel__skill_read with the skill's exact name, then follow its instructions. mcp__liaison__kernel__skill_search finds one by keyword. Both are loaded from the start: call them directly, no tool search first."

describe("AGENT_DEFINITION_SKILLS_PREAMBLE", () => {
  it("names the exact local tools that load and find a Liaison skill", () => {
    expect(AGENT_DEFINITION_SKILLS_PREAMBLE).toBe(EXPECTED)
  })

  it("is the sentence the composed definition reads the skill index under", () => {
    const text = renderAgentDefinitionText({
      systemPrompt: "you are an agent",
      skillIndex: [{ name: "rapport-mensuel", description: "monthly report" }],
      scopedMemory: [],
      mcpToolList: [],
    } as unknown as Parameters<typeof renderAgentDefinitionText>[0])
    expect(text).toContain(`## Skills available\n${EXPECTED}\n- rapport-mensuel: monthly report`)
  })
})
