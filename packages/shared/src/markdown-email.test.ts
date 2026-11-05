// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { markdownToEmail } from "./markdown-email"

/** What a plain-text reply became before this conversion (tickets bodyToHtml). */
const legacyHtml = (text: string) =>
  `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`

describe("markdownToEmail: a reply with no formatting goes out as it always did", () => {
  const prose = [
    "Bonjour Paul,\n\nMerci pour votre message.\nNous revenons vers vous.\n\nCordialement,\nAlex",
    "5*3 = 15 et 2*3*4 = 24",
    "snake_case, a_b_c et file_name_v2.pdf",
    "Prix* hors taxes *voir conditions",
    "~20 min et ~30 min",
    "Merci\n--\nAlex Rivera",
    "Alex <alex@acme.test> & team",
    "<b>hi</b> and a < b > c",
    "#1 priority, C++ et C++",
    "Écrivez à alex@acme.test ou https://acme.test/a_b?x=1.",
    "Votre commande\n2. rue de Paris",
    // Line structure is not formatting: bullets, numbering, indentation,
    // quotes and runs of blank lines stay exactly as typed.
    "Étapes :\n* ouvrir\n* fermer\n\n1) un\n2) deux\n    indenté\n> cité\n\n\n\nfin",
    "- a\n- b\n---\nAlex",
  ]

  for (const text of prose) {
    it(`keeps ${JSON.stringify(text)} byte for byte`, () => {
      expect(markdownToEmail(text)).toEqual({ text, html: legacyHtml(text) })
    })
  }

  // The editor escapes what would otherwise format ("5\*3", "&lt;b"): the
  // customer reads what was typed.
  it("reads the editor's escapes as the characters typed", () => {
    const { text, html } = markdownToEmail("5\\*3, snake\\_case, a &lt;b> & c, \\~20, \\[y\\]")
    expect(text).toBe("5*3, snake_case, a <b> & c, ~20, [y]")
    expect(html).toBe(legacyHtml(text))
  })

  it("keeps the editor's line breaks", () => {
    expect(markdownToEmail("Best,  \nAlex").text).toBe("Best,\nAlex")
    expect(markdownToEmail("Best,\\\nAlex").text).toBe("Best,\nAlex")
  })

  it("is empty for an empty body", () => {
    expect(markdownToEmail("  \n ")).toEqual({ html: "", text: "" })
  })
})

describe("markdownToEmail: formatting", () => {
  const P = '<p style="margin:0 0 1em">'

  it("renders the marks the editor writes", () => {
    const { html, text } = markdownToEmail("**gras** _ital_ ++souligné++ ~~barré~~ `x < y`")
    expect(html).toContain("<strong>gras</strong>")
    expect(html).toContain("<em>ital</em>")
    expect(html).toContain("<u>souligné</u>")
    expect(html).toContain("<s>barré</s>")
    expect(html).toMatch(/<code style="[^"]+">x &lt; y<\/code>/)
    expect(text).toBe("gras ital souligné ~~barré~~ x < y")
  })

  it("turns paragraphs into the blank line plain text always had", () => {
    expect(markdownToEmail("**a**\n\nb").html).toBe(`${P}<strong>a</strong><br><br>b</p>`)
  })

  // An indented line after a blank line is a code block in markdown: in a
  // formatted body it stays a line of text.
  it("leaves an indented line as text, not a code block", () => {
    const { html, text } = markdownToEmail("**Adresse** :\n\n    12 rue de Paris")
    expect(html).not.toContain("<pre")
    expect(html).toBe(`${P}<strong>Adresse</strong> :<br><br>    12 rue de Paris</p>`)
    expect(text).toBe("Adresse :\n\n    12 rue de Paris")
  })

  it("styles every block inline, with no class", () => {
    const { html } = markdownToEmail("**Note**\n\n> cité\n\n- un\n- deux\n\n1. a\n\n```\ncode\n```")
    expect(html).not.toContain("class=")
    expect(html).toMatch(/<blockquote style="[^"]*border-left:3px solid/)
    expect(html).toMatch(/<ul style="margin:0 0 1em;padding-left:1.5em">/)
    expect(html).toMatch(/<pre style="[^"]*white-space:pre-wrap/)
  })

  it("keeps the text part as typed around the marks", () => {
    const { text } = markdownToEmail("**Liste** :\n* un\n* deux\n  * deux.a\n\n3) c\n\n\n## Fin")
    expect(text).toBe("Liste :\n* un\n* deux\n  * deux.a\n\n3) c\n\n\nFin")
  })

  it("writes links as text (url) in the text part, a bare url once", () => {
    const { html, text } = markdownToEmail("Voir [la doc](https://x.test/doc) ou https://x.test")
    expect(html).toContain('<a href="https://x.test/doc" style="word-break:break-word">la doc</a>')
    expect(text).toBe("Voir la doc (https://x.test/doc) ou https://x.test")
  })

  it("never links anything but web and mail addresses, and loads nothing", () => {
    const { html } = markdownToEmail(
      "[x](javascript:alert(1)) @[Alice](kernel:user:1) ![logo](https://x.test/l.png)",
    )
    expect(html).not.toContain("javascript")
    expect(html).not.toContain("<img")
    expect(html).toContain("@Alice")
    expect(html).toContain('<a href="https://x.test/l.png" style="word-break:break-word">logo</a>')
  })

  it("reads character references as the characters they stand for", () => {
    const { html, text } = markdownToEmail("**Alex** &lt;alex@acme.test> &amp; team")
    expect(text).toBe("Alex <alex@acme.test> & team")
    expect(html).toContain("Alex</strong> &lt;")
    expect(html).not.toContain("&amp;lt;")
  })

  it("draws checklist boxes as characters", () => {
    const { html, text } = markdownToEmail("- [ ] todo\n- [x] done")
    expect(html).toContain("☐ todo")
    expect(html).toContain("☑ done")
    expect(text).toBe("- [ ] todo\n- [x] done")
  })

  // A list inside an item sits there with no gap under it; the next list on
  // its own keeps its gap, whatever was nested before it.
  it("nests a list inside its item without a gap", () => {
    const { html } = markdownToEmail("- **a**\n  - b\n    1. c\n- d\n\n1. e")
    expect(html.match(/<(?:ul|ol) style="[^"]*"/g)).toEqual([
      '<ul style="margin:0 0 1em;padding-left:1.5em"',
      '<ul style="margin:0;padding-left:1.5em"',
      '<ol style="margin:0;padding-left:1.5em"',
      '<ol style="margin:0 0 1em;padding-left:1.5em"',
    ])
  })
})
