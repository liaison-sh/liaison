// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "vitest"

describe("mail CSS sanitizer", () => {
  let sanitizeMailHtml: (html: string) => string
  let rewriteImageSrc: (html: string) => string

  beforeAll(async () => {
    const mod = await import("~/modules/mail/mail-sanitize")
    sanitizeMailHtml = mod.sanitizeMailHtml
    rewriteImageSrc = mod.rewriteImageSrc
  })

  it("preserves safe HTML tags", () => {
    const input = "<p>Hello <strong>world</strong></p>"
    expect(sanitizeMailHtml(input)).toContain("<p>")
    expect(sanitizeMailHtml(input)).toContain("<strong>")
  })

  it("strips script tags", () => {
    const input = '<p>Hi</p><script>alert("xss")</script>'
    expect(sanitizeMailHtml(input)).not.toContain("<script>")
  })

  it("strips url() in CSS properties (exfiltration vector)", () => {
    const input = '<style>p { background: url("https://tracker.com/pixel.gif"); }</style>'
    const result = sanitizeMailHtml(input)
    expect(result).not.toContain("url(")
  })

  it("allows data: URIs in CSS for small inline assets (inline style)", () => {
    const input = '<p style="background: url(data:image/png;base64,abc123)">test</p>'
    const result = sanitizeMailHtml(input)
    expect(result).toContain("data:image/png")
  })

  it("strips expression() and -moz-binding", () => {
    const input = '<div style="width: expression(document.body.clientWidth)">test</div>'
    const result = sanitizeMailHtml(input)
    expect(result).not.toContain("expression")
  })

  it("rewrites img src to proxy URL", () => {
    const input = '<img src="https://example.com/logo.png" alt="Logo">'
    const result = rewriteImageSrc(input)
    expect(result).toContain("/api/mail/image-proxy?url=")
    expect(result).toContain(encodeURIComponent("https://example.com/logo.png"))
  })

  it("marks every image lazy-loading + async-decoding so images never gate the text paint", () => {
    const input = '<img src="https://example.com/a.png"><img src="cid:inline-1">'
    const result = rewriteImageSrc(input)
    expect(result.match(/loading="lazy"/g)).toHaveLength(2)
    expect(result.match(/decoding="async"/g)).toHaveLength(2)
  })

  it("rewrites entity-escaped image URLs using the decoded URL", () => {
    const input = '<img src="https://example.com/logo.png?x=1&amp;y=2" alt="Logo">'
    const result = rewriteImageSrc(input)
    expect(result).toContain(encodeURIComponent("https://example.com/logo.png?x=1&y=2"))
    expect(result).not.toContain("%26amp%3B")
  })

  it("forces target=_blank and rel on links", () => {
    const input = '<a href="https://example.com">Link</a>'
    const result = sanitizeMailHtml(input)
    expect(result).toContain('target="_blank"')
    expect(result).toContain("noopener")
  })

  it("strips curly braces from inline style values to prevent CSS block injection", () => {
    const input = '<p style="color:red}body{background:url(https://evil.com)">test</p>'
    const result = sanitizeMailHtml(input)
    expect(result).not.toContain("{")
    expect(result).not.toContain("}")
  })

  it("keeps multi-declaration inline styles, vetting each declaration on its own", () => {
    const input = '<div style="color:red;background:blue;font-size:12px">test</div>'
    const result = sanitizeMailHtml(input)
    expect(result).toContain('style="color: red; background: blue; font-size: 12px"')
  })

  it("drops an injected dangerous declaration while the safe ones around it stay", () => {
    const input =
      '<div style="color:#333; background:url(https://tracker.example/p.gif); font-size:14px; position:fixed; z-index:99999; top:0">test</div>'
    const result = sanitizeMailHtml(input)
    expect(result).toContain('style="color: #333; font-size: 14px"')
    expect(result).not.toContain("url(")
    expect(result).not.toContain("fixed")
    expect(result).not.toContain("z-index")
    expect(result).not.toContain("top")
  })

  it("keeps an Outlook/Gmail-style table cell's styling", () => {
    const input =
      `<table cellpadding="0" style="border-collapse:collapse; width:100%; max-width:600px"><tr>` +
      `<td style="font-family:'Segoe UI',Arial,sans-serif; color:#333333; padding:8px 12px; font-size:14px; line-height:20px; border-bottom:1px solid #e5e5e5; mso-line-height-rule:exactly">Hello</td>` +
      `<td style="font-family: &quot;Helvetica Neue&quot;, Helvetica; background-color: rgb(245, 245, 245) !important; text-align:right">x</td>` +
      `</tr></table>`
    const result = sanitizeMailHtml(input)
    expect(result).toContain(
      `style="font-family: 'Segoe UI',Arial,sans-serif; color: #333333; padding: 8px 12px; font-size: 14px; line-height: 20px; border-bottom: 1px solid #e5e5e5"`,
    )
    expect(result).toContain(
      'style="font-family: &quot;Helvetica Neue&quot;, Helvetica; background-color: rgb(245, 245, 245) !important; text-align: right"',
    )
    expect(result).toContain('style="border-collapse: collapse; width: 100%; max-width: 600px"')
  })

  it("drops a style attribute left with no safe declaration", () => {
    const result = sanitizeMailHtml('<p style="position:absolute;left:-9999px">x</p>')
    expect(result).toBe("<p>x</p>")
  })

  describe("sanitizeInlineStyle", () => {
    let sanitizeInlineStyle: (css: string) => string
    beforeAll(async () => {
      sanitizeInlineStyle = (await import("~/modules/mail/mail-sanitize")).sanitizeInlineStyle
    })

    it.each([
      ["remote url()", "background:url(https://tracker.example/p.gif)"],
      ["quoted remote url()", "background-image:url('https://tracker.example/p.gif')"],
      ["image-set()", 'background-image:image-set("https://t.example/a.png" 1x)'],
      ["@import", "color:red @import 'https://t.example/x.css'"],
      ["expression()", "width:expression(document.body.clientWidth)"],
      ["javascript:", "background:javascript:alert(1)"],
      ["behavior", "behavior:url(x.htc)"],
      ["-moz-binding", "-moz-binding:url(https://t.example/x.xml#b)"],
      ["CSS escape decoding to url(", "background:\\75 rl(https://t.example/p.gif)"],
      ["escaped property name", "posit\\69 on:fixed"],
      ["comment splitting url(", "background:u/**/rl(https://t.example/p.gif)"],
      ["comment splitting expression(", "width:expr/**/ession(alert(1))"],
      ["position:fixed", "position:fixed"],
      ["position:sticky", "position:sticky"],
      ["position:absolute", "position:absolute"],
      ["z-index", "z-index:2147483647"],
      ["top/left offsets", "top:0"],
      ["transform", "transform:translateY(-500px)"],
      ["box-shadow overlay", "box-shadow:0 0 0 9999px #000"],
      ["negative margin", "margin:-500px 0 0 0"],
      ["negative margin-top", "margin-top:-.5em"],
      ["calc() hiding a negative", "margin-top:calc(0px - 500px)"],
      ["var()", "color:var(--color-accent)"],
      ["attr()", "width:attr(data-w)"],
      ["block breakout", "color:red}body{background:blue"],
      ["unterminated string swallowing a declaration", "font-family:'a;position:fixed"],
      ["unknown vendor property", "mso-line-height-rule:exactly"],
      ["a scheme in a value", "background:data:text/html,x"],
      ["an entity-like value", "color:&#x72;ed"],
      ["svg data url", "background:url(data:image/svg+xml;base64,PHN2Zz4=)"],
    ])("drops %s", (_label, css) => {
      expect(sanitizeInlineStyle(css)).toBe("")
    })

    it("keeps the safe neighbours of a dropped declaration", () => {
      expect(
        sanitizeInlineStyle("color:#333;background:u/**/rl(https://t.example);padding:8px"),
      ).toBe("color: #333; padding: 8px")
    })

    it("keeps relative/static position, positive margins and inline data images", () => {
      expect(
        sanitizeInlineStyle(
          "position:relative; margin:0 auto 12px; background:url(data:image/png;base64,iVBORw0KGgo=) no-repeat",
        ),
      ).toBe(
        "position: relative; margin: 0 auto 12px; background: url(data:image/png;base64,iVBORw0KGgo=) no-repeat",
      )
    })

    it("keeps a font name in a non-Latin script", () => {
      expect(sanitizeInlineStyle("font-family:'微软雅黑',Meiryo,sans-serif")).toBe(
        "font-family: '微软雅黑',Meiryo,sans-serif",
      )
    })

    it("keeps display:none (hidden preheaders) and gradients", () => {
      expect(
        sanitizeInlineStyle(
          "display:none; max-height:0; overflow:hidden; background:linear-gradient(#fff, rgba(0,0,0,.1))",
        ),
      ).toBe(
        "display: none; max-height: 0; overflow: hidden; background: linear-gradient(#fff, rgba(0,0,0,.1))",
      )
    })
  })
})
