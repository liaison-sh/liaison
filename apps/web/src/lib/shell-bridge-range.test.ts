// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import { SHELL_BRIDGE_RANGE } from "~/lib/shell-bridge-range"

describe("shell bridge ranges", () => {
  // A signed shell carries these ranges; a desktop that implements the bridge
  // this very build speaks must fall inside its own range.
  it("the desktop range admits the bridge version this build speaks", () => {
    expect(SHELL_BRIDGE_RANGE.desktop).toBe(`^${DESKTOP_BRIDGE_VERSION}`)
  })

  it("every range is a caret range over an integer major", () => {
    for (const range of Object.values(SHELL_BRIDGE_RANGE)) expect(range).toMatch(/^\^\d+$/)
  })
})
