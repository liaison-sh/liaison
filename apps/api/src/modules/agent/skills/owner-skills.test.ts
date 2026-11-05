// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  OWNER_SKILL_BUDGET_BYTES,
  renderOwnerSkillsBlock,
  selectOwnerSkills,
} from "~/modules/agent/skills/owner-skills"

const row = (name: string, bytes: number, updatedAt: string) => ({
  name,
  body: "x".repeat(bytes),
  requiredScopes: [],
  updatedAt: new Date(updatedAt),
})

describe("owner skill budget", () => {
  it("takes the most recently updated first and names what does not fit", () => {
    const big = Math.floor(OWNER_SKILL_BUDGET_BYTES * 0.6)
    const sel = selectOwnerSkills([
      row("old-big", big, "2026-01-01"),
      row("new-big", big, "2026-09-01"),
      row("small", 200, "2025-01-01"),
    ])
    expect(sel.injected.map((s) => s.name)).toEqual(["new-big", "small"])
    expect(sel.deferred).toEqual(["old-big"])
    const block = renderOwnerSkillsBlock(sel)
    expect(block).toContain("## Skill: new-big")
    expect(block).not.toContain("## Skill: old-big")
    expect(block).toContain("not loaded here for space: old-big")
  })

  it("renders nothing when the agent owns no marked skill", () => {
    expect(renderOwnerSkillsBlock(selectOwnerSkills([]))).toBe("")
  })
})

describe("owner skills a turn cannot load", () => {
  it("are not listed to a turn without kernel__skill_read, which would be sent into a refused call", () => {
    const big = Math.floor(OWNER_SKILL_BUDGET_BYTES * 0.6)
    const sel = selectOwnerSkills([
      row("old-big", big, "2026-01-01"),
      row("new-big", big, "2026-09-01"),
    ])
    const block = renderOwnerSkillsBlock(sel, { canReadSkills: false })
    expect(block).toContain("## Skill: new-big")
    expect(block).not.toContain("kernel__skill_read")
    expect(block).not.toContain("old-big")
    // Only deferred skills, none loadable: nothing to say.
    const onlyDeferred = { injected: [], deferred: ["old-big"] }
    expect(renderOwnerSkillsBlock(onlyDeferred, { canReadSkills: false })).toBe("")
  })
})
