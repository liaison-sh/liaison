// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { assertTaskPriority, TASK_PRIORITIES } from "./resolve"
import { ProjectsServiceError } from "./statuses"

// Regression (roadmap-import, 2026-09-09): an agent filing a "Priorité P1" item
// via the projects `create` tool sent priority "medium" — a level this board
// does not have. Nothing validated it between the tool call and the INSERT, so
// the CHECK constraint on app_projects.tasks.priority raised, and what came back
// to the caller was postgres.js's wrapper: "Failed query: INSERT INTO
// app_projects.tasks (...) params: <every column value>", with the real
// constraint message buried in `.cause` and the whole task body echoed back.
describe("assertTaskPriority", () => {
  it("accepts every value the column's CHECK allows", () => {
    for (const p of TASK_PRIORITIES) {
      expect(() => assertTaskPriority(p)).not.toThrow()
    }
  })

  it("is a no-op when the caller omits priority", () => {
    expect(() => assertTaskPriority(undefined)).not.toThrow()
    expect(() => assertTaskPriority(null)).not.toThrow()
  })

  it("rejects 'medium' as a 400 carrying the real levels, not a postgres dump", () => {
    let err: unknown
    try {
      assertTaskPriority("medium")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProjectsServiceError)
    const e = err as ProjectsServiceError
    expect(e.status).toBe(400)
    expect(e.code).toBe("invalid_priority")
    expect(e.message).toContain("medium")
    expect(e.message).not.toContain("Failed query")
    expect((e.details as { candidates: string[] }).candidates).toEqual([
      "low",
      "normal",
      "high",
      "urgent",
    ])
  })

  it("does NOT silently coerce a near-miss onto a level (P1 'medium' is not 'normal')", () => {
    // Aliasing would rewrite intent: in the field "medium" stands in for a
    // P1/P2 label as often as for the middle of the scale. Make the caller pick.
    for (const bogus of ["medium", "MEDIUM", "Normal", "p1", "moyenne", "critical", ""]) {
      expect(() => assertTaskPriority(bogus), bogus).toThrow(ProjectsServiceError)
    }
  })

  it("names the param so an update call's error points at the right field", () => {
    expect(() => assertTaskPriority("medium", "priority")).toThrow(/^priority must be one of/)
  })
})
