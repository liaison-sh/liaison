// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The verified-identity cache is bounded: a demo cell creates thousands of
// visitor orgs, and the cache must not keep one entry per org for good.
import { afterEach, describe, expect, it } from "bun:test"
import { DemoVerificationTestAccess as T } from "./demo-verification"

const identity = { emailNormalized: "visitor@example.com", network: "net" }

afterEach(() => T.reset())

describe("demo verifiedCache", () => {
  it("never holds more than its cap; the least recently used org goes first", () => {
    for (let i = 0; i < T.cacheMax + 50; i++) T.remember(`org-${i}`, identity)
    const ids = T.cachedOrgIds()
    expect(ids.length).toBe(T.cacheMax)
    expect(ids[0]).toBe("org-50")
    expect(ids.at(-1)).toBe(`org-${T.cacheMax + 49}`)
  })

  it("a re-used entry moves to the back and survives the next eviction", () => {
    for (let i = 0; i < T.cacheMax; i++) T.remember(`org-${i}`, identity)
    T.remember("org-0", identity)
    T.remember("org-new", identity)
    const ids = T.cachedOrgIds()
    expect(ids.length).toBe(T.cacheMax)
    expect(ids).toContain("org-0")
    expect(ids).not.toContain("org-1")
  })
})
