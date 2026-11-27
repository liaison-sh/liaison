// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A phone turned on its side stays a phone. The width alone (956 points on a
// large phone in landscape) used to pick the desktop shell: the side rail and
// a tab strip of every screen opened on the phone.
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveShellTier } from "~/modules/shell/shell-tier"

interface Viewport {
  width: number
  height: number
  pointer: "coarse" | "fine"
}

/** Enough of a media query evaluator for the shell's own queries. */
function matches(query: string, vp: Viewport): boolean {
  return query.split(",").some((alternative) =>
    alternative
      .trim()
      .split(/\s+and\s+/)
      .every((feature) => {
        const m = /^\(([a-z-]+):\s*([a-z0-9]+?)(px)?\)$/.exec(feature.trim())
        if (!m) throw new Error(`unparsed media feature: ${feature}`)
        const [, name, value] = m
        const n = Number(value)
        switch (name) {
          case "min-width":
            return vp.width >= n
          case "max-width":
            return vp.width <= n
          case "max-height":
            return vp.height <= n
          case "min-height":
            return vp.height >= n
          case "pointer":
            return vp.pointer === value
          default:
            throw new Error(`unknown media feature: ${name}`)
        }
      }),
  )
}

function at(vp: Viewport): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query, vp),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe("the shell tier of a device", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("a phone is the phone tier in portrait and in landscape", () => {
    at({ width: 440, height: 956, pointer: "coarse" })
    expect(resolveShellTier()).toBe("phone")
    at({ width: 956, height: 440, pointer: "coarse" })
    expect(resolveShellTier()).toBe("phone")
    at({ width: 667, height: 375, pointer: "coarse" })
    expect(resolveShellTier()).toBe("phone")
  })

  it("a tablet keeps its tiers, in either orientation", () => {
    at({ width: 820, height: 1180, pointer: "coarse" })
    expect(resolveShellTier()).toBe("tablet")
    at({ width: 1180, height: 820, pointer: "coarse" })
    expect(resolveShellTier()).toBe("desktop")
    at({ width: 744, height: 1133, pointer: "coarse" })
    expect(resolveShellTier()).toBe("tablet")
  })

  it("a short desktop window is not a phone", () => {
    at({ width: 1280, height: 420, pointer: "fine" })
    expect(resolveShellTier()).toBe("desktop")
  })
})
