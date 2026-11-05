// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pageMainContent, stripPageChrome, visibleTextLength } from "./page-main-content"
import { htmlToMarkdown } from "./web-tools"

const HEAVY_NAV = readFileSync(join(import.meta.dir, "__fixtures__/heavy-nav-page.html"), "utf8")

describe("a fetched page's main content", () => {
  it("drops the navigation, language picker, footer and cookie banner of a heavy page", () => {
    const markdown = htmlToMarkdown(pageMainContent(HEAVY_NAV))
    // The main content, whole, including its own header and side note.
    expect(markdown).toContain("Regulation (EU) 2026/101")
    expect(markdown).toContain("Article 1")
    expect(markdown).toContain("Article 2")
    expect(markdown).toContain("The obligations apply from 1 January 2027.")
    expect(markdown).toContain("Note on the consolidated text")
    // The chrome, gone.
    for (const chrome of [
      "Български",
      "Suomi",
      "Advanced search",
      "We use cookies",
      "Accept all cookies",
      "Legal notice",
      "Skip to main content",
      "Related documents",
    ]) {
      expect(markdown).not.toContain(chrome)
    }
    // And the page is much smaller for it.
    expect(markdown.length).toBeLessThan(htmlToMarkdown(HEAVY_NAV).length / 2)
  })

  it("keeps a header or footer inside the page's main content or an article", () => {
    const html =
      "<body><header>Site</header><article><header><h1>Title kept</h1></header><p>Body</p><footer>Byline kept</footer></article><footer>Site footer</footer></body>"
    const out = stripPageChrome(html)
    expect(out).toContain("Title kept")
    expect(out).toContain("Byline kept")
    expect(out).not.toContain("Site footer")
    expect(out).not.toContain(">Site<")
  })

  it("falls back to the full page when stripping would leave too little of it", () => {
    const wrapped = `<body><header><h1>Everything is in a header</h1><p>${"Real content. ".repeat(40)}</p></header><p>tiny</p></body>`
    expect(pageMainContent(wrapped)).toBe(wrapped)
    const menuOnly = `<body><nav>${"<a href='/x'>Menu entry</a>".repeat(60)}</nav><p>Short page.</p></body>`
    expect(pageMainContent(menuOnly)).toBe(menuOnly)
  })

  it("keeps a small page whose stripped text is still most of it", () => {
    const small = "<body><nav>Home</nav><p>A short note of a page.</p></body>"
    expect(pageMainContent(small)).not.toContain("Home")
    expect(pageMainContent(small)).toContain("A short note of a page.")
  })

  it("passes text that is not HTML through", () => {
    const text = `${"plain text line\n".repeat(30)}`
    expect(pageMainContent(text)).toBe(text)
    expect(visibleTextLength("<p>a  b</p>")).toBe(3)
  })
})
