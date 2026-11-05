// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { decodeHtmlEntities, htmlToText } from "./html-to-text"

// Characterization: the implementations this helper replaced, copied verbatim
// so every behaviour difference is pinned side by side with the new output.
//
// BLOCK: mail + tickets search enrichment, the tickets slim message view, the
// text/plain part of outgoing ticket mail (four identical copies).
const legacyBlock = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim()
// FLAT: web fetch text mode and the public tickets webhook snippet.
const legacyFlat = (html: string) =>
  html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
// TAGS: the web quote splitter and the server quote trimmer length checks.
const legacyTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()

interface Case {
  html: string
  text: string
  single: string
  block: string
  flat: string
  tags: string
}

const CASES: Record<string, Case> = {
  paragraphs: {
    html: "<p>Hello</p><p>World</p>",
    text: "Hello\nWorld",
    single: "Hello World",
    block: "Hello\nWorld",
    flat: "Hello World",
    tags: "Hello World",
  },
  "line breaks": {
    html: "Line one<br>Line two<br/>Line three",
    text: "Line one\nLine two\nLine three",
    single: "Line one Line two Line three",
    block: "Line one\nLine two\nLine three",
    flat: "Line one Line two Line three",
    tags: "Line one Line two Line three",
  },
  // Source indentation is whitespace, as a browser renders it; BLOCK kept it verbatim.
  "source whitespace": {
    html: "<div>\n  <p>Hello\n  world</p>\n  <p>Second</p>\n</div>",
    text: "Hello world\nSecond",
    single: "Hello world Second",
    block: "Hello\n  world\n\n  Second",
    flat: "Hello world Second",
    tags: "Hello world Second",
  },
  // FLAT and TAGS split words at inline tags ("it alic", "docs .").
  "inline tags": {
    html: "Hello <strong>bold</strong> and <em>it</em>alic",
    text: "Hello bold and italic",
    single: "Hello bold and italic",
    block: "Hello bold and italic",
    flat: "Hello bold and it alic",
    tags: "Hello bold and it alic",
  },
  links: {
    html: 'See <a href="https://example.com/a?b=1&amp;c=2">the docs</a>.',
    text: "See the docs.",
    single: "See the docs.",
    block: "See the docs.",
    flat: "See the docs .",
    tags: "See the docs .",
  },
  "quoted reply": {
    html: '<div>Thanks!</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Jan 1, 2026 at 10:00 AM Bob &lt;bob@x.com&gt; wrote:</div><blockquote>Original &amp; message</blockquote></div>',
    text: "Thanks!\nOn Mon, Jan 1, 2026 at 10:00 AM Bob <bob@x.com> wrote:\nOriginal & message",
    single: "Thanks! On Mon, Jan 1, 2026 at 10:00 AM Bob <bob@x.com> wrote: Original & message",
    block: "Thanks!\nOn Mon, Jan 1, 2026 at 10:00 AM Bob <bob@x.com> wrote:\nOriginal & message",
    flat: "Thanks! On Mon, Jan 1, 2026 at 10:00 AM Bob &lt;bob@x.com&gt; wrote: Original &amp; message",
    tags: "Thanks! On Mon, Jan 1, 2026 at 10:00 AM Bob &lt;bob@x.com&gt; wrote: Original & message",
  },
  // BLOCK glued adjacent cells together ("SKUQty").
  table: {
    html: "<table><tr><th>SKU</th><th>Qty</th></tr><tr><td>A-1</td><td>2</td></tr></table>",
    text: "SKU Qty\nA-1 2",
    single: "SKU Qty A-1 2",
    block: "SKUQty\nA-12",
    flat: "SKU Qty A-1 2",
    tags: "SKU Qty A-1 2",
  },
  list: {
    html: "<ul><li>one</li><li>two</li></ul>after",
    text: "one\ntwo\nafter",
    single: "one two after",
    block: "one\ntwo\nafter",
    flat: "one two after",
    tags: "one two after",
  },
  // BLOCK decoded `&amp;lt;` twice (to "<") and knew five entities; the others decoded fewer.
  entities: {
    html: "Caf&eacute; &amp; cr&egrave;me &lt;tag&gt; &quot;q&quot; &#39;s&#39; &#x2019; &nbsp;x &amp;lt; &unknown;",
    text: "Café & crème <tag> \"q\" 's' ’ x &lt; &unknown;",
    single: "Café & crème <tag> \"q\" 's' ’ x &lt; &unknown;",
    block: 'Caf&eacute; & cr&egrave;me <tag> "q" &#39;s&#39; &#x2019;  x < &unknown;',
    flat: "Caf&eacute; &amp; cr&egrave;me &lt;tag&gt; &quot;q&quot; &#39;s&#39; &#x2019; &nbsp;x &amp;lt; &unknown;",
    tags: "Caf&eacute; & cr&egrave;me &lt;tag&gt; &quot;q&quot; &#39;s&#39; &#x2019; x &lt; &unknown;",
  },
  // The head's title and noscript fallback are not rendered text; TAGS kept script and style bodies.
  "script, style and head": {
    html: "<head><title>T</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Visible</p><noscript>js off</noscript></body>",
    text: "Visible",
    single: "Visible",
    block: "TVisible\njs off",
    flat: "T Visible js off",
    tags: "T p{color:red} alert(1) Visible js off",
  },
  // A comment holding a tag leaked its tail into every legacy output.
  comment: {
    html: "a<!-- hidden <b>x</b> -->b",
    text: "ab",
    single: "ab",
    block: "ax -->b",
    flat: "a x -->b",
    tags: "a x -->b",
  },
  // A bare `<` in text swallowed everything up to the next `>`.
  "less-than in text": {
    html: "1 < 2 and 3 > 2",
    text: "1 < 2 and 3 > 2",
    single: "1 < 2 and 3 > 2",
    block: "1  2",
    flat: "1 2",
    tags: "1 2",
  },
  empty: { html: "", text: "", single: "", block: "", flat: "", tags: "" },
}

