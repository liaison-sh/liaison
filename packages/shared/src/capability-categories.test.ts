// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { capabilityCategories, WILDCARD_CAPABILITY_CATEGORY } from "./capability-categories"

describe("capabilityCategories", () => {
  it("names the app, never the scope", () => {
    expect(capabilityCategories(["kernel:agents:read", "tickets:tickets:write"])).toEqual([
      "kernel",
      "tickets",
    ])
  })

  it("deduplicates and sorts", () => {
    expect(capabilityCategories(["tickets:read", "kernel:x", "tickets:write"])).toEqual([
      "kernel",
      "tickets",
    ])
  })

  it("a wildcard grant names the whole workspace", () => {
    expect(capabilityCategories(["*"])).toEqual([WILDCARD_CAPABILITY_CATEGORY])
  })

  it("ignores empty and non-string grants", () => {
    expect(capabilityCategories(["", null as unknown as string, "mail:read"])).toEqual(["mail"])
  })
})
