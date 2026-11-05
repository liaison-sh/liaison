// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MemoryFrontmatterSchema, MemoryPathSchema } from "./agent-memory"

describe("agent memory tree paths", () => {
  it("MemoryPathSchema accepts the four legal shapes and rejects traversal", () => {
    const accepted = [
      "MEMORY.md",
      "project/q3-launch.md",
      "episodes/logistics/2026-09-12.md",
      "checkpoints/logistics.md",
    ]
    for (const path of accepted) {
      expect(MemoryPathSchema.safeParse(path).success).toBe(true)
    }

    const rejected = [
      "../other/x.md",
      "/memories/support/x.md",
      "project/../../etc/passwd",
      "project\\x.md",
      "/etc/passwd",
      "episodes/logistics/2026-09-12.md/../x.md",
    ]
    for (const path of rejected) {
      expect(MemoryPathSchema.safeParse(path).success).toBe(false)
    }
  })

  it("MemoryFrontmatterSchema requires requiredScopes as an array", () => {
    const complete = {
      name: "q3-launch",
      description: "The Q3 launch plan",
      type: "project",
      modified: "2026-09-12",
      requiredScopes: ["kernel:threads:read"],
      sources: ["thread:logistics"],
      supersedes: null,
    }
    expect(MemoryFrontmatterSchema.safeParse(complete).success).toBe(true)

    const { requiredScopes: _missing, ...withoutScopes } = complete
    expect(MemoryFrontmatterSchema.safeParse(withoutScopes).success).toBe(false)
    expect(
      MemoryFrontmatterSchema.safeParse({ ...complete, requiredScopes: "kernel:threads:read" })
        .success,
    ).toBe(false)
  })
})
