// SPDX-License-Identifier: FSL-1.1-ALv2
import DOMPurify from "dompurify"
import { apiUrl } from "~/lib/env"

const MAIL_ALLOWED_TAGS = [
  "strong",
  "em",
  "code",
  "a",
  "s",
  "br",
  "pre",
  "span",
  "del",
  "p",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "col",
  "colgroup",
  "caption",
  "div",
  "img",
  "style",
  "figure",
  "figcaption",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "details",
  "summary",
  "mark",
  "small",
  "sub",
  "sup",
  "b",
  "i",
  "u",
  "font",
  "center",
  "big",
]

const MAIL_ALLOWED_ATTR = [
  "href",
  "title",
  "class",
  "target",
  "rel",
  "data-mention-ref",
  "style",
  "src",
  "alt",
  "width",
  "height",
  "align",
  "valign",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "dir",
  "lang",
  "color",
  "size",
  "face",
]

const CSS_URL_RE = /url\s*\(\s*(?!data:image\/[a-z]+;base64,)['"]?[^)'"]+['"]?\s*\)/gi
const CSS_EXFIL_RE =
  /@import\b[^;]*;?|@font-face\s*\{[^}]*url\s*\([^)]*\)[^}]*\}|expression\s*\(|(?:-moz-binding|-webkit-binding|behavior)\s*:/gi

/**
 * Stylesheet (`<style>` block) filter. Rule syntax (`{`, `}`, `;`) is kept; the
 * exfil and remote-`url()` passes apply. Mail renders these blocks inside its
 * own sandboxed, CSP-locked document (MailMessageRenderer), which is the real
 * guard; this pass is defence in depth.
 */
export function sanitizeCssString(css: string): string {
  return css.replace(CSS_EXFIL_RE, "/* stripped */").replace(CSS_URL_RE, "/* stripped */")
}

// ── Inline style: declaration-level allowlist ──────────────────────────────
//
// An inline `style` value is a declaration list written by a stranger. It is
// split into declarations (quote- and paren-aware), and each one is kept only
// when its property is on the allowlist and its value passes the value policy;
// everything else is dropped, and the survivors are re-joined with `;`. So a
// smuggled second declaration (`color:red;background:url(https://tracker)`,
// `position:fixed;z-index:99999`) is vetted on its own and dropped, while the
// legitimate ones around it keep the email's layout.
//
// Some of these bodies (ticket messages) render inline in the app's own DOM,
// not in the mail iframe, so nothing that positions, layers, transforms or
// paints outside the element's box is on the list.

const INLINE_STYLE_PROPERTIES = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "text-overflow",
  "text-transform",
  "vertical-align",
  "white-space",
  "word-break",
  "word-wrap",
  "overflow-wrap",
  "direction",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-collapse",
  "border-spacing",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "box-sizing",
  "display",
  "float",
  "clear",
  "overflow",
  "overflow-x",
  "overflow-y",
  "position",
  "table-layout",
  "caption-side",
  "empty-cells",
  "list-style",
  "list-style-type",
  "list-style-position",
  "opacity",
  "visibility",
])

/** Per-property value constraints, on top of the generic value policy. */
const INLINE_STYLE_VALUE_RULES: Record<string, RegExp> = {
  // No `fixed`, `sticky` or `absolute`: an element taken out of flow could
  // overlay the app around the message. (No top/left/z-index on the list either.)
  position: /^(?:static|relative)$/,
  display:
    /^(?:none|block|inline|inline-block|list-item|flex|inline-flex|table|inline-table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption)$/,
  float: /^(?:left|right|none)$/,
  clear: /^(?:left|right|both|none)$/,
  overflow: /^(?:visible|hidden|auto|scroll|clip)(?: (?:visible|hidden|auto|scroll|clip))?$/,
  "overflow-x": /^(?:visible|hidden|auto|scroll|clip)$/,
  "overflow-y": /^(?:visible|hidden|auto|scroll|clip)$/,
}

