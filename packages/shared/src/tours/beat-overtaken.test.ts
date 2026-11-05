// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { beatOvertaken } from "./api"

const beats = [
  { id: "bundle", kind: "show" as const },
  { id: "bundle-steps", kind: "show" as const },
  { id: "approve", kind: "do" as const },
  { id: "brief", kind: "show" as const },
]

describe("beatOvertaken", () => {
  it("is true once a later do step was recorded done ahead (approved from the open card)", () => {
    const states = { approve: { state: "done" as const, entityId: "e1" } }
    expect(beatOvertaken(beats, "bundle-steps", states)).toBe(true)
    expect(beatOvertaken(beats, "bundle", states)).toBe(true)
  })

  it("is false while no later do step is done", () => {
    expect(beatOvertaken(beats, "bundle-steps", { bundle: "done" })).toBe(false)
  })

  it("ignores a later do step that was skipped, and the step itself", () => {
    expect(beatOvertaken(beats, "bundle-steps", { approve: "skipped" })).toBe(false)
    expect(beatOvertaken(beats, "approve", { approve: "done" })).toBe(false)
  })

  it("is false for an unknown step", () => {
    expect(beatOvertaken(beats, "nope", { approve: "done" })).toBe(false)
  })
})
