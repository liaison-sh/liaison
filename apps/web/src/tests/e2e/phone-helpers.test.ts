// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure unit coverage for isClippingCandidate's skip/flag decision, extracted
// from findHorizontalClipping so it can be exercised without a real page.
import { describe, expect, it, vi } from "vitest"
import { type ClipCandidateInfo, isClippingCandidate } from "./phone-helpers"

// phone-helpers.ts imports the real `@playwright/test` runtime for its
// `expect`/`Page` re-export, which this file never calls: only the pure
// `isClippingCandidate` decision is under test. Loading the real
// `@playwright/test` runtime inside vitest's jsdom environment recurses
// jsdom's `navigator.hardwareConcurrency` getter (a known jsdom/Playwright
// global conflict) and crashes the whole file before any test runs, so it is
// stubbed out here rather than imported for real. `vi.mock` calls are hoisted
// above imports by vitest's transform, so this still intercepts the import
// above.
vi.mock("@playwright/test", () => ({ expect: vi.fn() }))

const base: ClipCandidateInfo = {
  right: 0,
  width: 100,
  height: 40,
  top: 100,
  bottom: 140,
  innerWidth: 390,
  innerHeight: 844,
  ariaHidden: false,
  visibilityHidden: false,
  scrollAncestor: null,
}

describe("isClippingCandidate", () => {
  it("skips an element clipped only by an overflow-x: auto rail that is itself within the viewport (tickets chip rail false positive)", () => {
    const chip: ClipCandidateInfo = {
      ...base,
      right: 600.97,
      scrollAncestor: { overflowX: "auto", right: 380 },
    }
    expect(isClippingCandidate(chip)).toBe(false)
  })

  it("flags an element clipped by an overflow: hidden ancestor (the boxtal case it must still catch)", () => {
    const clipped: ClipCandidateInfo = {
      ...base,
      right: 420,
      scrollAncestor: { overflowX: "hidden", right: 390 },
    }
    expect(isClippingCandidate(clipped)).toBe(true)
  })

  it("flags a plain overflowing element with no scrolling ancestor at all", () => {
    const clipped: ClipCandidateInfo = {
      ...base,
      right: 450,
      scrollAncestor: null,
    }
    expect(isClippingCandidate(clipped)).toBe(true)
  })

  it("skips an aria-hidden element even when its right edge is past the viewport", () => {
    const hidden: ClipCandidateInfo = {
      ...base,
      right: 450,
      ariaHidden: true,
      scrollAncestor: null,
    }
    expect(isClippingCandidate(hidden)).toBe(false)
  })

  it("does not flag an element whose right edge is within the 1px slack", () => {
    expect(isClippingCandidate({ ...base, right: 391 })).toBe(false)
  })

  it("skips a zero-size element", () => {
    expect(isClippingCandidate({ ...base, right: 450, width: 0 })).toBe(false)
  })

  it("skips a visibility:hidden element", () => {
    expect(isClippingCandidate({ ...base, right: 450, visibilityHidden: true })).toBe(false)
  })

  it("skips an element entirely off-screen vertically (below the fold)", () => {
    expect(isClippingCandidate({ ...base, right: 450, top: 2000, bottom: 2040 })).toBe(false)
  })

  it("still flags a clipped element inside an overflow-x: auto ancestor that has itself scrolled past the viewport", () => {
    const clipped: ClipCandidateInfo = {
      ...base,
      right: 700,
      scrollAncestor: { overflowX: "scroll", right: 650 },
    }
    expect(isClippingCandidate(clipped)).toBe(true)
  })
})
