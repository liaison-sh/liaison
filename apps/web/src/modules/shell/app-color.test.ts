// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// The approval pills take their app's hue (app-color.ts, AppPill.tsx). A hue is
// derived from an app id nobody chose for its colour, so the lightness pair has
// to read at EVERY hue, not only the handful today's apps happen to land on:
// this sweeps all 360 in both themes against WCAG AA for small text (4.5:1).

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  APP_PILL_PALETTE,
  appHue,
  appPillColors,
  appPillVars,
  isSystemAppId,
  type PillSL,
} from "~/modules/shell/app-color"

function hslToRgb(h: number, sl: PillSL): [number, number, number] {
  const s = sl.s / 100
  const l = sl.l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

function channel(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
}

describe("app pill colours", () => {
  it("take the app's own hue, in both themes", () => {
    const hue = appHue("shopify")
    expect(appPillColors("shopify", "light")).toEqual({
      background: `hsl(${hue} 60% 94%)`,
      text: `hsl(${hue} 55% 28%)`,
      border: `hsl(${hue} 50% 82%)`,
    })
    expect(appPillColors("shopify", "dark").text).toBe(`hsl(${hue} 60% 78%)`)
    const vars = appPillVars("shopify")
    expect(vars["--app-pill-fg-light"]).toBe(`hsl(${hue} 55% 28%)`)
    expect(vars["--app-pill-bg-dark"]).toBe(`hsl(${hue} 35% 18%)`)
  })

  it("differ between apps whose hues differ", () => {
    expect(appHue("tickets")).not.toBe(appHue("invoicing"))
    expect(appPillColors("tickets", "light").text).not.toBe(
      appPillColors("invoicing", "light").text,
    )
  })

  it("treat the kernel and a missing app as system (neutral)", () => {
    expect(isSystemAppId("kernel")).toBe(true)
    expect(isSystemAppId(null)).toBe(true)
    expect(isSystemAppId("")).toBe(true)
    expect(isSystemAppId("tickets")).toBe(false)
  })

  for (const theme of ["light", "dark"] as const) {
    it(`text clears WCAG AA (4.5:1) on the pill at every hue in ${theme}`, () => {
      const p = APP_PILL_PALETTE[theme]
      let worst = { ratio: Number.POSITIVE_INFINITY, hue: -1 }
      for (let hue = 0; hue < 360; hue++) {
        const ratio = contrast(hslToRgb(hue, p.background), hslToRgb(hue, p.text))
        if (ratio < worst.ratio) worst = { ratio, hue }
      }
      expect(worst.ratio, `worst hue ${worst.hue}`).toBeGreaterThanOrEqual(4.5)
    })
  }

  it("the neutral (system) pill's text clears 4.5:1 in both themes", () => {
    const css = readFileSync(resolve(__dirname, "../../styles/theme.css"), "utf8")
    const darkBlock = css.slice(
      css.indexOf("@theme {"),
      css.indexOf("\n}", css.indexOf("@theme {")),
    )
    const lightStart = css.indexOf('[data-theme="light"] {')
    const lightBlock = css.slice(lightStart, css.indexOf("\n}", lightStart))
    const pick = (block: string, name: string): [number, number, number] => {
      const m = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
      if (!m) throw new Error(`${name} missing`)
      return hexToRgb(m[1])
    }
    for (const block of [darkBlock, lightBlock]) {
      expect(
        contrast(pick(block, "--color-surface"), pick(block, "--color-text-secondary")),
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
