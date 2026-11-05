// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Drift guard: the manifest's `skills` object must always equal what the
// generator computes from src/skills/*.md. If this test fails, someone
// hand-edited the manifest skills block, or edited a .md without
// re-running the generator. Re-run `gen-manifest-skills.ts`, don't hand-fix
// the manifest.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { computeFullSkillsBlock } from "./gen-manifest-skills"

const MANIFEST_PATH = join(import.meta.dir, "..", "..", "app.manifest.json")

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

describe("ads manifest skills block sync (drift guard)", () => {
  it("manifest 'skills' object equals the generator's computed block", () => {
    const manifest = loadManifest()
    const existingSkills = (manifest.skills as Record<string, unknown> | undefined) ?? {}
    const computed = computeFullSkillsBlock(existingSkills)
    expect(existingSkills).toEqual(computed)
  })

  it("preserves the existing ads-playbook skill untouched", () => {
    const manifest = loadManifest()
    const existingSkills = (manifest.skills as Record<string, { kind: string; enabledByDefault: boolean }>) ?? {}
    const playbook = existingSkills["ads-playbook"]
    expect(playbook).toBeDefined()
    expect(playbook?.kind).toBe("guide")
    expect(playbook?.enabledByDefault).toBe(true)
  })

  it("generator is idempotent: computing twice from the same manifest yields identical output", () => {
    const manifest = loadManifest()
    const existingSkills = (manifest.skills as Record<string, unknown> | undefined) ?? {}
    const first = computeFullSkillsBlock(existingSkills)
    const second = computeFullSkillsBlock(existingSkills)
    expect(first).toEqual(second)
  })
})
