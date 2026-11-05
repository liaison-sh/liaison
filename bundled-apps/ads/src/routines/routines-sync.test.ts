// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Drift guard: the manifest's `routines` object must always equal what the
// generator computes from src/routines/*.md (for the two generated keys) plus
// the preserved hand-authored entries. If this test fails, someone hand-edited
// a generated routine's promptTemplate in the manifest, or edited a .md
// without re-running the generator. Re-run gen-manifest-routines.ts, don't
// hand-fix the manifest.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { computeFullRoutinesBlock, computeGeneratedRoutines } from "./gen-manifest-routines"

const MANIFEST_PATH = join(import.meta.dir, "..", "..", "app.manifest.json")

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

describe("ads manifest routines block sync (drift guard)", () => {
  it("manifest 'routines' object equals the generator's computed block", () => {
    const manifest = loadManifest()
    const existingRoutines = (manifest.routines as Record<string, unknown> | undefined) ?? {}
    const computed = computeFullRoutinesBlock(existingRoutines)
    expect(existingRoutines).toEqual(computed)
  })

  it("preserves the kept hand-authored routine untouched (low-roas-autopause)", () => {
    const manifest = loadManifest()
    const existingRoutines = (manifest.routines as Record<string, { kind: string }>) ?? {}
    expect(existingRoutines["low-roas-autopause"]).toBeDefined()
    expect(existingRoutines["low-roas-autopause"]?.kind).toBe("recurring")
  })

  it("the retired restock-resume routine is gone (its only purpose was resuming auto-paused ads)", () => {
    const manifest = loadManifest()
    const existingRoutines = (manifest.routines as Record<string, unknown>) ?? {}
    expect(existingRoutines["restock-resume"]).toBeUndefined()
  })

  it("generates exactly weekly-account-review and monthly-deep-review", () => {
    const generated = computeGeneratedRoutines()
    expect(Object.keys(generated).sort()).toEqual(["monthly-deep-review", "weekly-account-review"])
  })

  it("retired templates do not survive in the manifest routines block", () => {
    const manifest = loadManifest()
    const existingRoutines = (manifest.routines as Record<string, unknown>) ?? {}
    expect(existingRoutines["weekly-performance-digest"]).toBeUndefined()
    expect(existingRoutines["weekly-roas-digest"]).toBeUndefined()
  })

  it("generator is idempotent: computing twice from the same manifest yields identical output", () => {
    const manifest = loadManifest()
    const existingRoutines = (manifest.routines as Record<string, unknown> | undefined) ?? {}
    const first = computeFullRoutinesBlock(existingRoutines)
    const second = computeFullRoutinesBlock(existingRoutines)
    expect(first).toEqual(second)
  })
})
