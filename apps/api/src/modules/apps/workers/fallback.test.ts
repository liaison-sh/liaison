// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { AppFallbacks, LoaderBreaker } from "./fallback"
import { classifyLoaderAnswer } from "./faults"

describe("classifyLoaderAnswer", () => {
  const table: Array<[number, unknown, string, string]> = [
    [503, undefined, "loader", "http_503"],
    [500, "", "loader", "http_500"],
    [404, undefined, "loader", "http_404"],
    [401, "auth", "loader", "auth"],
    [400, "loader_internal", "loader", "loader_internal"],
    [418, "a_kind_from_the_future", "loader", "a_kind_from_the_future"],
    [409, "load", "app", "load"],
    [404, "bundle_missing", "app", "bundle_missing"],
    [502, "bundle_fetch_failed", "app", "bundle_fetch_failed"],
    [200, "limit", "final", "limit"],
    [200, "handler", "final", "handler"],
    [200, "timeout", "final", "timeout"],
  ]
  for (const [status, kind, cls, k] of table) {
    it(`HTTP ${status} kind ${String(kind)} -> ${cls}`, () => {
      expect(classifyLoaderAnswer(status, kind)).toEqual({ class: cls as "loader", kind: k })
    })
  }
})

describe("LoaderBreaker", () => {
  it("opens on the fifth loader fault within 60 s, not on older ones", () => {
    let now = 0
    const b = new LoaderBreaker(() => now)
    for (let i = 0; i < 4; i++) {
      b.record("loader_fault")
      now += 10_000
    }
    expect(b.state()).toBe("closed")
    now = 70_000 // faults at t=0 and t=10 s left the window: 2 remain
    b.record("loader_fault")
    b.record("loader_fault")
    expect(b.state()).toBe("closed")
    b.record("loader_fault")
    expect(b.state()).toBe("open")
    expect(b.admit()).toEqual({ allow: false })
  })

  it("answers from the loader never count", () => {
    const b = new LoaderBreaker(() => 0)
    for (let i = 0; i < 20; i++) b.record("answered")
    expect(b.state()).toBe("closed")
    expect(b.admit()).toEqual({ allow: true, probe: false })
  })

  it("half-opens after 60 s with exactly one probe; its loader fault reopens, its answer closes", () => {
    let now = 0
    const b = new LoaderBreaker(() => now)
    for (let i = 0; i < 5; i++) b.record("loader_fault")
    now = 59_999
    expect(b.admit()).toEqual({ allow: false })
    now = 60_000
    expect(b.state()).toBe("half-open")
    expect(b.admit()).toEqual({ allow: true, probe: true })
    expect(b.admit()).toEqual({ allow: false })
    b.record("loader_fault", true)
    expect(b.state()).toBe("open")
    now = 120_000
    expect(b.admit()).toEqual({ allow: true, probe: true })
    // A non-probe run admitted before the opening reports late: ignored.
    b.record("loader_fault")
    expect(b.state()).toBe("half-open")
    b.record("answered", true)
    expect(b.state()).toBe("closed")
    expect(b.admit()).toEqual({ allow: true, probe: false })
  })

  it("a probe that never reports frees its lease after 60 s", () => {
    let now = 0
    const b = new LoaderBreaker(() => now)
    for (let i = 0; i < 5; i++) b.record("loader_fault")
    now = 60_000
    expect(b.admit()).toEqual({ allow: true, probe: true })
    now = 100_000
    expect(b.admit()).toEqual({ allow: false })
    now = 120_001
    expect(b.admit()).toEqual({ allow: true, probe: true })
  })
})

describe("AppFallbacks", () => {
  it("one org:app@version for 10 minutes; other orgs and versions untouched", () => {
    let now = 0
    const f = new AppFallbacks(() => now)
    const a = AppFallbacks.key("org-a", "custom-x", "1.0.0")
    f.mark(a, "load")
    expect(f.active(a)).toBe(true)
    expect(f.active(AppFallbacks.key("org-b", "custom-x", "1.0.0"))).toBe(false)
    expect(f.active(AppFallbacks.key("org-a", "custom-x", "1.0.1"))).toBe(false)
    now = 10 * 60_000 - 1
    expect(f.active(a)).toBe(true)
    now = 10 * 60_000
    expect(f.active(a)).toBe(false)
  })
})
