// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import { bridgeRangeAllows, SHELL_BRIDGE_RANGE } from "~/lib/shell-bridge-range"

describe("shell bridge ranges", () => {
  // A signed shell carries these ranges; a desktop that implements the bridge
  // this very build speaks must fall inside its own range.
  it("the desktop range admits the bridge version this build speaks", () => {
    expect(SHELL_BRIDGE_RANGE.desktop).toBe(`^${DESKTOP_BRIDGE_VERSION}`)
  })

  it("every range is a caret range over an integer major", () => {
    for (const range of Object.values(SHELL_BRIDGE_RANGE)) expect(range).toMatch(/^\^\d+$/)
  })

  // The same cases as served_shell.rs `bridge_ranges_read_like_the_web_side`.
  it("reads ranges exactly like the desktop host", () => {
    const cases: Array<[string, number, boolean]> = [
      ["^1", 1, true],
      ["^1", 2, false],
      ["^1", 0, false],
      ["^2", 1, false],
      ["~1", 1, true],
      ["1", 1, true],
      ["=1", 1, true],
      [">=1", 3, true],
      [">=2", 1, false],
      [">1", 1, false],
      ["<2", 1, true],
      ["<=1", 1, true],
      [">=1 <3", 2, true],
      [">=1 <3", 3, false],
      ["^1 || ^2", 2, true],
      ["^1 || ^3", 2, false],
      ["", 1, false],
      ["^", 1, false],
      ["^01", 1, false],
      ["^1.0.0", 1, false],
      ["^1 || garbage", 1, false],
      ["^1 ||", 1, false],
    ]
    for (const [range, version, want] of cases) {
      expect(bridgeRangeAllows(range, version), `${range} @ ${version}`).toBe(want)
    }
  })
})