describe("htmlToText", () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: new output, and the legacy outputs it replaced`, () => {
      expect(htmlToText(c.html)).toBe(c.text)
      expect(htmlToText(c.html, { singleLine: true })).toBe(c.single)
      expect(legacyBlock(c.html)).toBe(c.block)
      expect(legacyFlat(c.html)).toBe(c.flat)
      expect(legacyTags(c.html)).toBe(c.tags)
    })
  }

  it("keeps an unknown or out of range numeric entity literal", () => {
    expect(htmlToText("&#0; &#xD800; &#1114112; &#65;")).toBe("&#0; &#xD800; &#1114112; A")
  })

  it("collapses runs of line breaks to one blank line", () => {
    expect(htmlToText("a<br><br><br><br>b")).toBe("a\n\nb")
  })

  // Inbound mail and fetched web pages are attacker text. Every pattern that
  // strips a span used to rescan to the end of the input from each opener that
  // never closed, so a few hundred kilobytes of `<!--` held the event loop for
  // seconds (quadratic). Each input here is ~200 KB; linear work is milliseconds.
  for (const [name, unit] of [
    ["unclosed comments", "<!--"],
    ["unclosed script openers", "<script"],
    ["unclosed script elements", "<script>"],
    ["unclosed tags", "<a"],
    ["mixed openers", "<!--<style<title>"],
  ] as const) {
    it(`stays linear on ${name}`, () => {
      const html = unit.repeat(Math.ceil(200_000 / unit.length))
      const start = performance.now()
      htmlToText(html)
      htmlToText(html, { singleLine: true })
      expect(performance.now() - start).toBeLessThan(250)
    })
  }

  // The scanners replaced these regexes; on any input they must agree.
  const regexReference = (html: string): string =>
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|template|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/\s+/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /(?:<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|table|thead|tbody|tfoot|ul|ol|dl|dt|dd|section|article|header|footer|aside|nav|figure|figcaption|address)\s*>\s*)+/gi,
        "\n",
      )
      .replace(/<\/t[dh]\s*>/gi, " ")
      .replace(/<\/?[a-zA-Z!][^>]*>/g, "")
  it("strips exactly what the regex chain stripped, on generated markup", () => {
    const tokens = [
      "<!--",
      "-->",
      "--",
      "<!-->",
      "<script",
      "<SCRIPT ",
      "<scripts>",
      ">",
      "</script>",
      "</SCRIPT  >",
      "</script",
      "<style>",
      "</style >",
      "<title>",
      "</title>",
      "<head>",
      "</head>",
      "<noscript>",
      "</noscript>",
      "<template>",
      "</template>",
      "<a",
      "<b>",
      "</b>",
      "</p>",
      "<br>",
      "</td>",
      "<",
      "/",
      "!",
      "x",
      "é",
      " ",
      "\n",
      "<!",
      "</",
    ]
    let seed = 0x5eed
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    for (let i = 0; i < 4000; i++) {
      const length = next() % 24
      let html = ""
      for (let j = 0; j < length; j++) html += tokens[next() % tokens.length]
      expect(htmlToText(html, { singleLine: true })).toBe(
        decodeHtmlEntities(regexReference(html)).replace(/\s+/g, " ").trim(),
      )
    }
  })
})
