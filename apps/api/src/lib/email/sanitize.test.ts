// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { markdownToEmail } from "@liaison/shared"
import { sanitizeAgentHtml, sanitizeCustomerHtml } from "./sanitize"

describe("sanitizeCustomerHtml", () => {
  it.each([
    ["<script>alert(1)</script><p>ok</p>", "alert"],
    ['<a href="javascript:alert(1)">x</a>', "javascript:"],
    ["<img onerror=alert(1) src=x>", "onerror"],
    ["<svg><script>alert(1)</script></svg>", "alert"],
    ["<style>body{background:url(javascript:1)}</style>", "javascript:"],
  ])("strips dangerous content from %s", (input, banned) => {
    expect(sanitizeCustomerHtml(input)).not.toContain(banned)
  })

  it("preserves benign content", () => {
    expect(sanitizeCustomerHtml("<p><b>hi</b></p>")).toContain("<b>hi</b>")
  })

  it("returns empty string for empty input", () => {
    expect(sanitizeCustomerHtml("")).toBe("")
  })

  it("allows http/https/mailto links", () => {
    const r = sanitizeCustomerHtml(
      '<a href="https://example.test">x</a><a href="mailto:a@x.test">y</a>',
    )
    expect(r).toContain("https://example.test")
    expect(r).toContain("mailto:a@x.test")
  })

  // A formatted reply shown back in the ticket keeps its strikethrough.
  it("keeps strikethrough", () => {
    expect(sanitizeCustomerHtml("<p><s>old</s> <del>gone</del></p>")).toBe(
      "<p><s>old</s> <del>gone</del></p>",
    )
  })

  it("strips on* attributes", () => {
    const r = sanitizeCustomerHtml('<div onclick="bad()">x</div>')
    expect(r).not.toContain("onclick")
  })
})

describe("sanitizeAgentHtml", () => {
  it("allows agent-formatted markup but strips scripts", () => {
    const r = sanitizeAgentHtml("<p>Hello</p><script>x</script>")
    expect(r).toContain("<p>Hello</p>")
    expect(r).not.toContain("<script>")
  })

  it("preserves common rich-text tags", () => {
    const r = sanitizeAgentHtml(
      "<p><b>bold</b> <i>italic</i> <ul><li>x</li></ul> <a href='https://x.test'>l</a></p>",
    )
    expect(r).toContain("<b>bold</b>")
    expect(r).toContain("<i>italic</i>")
    expect(r).toContain("<li>x</li>")
    expect(r).toContain('href="https://x.test"')
  })

  it("strips javascript: links", () => {
    const r = sanitizeAgentHtml('<a href="javascript:alert(1)">x</a>')
    expect(r).not.toContain("javascript:")
  })

  it("returns empty string for empty input", () => {
    expect(sanitizeAgentHtml("")).toBe("")
  })
})

describe("sanitizeAgentHtml keeps the email the editor's markdown becomes", () => {
  it("passes markdownToEmail output through unchanged", () => {
    const { html } = markdownToEmail(
      "**b** _i_ ++u++ ~~s~~ `c`\n\n> q\n\n- a\n  - b\n\n3. x\n\n```\npre\n```\n\n---\n\n| h |\n|---|\n| d |\n\n- [ ] t",
    )
    expect(sanitizeAgentHtml(html)).toBe(html)
  })

  it("drops styles the conversion never writes", () => {
    const r = sanitizeAgentHtml(
      '<p style="position:fixed;background:url(https://x.test/t.png);margin:0 0 1em">x</p>',
    )
    expect(r).toBe('<p style="margin:0 0 1em">x</p>')
  })
})

describe("sanitizers drop class names the app's stylesheet would resolve", () => {
  const overlay = '<div class="fixed inset-0 z-50 bg-black">cover</div><p class="hidden">x</p>'

  it("sanitizeCustomerHtml strips class from a stranger's email", () => {
    const r = sanitizeCustomerHtml(overlay)
    expect(r).not.toContain("class")
    expect(r).toContain("cover")
  })

  it("sanitizeAgentHtml strips class too", () => {
    expect(sanitizeAgentHtml(overlay)).not.toContain("class")
  })

  it("still keeps the quote-trim marker on a div", () => {
    expect(sanitizeCustomerHtml('<div data-quote-trimmed="3">q</div>')).toContain(
      'data-quote-trimmed="3"',
    )
  })
})
