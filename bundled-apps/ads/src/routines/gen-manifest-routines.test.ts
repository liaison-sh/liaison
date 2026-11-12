// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit tests for the routine generator itself: frontmatter parsing,
// determinism, and the ≤200-char description ceiling enforced by
// ads-install.test.ts's generic "every routine description is <= 200 chars"
// check.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  computeFullRoutinesBlock,
  computeGeneratedRoutines,
  GENERATED_ROUTINE_FILES,
  listRoutineFiles,
  parseRoutineMd,
} from "./gen-manifest-routines"

const ROUTINES_DIR = import.meta.dir

describe("gen-manifest-routines: frontmatter parsing", () => {
  it("lists exactly the two generated .md files, sorted", () => {
    expect(listRoutineFiles()).toEqual(
      [...GENERATED_ROUTINE_FILES].sort((a, b) => a.localeCompare(b)),
    )
  })

  for (const file of GENERATED_ROUTINE_FILES) {
    describe(file, () => {
      const raw = readFileSync(join(ROUTINES_DIR, file), "utf8")
      const { frontmatter, body } = parseRoutineMd(raw)

      it("parses frontmatter with description/kind/cron/timezone/scopes/enabledByDefault", () => {
        expect(typeof frontmatter.description).toBe("string")
        expect(frontmatter.kind).toBe("recurring")
        expect(typeof frontmatter.cron).toBe("string")
        expect(frontmatter.timezone).toBe("Europe/Paris")
        expect(Array.isArray(frontmatter.scopes)).toBe(true)
        expect(frontmatter.scopes.length).toBeGreaterThan(0)
        expect(frontmatter.enabledByDefault).toBe(false)
      })

      it("description is <= 200 chars", () => {
        expect(frontmatter.description.length).toBeLessThanOrEqual(200)
      })

      it("cron is a valid 5-field cron expression", () => {
        expect(frontmatter.cron.split(" ").length).toBe(5)
      })

      it("body is non-empty", () => {
        expect(body.trim().length).toBeGreaterThan(0)
      })
    })
  }

  it("weekly-account-review body carries the doctrine markers verbatim", () => {
    const raw = readFileSync(join(ROUTINES_DIR, "weekly-account-review.md"), "utf8")
    const { body } = parseRoutineMd(raw)
    expect(body).toContain("unaudited")
    expect(body).toContain("directional")
    expect(body.toLowerCase()).toContain("below the minimum-sample floor")
    expect(body.toLowerCase()).toContain("inconclusive")
    expect(body).toContain("experiment_list")
  })

  it("monthly-deep-review body carries the doctrine markers + staged-approval semantics verbatim", () => {
    const raw = readFileSync(join(ROUTINES_DIR, "monthly-deep-review.md"), "utf8")
    const { body } = parseRoutineMd(raw)
    expect(body).toContain("unaudited")
    expect(body).toContain("directional")
    expect(body.toLowerCase()).toContain("inconclusive")
    expect(body).toContain("experiment_list")
    expect(body).toContain("pending approval")
    expect(body).toContain("experiment_open")
  })
})

describe("gen-manifest-routines: determinism", () => {
  it("computeGeneratedRoutines is byte-identical across repeat calls", () => {
    const first = computeGeneratedRoutines()
    const second = computeGeneratedRoutines()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it("computeFullRoutinesBlock preserves non-generated keys and overrides generated keys", () => {
    const existing = {
      "restock-resume": { kind: "recurring", promptTemplate: "unchanged" },
      "weekly-account-review": { kind: "recurring", promptTemplate: "STALE — should be replaced" },
    }
    const result = computeFullRoutinesBlock(existing)
    expect(result["restock-resume"]).toEqual(existing["restock-resume"])
    expect((result["weekly-account-review"] as { promptTemplate: string }).promptTemplate).not.toBe(
      "STALE — should be replaced",
    )
  })
})
