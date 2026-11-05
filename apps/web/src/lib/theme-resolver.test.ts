// SPDX-License-Identifier: FSL-1.1-ALv2

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveTheme } from "./theme-resolver"

describe("resolveTheme", () => {
  test("stored 'light' wins over system preference", () => {
    expect(resolveTheme("light", true)).toBe("light")
  })
  test("stored 'dark' wins over system preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark")
  })
  test("stored 'system' falls back to prefers-color-scheme: dark", () => {
    expect(resolveTheme("system", true)).toBe("dark")
  })
  test("stored 'system' falls back to prefers-color-scheme: light", () => {
    expect(resolveTheme("system", false)).toBe("light")
  })
  test("null storage falls back to system pref (dark)", () => {
    expect(resolveTheme(null, true)).toBe("dark")
  })
  test("null storage falls back to system pref (light)", () => {
    expect(resolveTheme(null, false)).toBe("light")
  })
  test("garbage storage falls back to system pref", () => {
    expect(resolveTheme("rainbow", false)).toBe("light")
  })
})

describe("index.html pre-paint script", () => {
  test("contains liaison:theme localStorage key and matchMedia call", () => {
    const html = readFileSync(resolve(__dirname, "../../index.html"), "utf-8")
    expect(html).toContain("liaison:theme")
    expect(html).toContain("prefers-color-scheme: dark")
    expect(html).toContain("data-theme")
  })
})
