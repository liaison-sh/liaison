// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { allocatePorts } from "./port-allocator"

describe("allocatePorts", () => {
  it("returns the requested number of unique ports", async () => {
    const ports = await allocatePorts(3)
    expect(ports).toHaveLength(3)
    const unique = new Set(ports)
    expect(unique.size).toBe(3)
  })

  it("returns ports in the ephemeral range", async () => {
    const ports = await allocatePorts(2)
    for (const port of ports) {
      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThanOrEqual(65535)
    }
  })

  it("returns zero ports when count is 0", async () => {
    const ports = await allocatePorts(0)
    expect(ports).toHaveLength(0)
  })
})
