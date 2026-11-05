// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { resolveAppOrder } from "~/modules/apps/resolver"

describe("resolveAppOrder", () => {
  it("no dependencies resolves immediately", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: {} },
      { name: "b", dependencies: {} },
    ])
    expect(result.success).toBe(true)
    expect(result.order).toHaveLength(2)
  })

  it("linear chain: A -> B -> C", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: { required: ["b"] } },
      { name: "b", dependencies: { required: ["c"] } },
      { name: "c", dependencies: {} },
    ])
    expect(result.success).toBe(true)
    expect(result.order!.indexOf("c")).toBeLessThan(result.order!.indexOf("b"))
    expect(result.order!.indexOf("b")).toBeLessThan(result.order!.indexOf("a"))
  })

  it("diamond dependency", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: { required: ["b", "c"] } },
      { name: "b", dependencies: { required: ["d"] } },
      { name: "c", dependencies: { required: ["d"] } },
      { name: "d", dependencies: {} },
    ])
    expect(result.success).toBe(true)
    expect(result.order!.indexOf("d")).toBeLessThan(result.order!.indexOf("b"))
    expect(result.order!.indexOf("d")).toBeLessThan(result.order!.indexOf("c"))
  })

  it("circular dependency rejected with cycle info", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: { required: ["b"] } },
      { name: "b", dependencies: { required: ["a"] } },
    ])
    expect(result.success).toBe(false)
    expect(result.error).toContain("Circular")
  })

  it("self-dependency rejected", () => {
    const result = resolveAppOrder([{ name: "a", dependencies: { required: ["a"] } }])
    expect(result.success).toBe(false)
  })

  it("missing required dependency rejected", () => {
    const result = resolveAppOrder([{ name: "a", dependencies: { required: ["missing"] } }])
    expect(result.success).toBe(false)
    expect(result.error).toContain("Missing")
    expect(result.rejectedApps!).toContain("a")
  })

  it("allows kernel as a built-in required dependency", () => {
    const result = resolveAppOrder([{ name: "projects", dependencies: { required: ["kernel"] } }])
    expect(result.success).toBe(true)
    expect(result.order).toEqual(["projects"])
  })

  it("missing optional dependency loads with warning", () => {
    const result = resolveAppOrder([{ name: "a", dependencies: { optional: ["missing"] } }])
    expect(result.success).toBe(true)
    expect(result.order).toContain("a")
    expect(result.warnings).toHaveLength(1)
  })

  it("skips optional dependency that would create a cycle", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: { required: ["b"] } },
      { name: "b", dependencies: { optional: ["a"] } },
    ])
    expect(result.success).toBe(true)
    expect(result.order).toEqual(["b", "a"])
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Optional dependency b → a skipped"),
    )
  })

  it("keeps optional dependency that does not create a cycle", () => {
    const result = resolveAppOrder([
      { name: "a", dependencies: {} },
      { name: "b", dependencies: { optional: ["a"] } },
    ])
    expect(result.success).toBe(true)
    expect(result.order).toEqual(["a", "b"])
    expect(result.warnings).toHaveLength(0)
  })
})
