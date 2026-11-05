// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { updateRoutineRequestSchema } from "./routines"

describe("routine agentModelId", () => {
  it("accepts an added model key up to 200 characters", () => {
    const key = `custom/abcd1234/${"m".repeat(184)}`
    expect(key.length).toBe(200)
    expect(updateRoutineRequestSchema.safeParse({ agentModelId: key }).success).toBe(true)
    expect(updateRoutineRequestSchema.safeParse({ agentModelId: `${key}x` }).success).toBe(false)
  })
})
