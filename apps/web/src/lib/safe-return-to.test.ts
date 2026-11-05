// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { safeReturnTo } from "./safe-return-to"

describe("safeReturnTo", () => {
  it("allows simple relative paths", () => {
    expect(safeReturnTo("/settings")).toBe("/settings")
    expect(safeReturnTo("/threads/123")).toBe("/threads/123")
  })

  it("blocks // prefix (protocol-relative)", () => {
    expect(safeReturnTo("//evil.com")).toBe("/")
  })

  it("blocks /\\ prefix", () => {
    expect(safeReturnTo("/\\evil.com")).toBe("/")
  })

  it("blocks :// in path", () => {
    expect(safeReturnTo("/foo://bar")).toBe("/")
  })

  it("returns / for undefined", () => {
    expect(safeReturnTo(undefined)).toBe("/")
  })

  it("returns / for non-/ prefix", () => {
    expect(safeReturnTo("http://evil.com")).toBe("/")
    expect(safeReturnTo("relative")).toBe("/")
  })

  it("returns / for empty string", () => {
    expect(safeReturnTo("")).toBe("/")
  })

  it("passes /%2F%2F... through — router decodes before this function is called", () => {
    // Safe because @solidjs/router decodes the path before calling safeReturnTo,
    // turning /%2F%2Fevil.com into //evil.com which IS blocked by the // check above.
    expect(safeReturnTo("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com")
  })
})
