// SPDX-License-Identifier: FSL-1.1-ALv2
// Payload shapes from published DOMPurify bypass advisories, run through both
// app sanitizers with their real configurations. The advisories need options
// these configs do not use (SAFE_FOR_TEMPLATES, IN_PLACE) or SVG animation
// elements they do not allow; this pins that, so a config change that turns one
// of them on, or a dependency regression, fails here.
import { describe, expect, it } from "vitest"
import { sanitizeMailHtml } from "~/modules/mail/mail-sanitize"
import { sanitizeHtml } from "./sanitize"

const PAYLOADS = [
  // SMIL animation rewriting an href to a script URL.
  '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">x</text></a></svg>',
  '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
  // Template-expression and mXSS shapes.
  '<div>{{constructor.constructor("alert(1)")()}}</div><img src=x onerror=alert(1)>',
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><img onerror=alert(1) src>">',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
]

function hasActiveContent(html: string): boolean {
  const t = document.createElement("template")
  t.innerHTML = html
  for (const el of t.content.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase()
    if (["script", "iframe", "animate", "set", "svg", "math", "object", "embed"].includes(tag))
      return true
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) return true
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers drop control characters before the scheme, so the check must too
      if (/^\s*javascript:/i.test(a.value.replace(/[\u0000-\u001f]/g, ""))) return true
      if (a.name === "srcdoc") return true
    }
  }
  return false
}

describe("sanitizers against published DOMPurify bypass payloads", () => {
  for (const p of PAYLOADS) {
    it(`markdown sanitizer neutralises ${p.slice(0, 48)}`, () => {
      expect(hasActiveContent(sanitizeHtml(p))).toBe(false)
    })
    it(`mail sanitizer neutralises ${p.slice(0, 48)}`, () => {
      expect(hasActiveContent(sanitizeMailHtml(p))).toBe(false)
    })
  }
})
