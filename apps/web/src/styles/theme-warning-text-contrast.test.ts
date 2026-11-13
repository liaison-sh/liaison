// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// Warning words in small text (a step that waits, a run that waits) use --color-warning-text,
// not --color-warning: the light theme's warning (#a87900) is about 3.9:1 on white, under the
// 4.5:1 small-text threshold. This reads the theme stylesheet and checks the text token against
// every page surface in BOTH themes, and against its own 15% warning wash (the run chip).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const CSS = readFileSync(resolve(__dirname, "theme.css"), "utf8")

function block(name: "dark" | "light"): string {
  const start = name === "dark" ? CSS.indexOf("@theme {") : CSS.indexOf('[data-theme="light"] {')
  return CSS.slice(start, CSS.indexOf("\n}", start))
}

function hex(name: "dark" | "light", variable: string): string {
  const m = block(name).match(new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})\\b`))
  if (!m) throw new Error(`${variable} is not defined in the ${name} block`)
  return m[1]!
}

const rgb = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))

function luminance(c: number[]): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(c[0]!) + 0.7152 * ch(c[1]!) + 0.0722 * ch(c[2]!)
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** `top` at `alpha` over `under`, as `bg-warning/15` paints it. */
const over = (top: number[], alpha: number, under: number[]) =>
  top.map((v, i) => Math.round(v * alpha + under[i]! * (1 - alpha)))

const SURFACES = ["--color-bg", "--color-surface", "--color-surface-sunken", "--color-elevated"]

describe("the warning text token reads at 4.5:1 in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`${theme}: on every surface and on the warning wash`, () => {
      const text = rgb(hex(theme, "--color-warning-text"))
      const warning = rgb(hex(theme, "--color-warning"))
      for (const s of SURFACES) {
        const surface = rgb(hex(theme, s))
        expect({ s, ratio: contrast(text, surface) >= 4.5 }).toEqual({ s, ratio: true })
        const wash = over(warning, 0.15, surface)
        expect({ s, wash: contrast(text, wash) >= 4.5 }).toEqual({ s, wash: true })
      }
    })
  }

  it("the light theme's plain warning tone is the reason: it fails small text on white", () => {
    expect(contrast(rgb(hex("light", "--color-warning")), [255, 255, 255])).toBeLessThan(4.5)
  })
})
