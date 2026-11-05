// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createScope } from "~/modules/permissions/types"

describe("createScope", () => {
  it("creates a scope from a valid string", () => {
    const s = createScope("kernel:users:admin")
    expect(String(s)).toBe("kernel:users:admin")
  })

  it("rejects scope containing comma", () => {
    expect(() => createScope("kernel,evil")).toThrow("Scope cannot contain commas")
  })

  it("rejects empty string", () => {
    expect(() => createScope("")).toThrow("Scope cannot be empty")
  })

  it("accepts wildcard scope", () => {
    expect(String(createScope("*"))).toBe("*")
  })
})
