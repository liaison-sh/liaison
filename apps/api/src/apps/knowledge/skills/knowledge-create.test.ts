// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSkillFile } from "~/modules/agent/skills/skill-loader"

const raw = readFileSync(join(import.meta.dir, "knowledge-create.md"), "utf8")
const skill = parseSkillFile(raw)

describe("knowledge-create skill", () => {
  it("frontmatter declares the right type, scopes, and a ≤100-char description", () => {
    expect(skill.meta.type).toBe("skill")
    expect(skill.meta.name).toBe("knowledge-create")
    expect(skill.meta.description.length).toBeLessThanOrEqual(100)
    expect(skill.meta.requiredScopes ?? []).toContain("knowledge:documents:create")
    expect(skill.meta.requiredScopes ?? []).toContain("knowledge:collections:manage")
  })

  it("prompt explains the document-vs-source_link decision rule", () => {
    expect(skill.content).toMatch(/document/i)
    expect(skill.content).toMatch(/source.link/i)
    expect(skill.content).toMatch(/pointer|body|content/i)
  })

  it("prompt names the import-source tools the agent should consider", () => {
    expect(skill.content).toMatch(/google-drive__search/i)
    expect(skill.content).toMatch(/google-drive__import/i)
    expect(skill.content).toMatch(/web_fetch/i)
    expect(skill.content).toMatch(/paste/i)
  })

  it("every kernel/connector tool name the skill cites is registered for a seeded org", async () => {
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    const TEST_ORG = "00000000-0000-0000-0000-000000fa0001"
    await registerKernelAgentTools(TEST_ORG)

    // Tools mentioned in this skill that are owned by the kernel (google-drive__* and
    // knowledge_* live in app manifests and need the manifest registry — they
    // are out of scope for this kernel-only assertion).
    const kernelToolsCited = ["web_fetch"]
    for (const name of kernelToolsCited) {
      expect(toolRegistry.get([TEST_ORG, "kernel", name])).toBeDefined()
    }
    toolRegistry.deleteByPrefix([TEST_ORG])
  })
})