/** Functions a value may call. `url()` is allowed only as an inline data image. */
const ALLOWED_CSS_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "linear-gradient",
  "radial-gradient",
])
const SAFE_DATA_IMAGE_URL_RE =
  /url\(\s*(['"]?)data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=]+\1\s*\)/gi
const CSS_FUNCTION_RE = /([a-z-]*)\s*\(/gi
const IMPORTANT_RE = /\s*!\s*important\s*$/i
const PROPERTY_NAME_RE = /^[a-z][a-z-]*$/
// The only characters a value may hold (after its data images are taken out):
// letters and digits in any script (font names), whitespace, and the
// punctuation of lengths, colours, lists, strings and the allowed functions.
// So nothing can escape the declaration (`;{}`), start an at-rule (`@`), a
// markup context (`<>`), a scheme (`:`), or hide a token from the checks
// below behind a CSS escape (`\75 rl(`).
const SAFE_VALUE_CHARS_RE = /^[\p{L}\p{N}\s#%.,'"()+\-/_]*$/u
const FORBIDDEN_VALUE_WORDS_RE = /javascript|vbscript|expression|behavior|binding/i
const NEGATIVE_NUMBER_RE = /(?:^|[\s,(])-\s*\.?\d/

function splitDeclarations(css: string): string[] | null {
  const out: string[] = []
  let quote: string | null = null
  let depth = 0
  let current = ""
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === "(") {
      depth++
    } else if (ch === ")") {
      depth--
      if (depth < 0) return null
    } else if (ch === ";" && depth === 0) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  // An unterminated string or bracket swallows the rest: drop that tail.
  if (quote || depth !== 0) return out
  out.push(current)
  return out
}

function sanitizeDeclaration(declaration: string): string | null {
  const colon = declaration.indexOf(":")
  if (colon < 0) return null
  const name = declaration.slice(0, colon).trim().toLowerCase()
  if (!PROPERTY_NAME_RE.test(name) || !INLINE_STYLE_PROPERTIES.has(name)) return null

  let value = declaration
    .slice(colon + 1)
    .replace(/\s+/g, " ")
    .trim()
  const important = IMPORTANT_RE.test(value)
  if (important) value = value.replace(IMPORTANT_RE, "").trim()
  if (!value) return null

  // Checks run on the value with its allowed data images taken out, so their
  // base64 `;` and `url(` do not trip the policy; everything else is vetted.
  const checked = value.replace(SAFE_DATA_IMAGE_URL_RE, "")
  if (!SAFE_VALUE_CHARS_RE.test(checked)) return null
  if (FORBIDDEN_VALUE_WORDS_RE.test(checked)) return null
  for (const m of checked.matchAll(CSS_FUNCTION_RE)) {
    if (!ALLOWED_CSS_FUNCTIONS.has(m[1].toLowerCase())) return null
  }
  if (name.startsWith("margin") && NEGATIVE_NUMBER_RE.test(checked)) return null
  const rule = INLINE_STYLE_VALUE_RULES[name]
  if (rule && !rule.test(value.toLowerCase())) return null

  return `${name}: ${value}${important ? " !important" : ""}`
}

/**
 * Sanitize an inline declaration list (a `style` attribute, or a raw
 * `<body style>` folded into `body { ... }`): each declaration is vetted on its
 * own against the allowlist, unsafe ones are dropped, the rest re-joined.
 */
export function sanitizeInlineStyle(css: string): string {
  // Comments go first, to nothing, so a token split by one (`u/**/rl(`) is
  // seen whole by the checks. An unterminated comment swallows the rest.
  const uncommented = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
  const declarations = splitDeclarations(uncommented)
  if (!declarations) return ""
  const kept: string[] = []
  for (const declaration of declarations) {
    const safe = sanitizeDeclaration(declaration)
    if (safe) kept.push(safe)
  }
  return kept.join("; ")
}

function decodeAttributeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt|nbsp));?/gi,
    (m: string, dec?: string, hex?: string, named?: string) => {
      if (dec || hex) {
        const code = dec ? Number(dec) : Number.parseInt(hex ?? "", 16)
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd"
      }
      switch (named?.toLowerCase()) {
        case "amp":
          return "&"
        case "quot":
          return '"'
        case "apos":
          return "'"
        case "lt":
          return "<"
        case "gt":
          return ">"
        case "nbsp":
          return " "
        default:
          return m
      }
    },
  )
}

function encodeAttributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function postProcess(html: string): string {
  // Inline style attributes: the serialized value is entity-encoded, so it is
  // decoded before the declaration-level policy runs (the browser decodes it
  // too), then re-encoded. An attribute left with nothing is dropped.
  let result = html.replace(/\sstyle="([^"]*)"/gi, (_m, css: string) => {
    const safe = sanitizeInlineStyle(decodeAttributeEntities(css))
    return safe ? ` style="${encodeAttributeValue(safe)}"` : ""
  })

  // Sanitize <style> tag contents — preserve rule syntax (`{`, `}`, `;`); only
  // DOMPurify + the exfil/url passes apply here.
  result = result.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, css, close) => `${open}${sanitizeCssString(css)}${close}`,
  )

  // Add target=_blank and rel to links
  result = result.replace(/<a(\s[^>]*)?>/gi, (_match, attrs = "") => {
    const withTarget = attrs.includes("target=") ? attrs : `${attrs} target="_blank"`
    const withRel = withTarget.includes('rel="')
      ? withTarget.replace(
          /rel="([^"]*)"/,
          (_m: string, r: string) => `rel="${r} noopener noreferrer"`,
        )
      : `${withTarget} rel="noopener noreferrer"`
    return `<a${withRel}>`
  })

  return result
}

let _purify: ReturnType<typeof DOMPurify> | null = null
function getPurify() {
  if (!_purify && typeof window !== "undefined") _purify = DOMPurify(window)
  return _purify
}

export function sanitizeMailHtml(raw: string): string {
  const purify = getPurify()

  let sanitized: string
  if (purify) {
    sanitized = purify.sanitize(raw, {
      ALLOWED_TAGS: MAIL_ALLOWED_TAGS,
      ALLOWED_ATTR: MAIL_ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
      FORCE_BODY: false,
    })
  } else {
    sanitized = raw
  }

  return postProcess(sanitized)
}

export function rewriteImageSrc(html: string): string {
  if (typeof document !== "undefined") {
    const template = document.createElement("template")
    template.innerHTML = html

    for (const img of template.content.querySelectorAll("img")) {
      // Images never gate the text paint: defer offscreen loads and decode
      // off the main thread. Applied post-sanitize so DOMPurify's attribute
      // allowlist can't strip them.
      img.setAttribute("loading", "lazy")
      img.setAttribute("decoding", "async")
      const src = img.getAttribute("src")?.trim()
      if (!src || !/^https:\/\//i.test(src)) continue
      img.setAttribute("src", apiUrl(`/mail/image-proxy?url=${encodeURIComponent(src)}`))
    }

    return template.innerHTML
  }

  return html.replace(
    /(<img\s[^>]*?)src\s*=\s*"(https?:\/\/[^"]+)"/gi,
    (_match, prefix, url) =>
      `${prefix}src="${apiUrl(`/mail/image-proxy?url=${encodeURIComponent(url)}`)}"`,
  )
}

export function prepareMailHtml(raw: string): string {
  const sanitized = sanitizeMailHtml(raw)
  return rewriteImageSrc(sanitized)
}
