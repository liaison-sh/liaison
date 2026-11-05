// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

describe("theme.css light palette", () => {
  const css = readFileSync(resolve(__dirname, "theme.css"), "utf-8")

  test("defines [data-theme=light] block", () => {
    expect(css).toMatch(/\[data-theme=["']light["']\]\s*\{/)
  })

  // Typography (font-*, text-*) and radius tokens are theme-agnostic and
  // intentionally NOT redefined under [data-theme="light"] — the same fonts
  // and radii apply in both themes.
  const requiredTokens = [
    "--color-bg",
    "--color-surface",
    "--color-surface-hover",
    "--color-elevated",
    "--color-border-subtle",
    "--color-border",
    "--color-border-strong",
    "--color-text",
    "--color-text-secondary",
    "--color-text-tertiary",
    "--color-accent",
    "--color-accent-hover",
    "--color-accent-muted",
    "--color-success",
    "--color-danger",
    "--color-error",
    "--color-warning",
    "--color-overlay",
    "--color-overlay-heavy",
    "--color-glass-bg",
  ]

  for (const token of requiredTokens) {
    test(`light palette redefines ${token}`, () => {
      const lightBlockMatch = css.match(/\[data-theme=["']light["']\]\s*\{([\s\S]*?)\}/)
      expect(lightBlockMatch).toBeTruthy()
      expect(lightBlockMatch![1]).toContain(token)
    })
  }

  // The avatar slots are saturated enough for either page: defined once under
  // :root, people and agents each with their own eight, never redefined by
  // the light theme (a pastel override is what washed them out).
  test("defines 8 person and 8 agent avatar slots once, for both themes", () => {
    const lightBlock = css.match(/\[data-theme=["']light["']\]\s*\{([\s\S]*?)\}/)![1]
    for (let i = 0; i < 8; i++) {
      for (const token of [`--avatar-${i}-bg`, `--avatar-${i}-text`, `--agent-avatar-${i}-bg`]) {
        expect(css).toContain(`${token}:`)
        expect(lightBlock).not.toContain(token)
      }
      expect(css).toContain(`--agent-avatar-${i}-solid:`)
    }
  })

  test("popover shadow recomputed for light mode (no opaque-on-dark assumption)", () => {
    const lightBlock = css.match(/\[data-theme=["']light["']\]\s*\{([\s\S]*?)\}/)![1]
    expect(lightBlock).toContain("--shadow-popover")
  })
})
