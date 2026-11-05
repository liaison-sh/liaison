// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { localeFromAcceptLanguage } from "~/lib/html-page"
import { CALLBACK_PAGE_CSP, renderCallbackPage } from "./callback-page"

describe("MCP sign-in callback page", () => {
  it("titles the success page with the server's name", () => {
    const html = renderCallbackPage({ kind: "ok", locale: "en", serverName: "Notion" })
    expect(html).toContain("<title>Notion connected</title>")
    expect(html).toContain("<h1>Notion connected</h1>")
    expect(html).toContain("You can close this window")
  })

  it("escapes a hostile server name, error message and reason code", () => {
    const hostile = `"><img src=x onerror=alert(1)><script>alert(2)</script>`
    const ok = renderCallbackPage({ kind: "ok", locale: "en", serverName: hostile })
    const err = renderCallbackPage({ kind: "error", locale: "en", message: hostile, code: hostile })
    for (const html of [ok, err]) {
      expect(html).not.toContain("<script>")
      expect(html).not.toContain("<img")
      expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;")
    }
    expect(err).toContain("<h1>Sign-in did not complete</h1>")
  })

  it("pins its only stylesheet by hash and loads nothing", () => {
    const html = renderCallbackPage({ kind: "ok", locale: "en", serverName: null })
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ""
    const hash = createHash("sha256").update(style).digest("base64")
    expect(CALLBACK_PAGE_CSP).toContain(`style-src 'sha256-${hash}'`)
    expect(CALLBACK_PAGE_CSP).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script|<link|https?:\/\//)
    expect(style).toContain("prefers-color-scheme:dark")
  })

  it("speaks the visitor's language", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr")
    const html = renderCallbackPage({ kind: "ok", locale: "fr", serverName: "Notion" })
    expect(html).toContain('lang="fr"')
    expect(html).not.toContain("Notion connected")
  })
})
