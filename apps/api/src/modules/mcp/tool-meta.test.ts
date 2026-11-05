// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SKILL TOOLS ARE LISTED ALWAYS LOADED.
//
// Claude Code, and the Agent SDK inside the desktop's local session, defer an
// MCP server's tools behind their own tool search unless a tool's `_meta`
// carries `"anthropic/alwaysLoad": true`. The gateway's own instructions send
// the model to kernel__skill_read / kernel__skill_search before anything else,
// and a deferred pair cost a ToolSearch round trip, or a guessed name that is
// no tool, on the first turn of every local session. Only those two: the whole
// catalog pinned once overflowed the prompt.
import { describe, expect, it } from "bun:test"
import { ALWAYS_LOAD_TOOLS, mcpToolMeta } from "./tool-projection"

describe("mcpToolMeta", () => {
  it("marks the two skill tools always loaded", () => {
    expect(mcpToolMeta("kernel__skill_read")).toEqual({ "anthropic/alwaysLoad": true })
    expect(mcpToolMeta("kernel__skill_search")).toEqual({ "anthropic/alwaysLoad": true })
  })

  it("leaves every other tool deferrable", () => {
    for (const name of ["kernel__list_skills", "tickets__reply", "kpi__kpi_run", "skill_read"]) {
      expect(mcpToolMeta(name)).toBeUndefined()
    }
    expect([...ALWAYS_LOAD_TOOLS].sort()).toEqual(["kernel__skill_read", "kernel__skill_search"])
  })
})
