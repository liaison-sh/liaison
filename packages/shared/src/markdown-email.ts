// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE conversion of what someone wrote (the editor's markdown, or an agent's
// plain text) into what a customer receives: email HTML and its text/plain
// alternative. The server sends with it and the browser previews with it, so
// what the approver saw is what the customer gets.
//
// The HTML is built for mail clients, not browsers: every style is inline, no
// class or stylesheet is relied on, nothing loads from outside, and no font is
// forced, so the message reads in the recipient's own client font like any
// mail typed there.
//
// A body with no explicit formatting (lines, bullets, numbering and quotes
// are line structure, not formatting) goes out exactly as plain text always
// did: its text part is what was typed, its HTML the same escaped lines. In a
// formatted body the dialect is the editor's minus what prose trips over by
// accident:
//   - no indented code blocks (an indented address line stays text),
//   - no setext headings (a signature's "--" under a name stays text),
//   - strikethrough only with `~~` ("~20 min" stays text),
//   - a single `*` between two letters or digits is text ("5*3*2", as `_` is
//     in "snake_case"),
//   - raw HTML is shown as typed, never interpreted ("<b>" stays visible),
//   - `<alex@acme.test>` keeps its brackets (the address is still a link).
// Consecutive paragraphs share one block separated by a blank line, as plain
// text always looked. The text part of every body is the body as typed with
// only its explicit inline syntax taken out.
import { Marked, type MarkedExtension, type Token, type Tokens } from "marked"
import { decodeHtmlEntities } from "./html-to-text"
import { editorMarkdown } from "./markdown-rules"

export interface EmailBody {
  html: string
  text: string
}

const BLOCK = "margin:0 0 1em"
const P_OPEN = `<p style="${BLOCK}">`
const LIST = `${BLOCK};padding-left:1.5em`
const QUOTE = `${BLOCK};padding-left:1em;border-left:3px solid #d0d7de;color:#57606a`
const MONO = "font-family:Menlo,Consolas,'Courier New',monospace;font-size:0.9em"
const CODE = `${MONO};background:#f2f3f5;border-radius:3px;padding:0.1em 0.3em`
const PRE = `${BLOCK};${MONO};background:#f2f3f5;border-radius:4px;padding:0.75em 1em;white-space:pre-wrap;word-break:break-word`
const CELL = "border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top"
const HEADING_SIZE = ["1.4em", "1.25em", "1.1em", "1em", "1em", "1em"]

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/** Only web and mail links reach a customer; anything else (an entity ref) is its text. */
const SAFE_HREF = /^(https?:|mailto:)/i

const DOUBLE_TILDE = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/
const WORD_CHAR = /[\p{L}\p{N}]/u

/** The prose-safe dialect on top of the editor's (underline, checklists). */
const proseSafe: MarkedExtension = {
  extensions: [
    {
      name: "intrawordStar",
      level: "inline",
      start: (src) => src.search(/(?<!\*)\*(?!\*)/),
      tokenizer(src, tokens) {
        const before = tokens.at(-1)?.raw.at(-1)
        if (!/^\*[\p{L}\p{N}]/u.test(src) || !before || !WORD_CHAR.test(before)) return undefined
        return { type: "text", raw: "*", text: "*" }
      },
    },
  ],
  tokenizer: {
    autolink: () => undefined,
    // `undefined`, not `false`: false falls back to marked's own rule.
    code: () => undefined,
    lheading: () => undefined,
    del(src) {
      const match = DOUBLE_TILDE.exec(src)
      if (!match) return undefined
      return {
        type: "del",
        raw: match[0],
        text: match[1]!,
        tokens: this.lexer.inlineTokens(match[1]!),
      }
    },
  },
}

/** Marks every list inside these tokens as nested: it sits inside an item. */
function markNested(tokens: Token[]): void {
  for (const t of tokens) {
    if (t.type === "list") (t as NestedList).nested = true
    for (const inner of children(t)) markNested(inner)
  }
}
type NestedList = Tokens.List & { nested?: boolean }

const emailRenderer: MarkedExtension = {
  renderer: {
    paragraph({ tokens }) {
      return `${P_OPEN}${this.parser.parseInline(tokens)}</p>\n`
    },
    heading({ tokens, depth }) {
      const size = HEADING_SIZE[depth - 1] ?? "1em"
      return `<p style="${BLOCK};font-size:${size};font-weight:bold">${this.parser.parseInline(tokens)}</p>\n`
    },
    list(token) {
      for (const item of token.items) markNested(item.tokens)
      const items = token.items.map((item) => this.listitem(item)).join("")
      // A nested list sits inside its item: no gap under it.
      const style = (token as NestedList).nested ? "margin:0;padding-left:1.5em" : LIST
      const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : ""
      const tag = token.ordered ? "ol" : "ul"
      return `<${tag}${start} style="${style}">\n${items}</${tag}>\n`
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens)
      if (!item.task) return `<li>${body}</li>\n`
      return `<li style="list-style:none">${item.checked ? "☑" : "☐"} ${body}</li>\n`
    },
    // The box is drawn by listitem above.
    checkbox: () => "",
    blockquote({ tokens }) {
      return `<blockquote style="${QUOTE}">\n${this.parser.parse(tokens)}</blockquote>\n`
    },
    code({ text }) {
      return `<pre style="${PRE}">${escapeHtml(text.replace(/\n$/, ""))}</pre>\n`
    },
    codespan({ text }) {
      return `<code style="${CODE}">${escapeHtml(text)}</code>`
    },
    hr: () => `<hr style="border:0;border-top:1px solid #d0d7de;${BLOCK}" />\n`,
    html: ({ text }) => escapeHtml(text),
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      if (!SAFE_HREF.test(href)) return inner
      const t = title ? ` title="${escapeHtml(title)}"` : ""
      // A long address wraps on a phone instead of widening the message.
      return `<a href="${escapeHtml(href)}"${t} style="word-break:break-word">${inner}</a>`
    },
    // No external assets: an image is a link to it.
    image({ href, text }) {
      const label = escapeHtml(text || href)
      return SAFE_HREF.test(href)
        ? `<a href="${escapeHtml(href)}" style="word-break:break-word">${label}</a>`
        : label
    },
    table(token) {
      const cell = (c: Tokens.TableCell, tag: "th" | "td") =>
        `<${tag} style="${CELL}">${this.parser.parseInline(c.tokens)}</${tag}>`
      const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`
      const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`)
      return `<table style="${BLOCK};border-collapse:collapse">\n<thead>${head}</thead>\n<tbody>${rows.join("\n")}</tbody>\n</table>\n`
    },
  },
}

