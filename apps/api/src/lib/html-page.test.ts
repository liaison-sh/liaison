// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { cspHash, escapeHtml, hashedStyleCsp, localeFromAcceptLanguage } from "~/lib/html-page"

describe("html-page helpers", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    )
  })

  it("reads the visitor's language in the header's order, ignoring weights", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr")
    expect(localeFromAcceptLanguage("xx-YY, en;q=0.5")).toBe("en")
    expect(localeFromAcceptLanguage(undefined)).toBe("en")
  })

  it("pins the style by hash and slots extra directives after it", () => {
    const style = "body{margin:0}"
    const hash = createHash("sha256").update(style).digest("base64")
    expect(cspHash(style)).toBe(hash)
    expect(hashedStyleCsp(style)).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
    expect(hashedStyleCsp(style, ["script-src 'sha256-x'"])).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; script-src 'sha256-x'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    )
  })
})
