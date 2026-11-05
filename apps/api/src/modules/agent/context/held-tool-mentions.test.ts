// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel's prompt names only tools the turn holds. A routine tick without
// kernel:skills:read was told by system.md to `kernel__skill_read` a playbook,
// called it, and was refused; these pin the filter on the real template.
import { describe, expect, it } from "bun:test"
import { composeTurnSystemText, loadPrompt } from "~/modules/agent/context/context"
import {
  namedKernelTools,
  withoutUnheldToolMentions,
} from "~/modules/agent/context/held-tool-mentions"

async function systemText(): Promise<string> {
  return composeTurnSystemText(await loadPrompt("system.md", ""), "Acme")
}

describe("the prompt names only held tools", () => {
  it("over the real system.md, a turn without skill_read is never told to call it", async () => {
    const text = await systemText()
    expect(namedKernelTools(text)).toContain("kernel__skill_read")
    // A support routine's catalog: no skills scope, no web, no sub-agents.
    const held = new Set(["kernel__tool_search", "tickets__get", "tickets__reply"])
    const filtered = withoutUnheldToolMentions(text, held)
    expect(filtered).not.toContain("kernel__skill_read")
    // Every kernel tool the filtered text still names is one the turn holds.
    for (const name of namedKernelTools(filtered)) expect(held.has(name)).toBe(true)
    // What names no tool stays: the rule around the dropped sentence survives.
    expect(filtered).toContain("A skill matches on the task's goal, not on its wording.")
    expect(filtered).toContain(
      "**The platform decides what needs approval, so execute what the user asked.**",
    )
  })

  it("a turn that holds every tool it is told about reads the text unchanged", async () => {
    const text = await systemText()
    expect(withoutUnheldToolMentions(text, new Set(namedKernelTools(text)))).toBe(text)
  })

  it("keeps a list marker with its first kept sentence and drops a line left empty", () => {
    const held = new Set(["kernel__tool_search"])
    expect(
      withoutUnheldToolMentions(
        "7. Call `kernel__skill_read` first. Then act.\n- Use kernel__web_fetch.\n- Use `kernel__tool_search`.",
        held,
      ),
    ).toBe("7. Then act.\n- Use `kernel__tool_search`.")
    expect(namedKernelTools("call mcp__liaison__kernel__skill_read")).toEqual([
      "kernel__skill_read",
    ])
  })
})