const marked = new Marked({ gfm: true, breaks: true }, editorMarkdown, proseSafe, emailRenderer)

// ---- text/plain -----------------------------------------------------------

function linkText(text: string, href: string): string {
  const bare = (s: string) => s.replace(/^(https?:\/\/|mailto:)/i, "").replace(/\/$/, "")
  if (!SAFE_HREF.test(href) || bare(text) === bare(href)) return text
  return `${text} (${href})`
}

function inlineText(tokens: Token[] = []): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "br":
          return "\n"
        case "link":
          return linkText(inlineText((t as Tokens.Link).tokens), (t as Tokens.Link).href)
        case "image":
          return linkText(
            (t as Tokens.Image).text || (t as Tokens.Image).href,
            (t as Tokens.Image).href,
          )
        // Struck text stays visibly struck: dropping the marks would make it read as meant.
        case "del":
          return `~~${inlineText((t as Tokens.Del).tokens)}~~`
        case "codespan":
          return (t as Tokens.Codespan).text
        case "html":
        case "escape":
          return (t as Tokens.HTML).text
        default:
          // Character references are text: "&lt;" reads as "<".
          return "tokens" in t && Array.isArray(t.tokens)
            ? inlineText(t.tokens)
            : decodeHtmlEntities(t.raw)
      }
    })
    .join("")
}

/** Inline syntax the text part drops (keeping what it marks). */
const INLINE_SYNTAX = new Set([
  "strong",
  "em",
  "del",
  "underline",
  "codespan",
  "link",
  "image",
  "escape",
  "br",
])
const HEADING_MARK = /^ {0,3}#{1,6}[ \t]+/

const children = (t: Token): Token[][] => {
  if (t.type === "list") return (t as Tokens.List).items.map((item) => item.tokens)
  if (t.type === "table") {
    const table = t as Tokens.Table
    return [table.header, ...table.rows].flat().map((cell) => cell.tokens)
  }
  return "tokens" in t && Array.isArray(t.tokens) ? [t.tokens] : []
}

/**
 * The text/plain part: the body exactly as typed (indentation, bullets,
 * numbering, blank lines) with only explicit inline syntax taken out: marks
 * keep their text, a link reads "text (url)", an escape or a character
 * reference becomes its character, a heading loses its #.
 */
function sourceText(source: string, tokens: Token[]): string {
  let out = ""
  let at = 0
  const take = (raw: string, plain: string) => {
    const i = source.indexOf(raw, at)
    if (i < 0) return
    out += source.slice(at, i) + plain
    at = i + raw.length
  }
  const visit = (list: Token[]) => {
    for (const t of list) {
      // A line break keeps its line; only a hard break's trailing spaces or
      // backslash go.
      if (t.type === "br") take(t.raw, t.raw.replace(/^(?: +|\\)(?=\n)/, ""))
      else if (INLINE_SYNTAX.has(t.type)) take(t.raw, inlineText([t]))
      else if (t.type === "text" && !("tokens" in t && t.tokens) && t.raw.includes("&")) {
        take(t.raw, decodeHtmlEntities(t.raw))
      } else {
        const mark = t.type === "heading" ? HEADING_MARK.exec(t.raw) : null
        if (mark) take(mark[0], "")
        for (const inner of children(t)) visit(inner)
      }
    }
  }
  visit(tokens)
  return out + source.slice(at)
}

/** Syntax someone wrote on purpose. Line structure alone (bullets, quotes, numbering) is not. */
function isFormatted(tokens: Token[]): boolean {
  return tokens.some((t) => {
    switch (t.type) {
      case "strong":
      case "em":
      case "del":
      case "underline":
      case "codespan":
      case "image":
      case "heading":
      case "code":
      case "table":
        return true
      case "link":
        return t.raw.startsWith("[")
      case "list":
        if ((t as Tokens.List).items.some((item) => item.task)) return true
    }
    return children(t).some(isFormatted)
  })
}

/** A body with no formatting goes out as plain text always did: its lines, escaped. */
const plainHtml = (text: string) =>
  `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`

/** Email HTML and its plain-text alternative for a markdown (or plain-text) body. */
export function markdownToEmail(markdown: string): EmailBody {
  const source = markdown.replace(/\r\n?/g, "\n").trim()
  if (!source) return { html: "", text: "" }
  const tokens = marked.lexer(source)
  const text = sourceText(source, tokens)
  if (!isFormatted(tokens)) return { html: plainHtml(text), text }
  const html = (marked.parser(tokens) as string).replaceAll(`</p>\n${P_OPEN}`, "<br><br>").trim()
  return { html, text }
}
