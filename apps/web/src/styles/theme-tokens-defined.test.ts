// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every semantic color utility a component uses must name a token theme.css
// defines. Tailwind v4 emits `color: var(--color-<name>)` for ANY name, so a
// misspelt or never-defined token compiles, ships, and paints nothing: the
// walk's "+ Add source" button used `text-text-on-accent`, which did not exist,
// and rendered dark text on the dark accent fill. Nothing caught it because
// nothing compared the class names against the theme.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")
const css = readFileSync(resolve(__dirname, "theme.css"), "utf-8")
const defined = new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]))

// Names that were never defined and are still in use. Each one paints nothing
// today (a background that stays transparent). They predate this guard and
// changing them is a visual decision per screen, so they are pinned here: the
// list may only shrink. Do not add to it; define the token or use a real one.
const LEGACY_UNDEFINED = new Set([
  "bg-subtle",
  "surface-elevated",
  "surface-emphasis",
  "surface-muted",
  "surface-recessed",
  "surface-secondary",
])

// A utility whose value starts with one of the theme's semantic families is a
// color token reference (text-text-*, bg-surface-*, border-border-*, ...).
// Plain Tailwind palette colors (text-red-500) and non-color utilities
// (text-xs, border-b) do not match.
const FAMILIES = "text|surface|border|accent|error|warning|success|elevated|danger|overlay|glass|bg"
const UTILITY = new RegExp(
  `(?:^|[\\s"'\`{:])(?:text|bg|border|ring|outline|fill|stroke|divide|placeholder|from|to|via|decoration|caret)-((?:${FAMILIES})(?:-[a-z0-9]+)*)(?=[\\s"'\`}/]|$)`,
  "gm",
)

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "e2e") continue
      yield* sourceFiles(path)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield path
    }
  }
}

describe("semantic color utilities name defined theme tokens", () => {
  const offenders = new Map<string, string[]>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8")
    for (const m of text.matchAll(UTILITY)) {
      const token = m[1]
      if (defined.has(token) || LEGACY_UNDEFINED.has(token)) continue
      const list = offenders.get(token) ?? []
      list.push(file.slice(SRC.length + 1))
      offenders.set(token, list)
    }
  }

  it("uses no undefined color token outside the pinned legacy list", () => {
    expect(Object.fromEntries(offenders)).toEqual({})
  })

  it("defines surface-sunken in the dark theme and again in the light one", () => {
    const light = css.slice(css.indexOf('[data-theme="light"]'))
    const dark = css.slice(0, css.indexOf('[data-theme="light"]'))
    expect(dark).toMatch(/--color-surface-sunken:\s*#[0-9a-f]{6};/)
    expect(light).toMatch(/--color-surface-sunken:\s*#[0-9a-f]{6};/)
  })

  it("defines the aliases the components rely on (text-primary, text-on-accent)", () => {
    expect(defined.has("text-primary")).toBe(true)
    expect(defined.has("text-on-accent")).toBe(true)
    expect(defined.has("accent-foreground")).toBe(true)
  })
})
