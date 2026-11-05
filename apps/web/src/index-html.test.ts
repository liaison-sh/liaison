// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document shell is where the viewport contract lives. `env(safe-area-inset-*)`
// resolves to 0 in a WKWebView unless the viewport opts into the full screen with
// `viewport-fit=cover`, so a page that pads itself correctly still renders under the
// Dynamic Island without this meta tag.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

describe("index.html viewport", () => {
  const html = readFileSync(resolve(__dirname, "..", "index.html"), "utf-8")
  const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? ""

  test("declares a viewport", () => {
    expect(viewport).toContain("width=device-width")
    expect(viewport).toContain("initial-scale=1")
  })

  test("opts into the full screen so env(safe-area-inset-*) is non zero", () => {
    expect(viewport).toContain("viewport-fit=cover")
  })
})
