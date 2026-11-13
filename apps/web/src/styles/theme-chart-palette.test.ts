// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// A chart series that carries no colour of its own takes the chart palette (--color-chart-1..8),
// never the accent grey. Each hue is a graphical object on the block's surface, so it must clear
// WCAG 1.4.11's 3:1 against --color-surface, in BOTH themes, and the eight must stay distinct.

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
  if (!m?.[1]) throw new Error(`${variable} is not defined in the ${name} block`)
  return m[1]
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(h: string): number {
  const r = Number.parseInt(h.slice(1, 3), 16)
  const g = Number.parseInt(h.slice(3, 5), 16)
  const b = Number.parseInt(h.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]

describe("the chart palette", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`defines eight distinct hues that clear 3:1 on the surface (${theme})`, () => {
      const surface = hex(theme, "--color-surface")
      const hues = SLOTS.map((n) => hex(theme, `--color-chart-${n}`))
      expect(new Set(hues.map((h) => h.toLowerCase())).size).toBe(8)
      for (const [i, h] of hues.entries()) {
        expect({ slot: i + 1, ratio: contrast(h, surface) >= 3 }).toEqual({
          slot: i + 1,
          ratio: true,
        })
      }
      // None of them is the accent: colour is data, the accent stays the interface's.
      expect(hues).not.toContain(hex(theme, "--color-accent"))
    })
  }
})
