// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { loadSkillFiles, parseSkillFile } from "~/modules/agent/skills/skill-loader"

const PROMPTS_DIR = path.resolve(import.meta.dir, "..", "prompts")
const KERNEL_DIR = path.join(PROMPTS_DIR, "kernel")

// ---------- parseSkillFile ----------

describe("parseSkillFile", () => {
  it("extracts frontmatter and returns content without frontmatter", () => {
    const raw = `---
name: test-app
type: agent_instructions
description: A test app overview for validation
---

# Test App

This is the content.

Second paragraph.`

    const result = parseSkillFile(raw)
    expect(result.meta.name).toBe("test-app")
    expect(result.meta.type).toBe("agent_instructions")
    expect(result.meta.description).toBe("A test app overview for validation")
    expect(result.content).toBe("# Test App\n\nThis is the content.\n\nSecond paragraph.")
  })

  it("parses a kernel agent_instructions file", () => {
    const raw = `---\nname: kernel\ntype: agent_instructions\ndescription: kernel overview\n---\nThe kernel provides…`
    const f = parseSkillFile(raw)
    expect(f.meta).toEqual({
      name: "kernel",
      type: "agent_instructions",
      description: "kernel overview",
    })
    expect(f.content.startsWith("The kernel provides")).toBe(true)
  })

  it("parses a skill file with requiredScopes", () => {
    const raw = `---\nname: draft-reply\ntype: skill\ndescription: Draft a reply\nrequiredScopes: tickets:write, tickets:read\n---\n# Step 1`
    const f = parseSkillFile(raw)
    expect(f.meta.type).toBe("skill")
    expect(f.meta.requiredScopes).toEqual(["tickets:write", "tickets:read"])
  })

  it("rejects legacy type=overview", () => {
    const raw = `---\nname: kernel\ntype: overview\ndescription: x\n---\n# x`
    expect(() => parseSkillFile(raw)).toThrow(/invalid type/)
  })

  it("rejects legacy type=system", () => {
    const raw = `---\nname: system\ntype: system\ndescription: x\n---\n# x`
    expect(() => parseSkillFile(raw)).toThrow(/invalid type/)
  })

  it("requires description ≤100 chars for type=skill", () => {
    const raw = `---\nname: x\ntype: skill\ndescription: ${"a".repeat(101)}\n---\nbody`
    expect(() => parseSkillFile(raw)).toThrow(/100/)
  })

  it("throws on missing frontmatter", () => {
    expect(() => parseSkillFile("# No frontmatter\n\nJust content.")).toThrow(/frontmatter/)
  })

  it("throws on missing name field", () => {
    const raw = `---\ntype: agent_instructions\ndescription: Missing name\n---\nContent`
    expect(() => parseSkillFile(raw)).toThrow(/name/)
  })

  it("throws on missing type field", () => {
    const raw = `---\nname: test\ndescription: Missing type\n---\nContent`
    expect(() => parseSkillFile(raw)).toThrow(/type/)
  })

  it("throws on missing description field", () => {
    const raw = `---\nname: test\ntype: agent_instructions\n---\nContent`
    expect(() => parseSkillFile(raw)).toThrow(/description/)
  })
})

// ---------- loadSkillFiles ----------

describe("loadSkillFiles", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"))

    await fs.writeFile(
      path.join(tmpDir, "overview.md"),
      `---
name: test-app
type: agent_instructions
description: Test app overview for the agent
---

# Test App

This app provides testing capabilities.`,
    )

    await fs.writeFile(path.join(tmpDir, "README.txt"), "This should be ignored")
    await fs.writeFile(path.join(tmpDir, "broken.md"), "# No frontmatter here")
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it("loads files from directory", async () => {
    const skills = await loadSkillFiles(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.meta.name).toBe("test-app")
    expect(skills[0]!.meta.type).toBe("agent_instructions")
    expect(skills[0]!.content).toContain("testing capabilities")
  })

  it("ignores non-.md files", async () => {
    const skills = await loadSkillFiles(tmpDir)
    const names = skills.map((s) => s.meta.name)
    expect(names).not.toContain("README")
  })

  it("skips malformed skill files without crashing", async () => {
    const skills = await loadSkillFiles(tmpDir)
    expect(skills.length).toBe(1)
  })

  it("returns empty array for non-existent directory", async () => {
    const skills = await loadSkillFiles(`/tmp/does-not-exist-${Date.now()}`)
    expect(skills).toEqual([])
  })
})

// ---------- Kernel prompt files validation ----------
// Kernel system.md is loaded by other code paths (not as a skill-loader file
// anymore). Only the kernel overview.md is exercised here, after migration to
// the new `agent_instructions` type.

describe("kernel skill files", () => {
  it("kernel overview.md has valid frontmatter and describes capabilities", async () => {
    const skills = await loadSkillFiles(KERNEL_DIR)
    // Two agent_instructions files now exist (the `kernel` overview and the
    // `kernel-admin` admin guidance); select the overview by name rather than
    // assuming it's the only agent_instructions file.
    const overview = skills.find(
      (s) => s.meta.type === "agent_instructions" && s.meta.name === "kernel",
    )
    expect(overview).toBeDefined()
    expect(overview!.meta.name).toBe("kernel")
    expect(overview!.content).toContain("thread")
  })

  it("every kernel prompt file loads: an invalid one is skipped silently at boot", async () => {
    const files = (await fs.readdir(KERNEL_DIR)).filter((f) => f.endsWith(".md"))
    for (const file of files) {
      const raw = await fs.readFile(path.join(KERNEL_DIR, file), "utf-8")
      expect(() => parseSkillFile(raw), file).not.toThrow()
    }
    expect((await loadSkillFiles(KERNEL_DIR)).length).toBe(files.length)
  })

  it("no per-tool .md files exist (tool guidance is inline on descriptions)", async () => {
    const toolsDir = path.join(KERNEL_DIR, "tools")
    let exists = true
    try {
      await fs.access(toolsDir)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})

// ---------- Phase 0 Task 11: the starter SKILL library parses to a valid SkillFile ----------
describe("starter skill library parses to valid SkillFile", () => {
  const starterSkills = {
    "reply-playbook": "src/apps/tickets/skills/reply-playbook.md",
    "vip-escalation": "src/apps/tickets/skills/vip-escalation.md",
    "export-discipline": "src/apps/tickets/skills/export-discipline.md",
  }
  for (const [name, rel] of Object.entries(starterSkills)) {
    it(`${name} has valid frontmatter (name kebab, type skill, description<=100, requiredScopes)`, async () => {
      const raw = await fs.readFile(new URL(`../../../../${rel}`, import.meta.url).pathname, "utf8")
      const parsed = parseSkillFile(raw)
      expect(parsed.meta.name).toBe(name)
      expect(parsed.meta.name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(parsed.meta.type).toBe("skill")
      expect(parsed.meta.description.length).toBeLessThanOrEqual(100)
      expect(parsed.meta.requiredScopes?.length ?? 0).toBeGreaterThan(0)
      expect(parsed.content.length).toBeGreaterThan(0)
      // a skill name MUST NOT shadow a tool name (tools use snake_case):
      expect(parsed.meta.name).not.toContain("_")
    })
  }
})
