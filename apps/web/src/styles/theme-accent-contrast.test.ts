// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// The unread pill is the one place in the sidebar where text is painted ON the
// accent, and A36 made it carry the weight the preview line used to. It used
// to be a hardcoded `text-white`: in dark theme `--color-accent` is #b0b8c8,
// so that was white on light grey at 10 px, the weakest text on the surface.
//
// The fix is a token pair, and a token pair can be checked. This reads the
// theme stylesheet itself (not a component) and computes WCAG 2.1 contrast for
// --color-accent against --color-accent-foreground in BOTH themes. 4.5:1 is
// the small text threshold, and the pill's 10 px semibold is small text.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const CSS = readFileSync(resolve(__dirname, "theme.css"), "utf8")

/** The @theme block at the top carries the DARK palette (dark is the default);
 *  `[data-theme="light"]` overrides it. Read each block separately. */
function block(name: "dark" | "light"): string {
  if (name === "dark") {
    const start = CSS.indexOf("@theme {")
    return CSS.slice(start, CSS.indexOf("\n}", start))
  }
  const start = CSS.indexOf('[data-theme="light"] {')
  return CSS.slice(start, CSS.indexOf("\n}", start))
}

function hex(name: "dark" | "light", variable: string): string {
  const m = block(name).match(new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{3,8})`))
  if (!m) throw new Error(`${variable} is not defined in the ${name} block`)
  return m[1]
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(h: string): number {
  const full = h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h
  const r = Number.parseInt(full.slice(1, 3), 16)
  const g = Number.parseInt(full.slice(3, 5), 16)
  const b = Number.parseInt(full.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe("the accent foreground token contrasts against the accent in both themes", () => {
  it("is defined in the dark palette and in the light override", () => {
    expect(hex("dark", "--color-accent-foreground")).toMatch(/^#[0-9a-fA-F]{3,6}$/)
    expect(hex("light", "--color-accent-foreground")).toMatch(/^#[0-9a-fA-F]{3,6}$/)
  })

  it("clears 4.5:1 in dark, which a hardcoded white did NOT", () => {
    const accent = hex("dark", "--color-accent")
    expect(contrast(accent, hex("dark", "--color-accent-foreground"))).toBeGreaterThanOrEqual(4.5)
    // The regression this replaces: white on the dark theme's accent.
    expect(contrast(accent, "#ffffff")).toBeLessThan(4.5)
  })

  it("clears 4.5:1 in light", () => {
    const accent = hex("light", "--color-accent")
    expect(contrast(accent, hex("light", "--color-accent-foreground"))).toBeGreaterThanOrEqual(4.5)
  })
})

/* ── The accent fill and its foreground are a PAIR ──────────────────────────
 *
 * The pair only protects a reader when both halves come from the token layer.
 * The dark fill is a light lavender (#b0b8c8) and the light fill is a dark
 * slate (#4a5468), so a component that hardcodes `text-white` on `bg-accent`
 * is white on light grey in dark theme: the "New ticket" and "Message"
 * buttons, near invisible. A literal foreground cannot be redefined per
 * theme, so the sweep below is the guard. */

const WEB_SRC = resolve(__dirname, "..")
const REPO = resolve(__dirname, "../../../..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(tsx|ts)$/.test(entry)) continue
    if (/\.test\.(tsx|ts)$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/** A colour written into a component, which no theme can redefine. */
const LITERAL_FOREGROUND = /\btext-white\b|\btext-black\b|text-\[#/

function accentFillLiterals(): string[] {
  const roots = [WEB_SRC, resolve(REPO, "packages/app-ui/src"), resolve(REPO, "bundled-apps")]
  const offenders: string[] = []
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!line.includes("bg-accent")) return
        if (!LITERAL_FOREGROUND.test(line)) return
        offenders.push(`${file.slice(REPO.length + 1)}:${i + 1}`)
      })
    }
  }
  return offenders
}

describe("the accent fill is painted with a token foreground, never a literal", () => {
  it("defines a dark fill that is not the light fill", () => {
    expect(hex("dark", "--color-accent")).not.toBe(hex("light", "--color-accent"))
    expect(hex("dark", "--color-accent-foreground")).not.toBe(
      hex("light", "--color-accent-foreground"),
    )
  })

  it("has no component painting a literal colour on bg-accent", () => {
    expect(accentFillLiterals()).toEqual([])
  })
})
