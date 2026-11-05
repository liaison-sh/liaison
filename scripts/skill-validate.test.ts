// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SKILL = join(REPO_ROOT, ".claude/skills/creating-an-app/SKILL.md")

describe("creating-an-app skill", () => {
  it("exists with required frontmatter", () => {
    expect(existsSync(SKILL)).toBe(true)
    const text = readFileSync(SKILL, "utf8")
    expect(text).toMatch(/^---/)
    expect(text).toMatch(/^name: creating-an-app/m)
    expect(text).toMatch(/^description:/m)
  })

  it("explicitly invokes the scaffold and freeze commands by name", () => {
    const text = readFileSync(SKILL, "utf8")
    expect(text).toMatch(/bun run app:create/)
    expect(text).toMatch(/bun run app:freeze/)
    expect(text).toMatch(/docs\/app-development\.md/)
    expect(text).toMatch(/docs\/sdk-gaps\.md/)
  })

  it("has a REFERENCE.md companion", () => {
    expect(existsSync(join(REPO_ROOT, ".claude/skills/creating-an-app/REFERENCE.md"))).toBe(true)
  })
})
