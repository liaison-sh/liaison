// SPDX-License-Identifier: FSL-1.1-ALv2
import sanitizeHtml from "sanitize-html"

const SAFE_SCHEMES = ["http", "https", "mailto", "cid"]

const customerOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    // Our own quote-elision marker div (strip-quoted.ts runs BEFORE sanitize
    // on the tickets read path) — keep its size attribute on the wire.
    div: ["data-quote-trimmed"],
    // No `class` on anything a stranger wrote: their class names would resolve
    // against the app's own stylesheet (fixed, inset-0, z-50, ...) and let an
    // email overlay or restyle the UI around it.
  },
  allowedSchemes: SAFE_SCHEMES,
  allowedSchemesByTag: { a: SAFE_SCHEMES, img: ["http", "https", "cid", "data"] },
  disallowedTagsMode: "discard",
  exclusiveFilter: (frame) => frame.tag === "style" || frame.tag === "script",
  transformTags: {
    a: (tagName, attribs) => {
      const out: Record<string, string> = { ...attribs }
      if (out.href && /^javascript:/i.test(out.href.trim())) {
        delete out.href
      }
      return { tagName, attribs: out }
    },
  },
}

// The inline styles markdownToEmail (@liaison/shared) writes: spacing, quote
// rules, code shading, list indents. Nothing that positions, hides or loads.
const LENGTH = [/^[\d.]+(em|px)?( [\d.]+(em|px)?){0,3}$/]
const COLOR = [/^#[0-9a-f]{3,6}$/i]
const agentStyles: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    margin: LENGTH,
    padding: LENGTH,
    "padding-left": LENGTH,
    border: [/^0$/, /^1px solid #[0-9a-f]{3,6}$/i],
    "border-top": [/^1px solid #[0-9a-f]{3,6}$/i],
    "border-left": [/^3px solid #[0-9a-f]{3,6}$/i],
    "border-radius": LENGTH,
    "border-collapse": [/^collapse$/],
    color: COLOR,
    background: COLOR,
    "font-family": [/^[\w ,'-]+$/],
    "font-size": LENGTH,
    "font-weight": [/^bold$/],
    "list-style": [/^none$/],
    "text-align": [/^left$/],
    "vertical-align": [/^top$/],
    "white-space": [/^pre-wrap$/],
    "word-break": [/^break-word$/],
  },
}

const agentOptions: sanitizeHtml.IOptions = {
  ...customerOptions,
  allowedTags: [
    ...(Array.isArray(customerOptions.allowedTags) ? customerOptions.allowedTags : []),
    "figure",
    "figcaption",
    "sub",
    "sup",
  ],
  allowedAttributes: {
    ...((customerOptions.allowedAttributes ?? {}) as Record<
      string,
      sanitizeHtml.AllowedAttribute[]
    >),
    a: ["href", "title", "target", "rel"],
    ol: ["start"],
    "*": ["style"],
  },
  allowedStyles: agentStyles,
}

export function sanitizeCustomerHtml(html: string): string {
  if (!html) return ""
  return sanitizeHtml(html, customerOptions)
}

export function sanitizeAgentHtml(html: string): string {
  if (!html) return ""
  return sanitizeHtml(html, agentOptions)
}
