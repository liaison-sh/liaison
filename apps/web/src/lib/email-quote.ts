// SPDX-License-Identifier: FSL-1.1-ALv2
// Email quoted-history splitting — shared by the Tickets and Mail apps.
// Two pure, framework-agnostic entry points:
//   * splitQuotedHtml(html)          — structural split of an HTML email
//     body at the first quote container (blockquote / gmail_quote /
//     freshdesk_quote / attribution line), for the innerHTML render path.
//   * splitQuotedHistory(cur, prev)  — plain-text line-matching fallback
//     (collapses the classic '>'-quoted repeat of the previous message).
// Both return an always-visible part + a collapsible quoted tail (empty
// when there is nothing worth collapsing). No SolidJS / DOM-render deps;
// splitQuotedHtml uses DOMParser/Range and no-ops where those are absent.

import { htmlToText } from "@liaison/shared"

// Minimum quoted-tail length worth collapsing — short trailing overlaps (a
// one-word coincidence, a shared signoff) aren't "quoted history" and would
// make the toggle pop up in front of near-empty content.
const MIN_QUOTE_LENGTH = 20

/** Strips a leading "> " / ">>" quote-marker prefix from one line, tolerant of marker whitespace. */
function stripQuoteMarker(line: string): string {
  return line.replace(/^\s*>+\s?/, "")
}

/**
 * Whitespace/quote-marker-tolerant normalizer for COMPARING two lines: strips
 * quote markers, collapses internal whitespace, and trims — so a quoted line
 * (marker-prefixed, rewrapped, extra spaces added by the mail client) still
 * compares equal to the original line it quotes.
 */
function normalizeLine(line: string): string {
  return stripQuoteMarker(line).replace(/\s+/g, " ").trim()
}

/** A line a mail client inserts at a quote boundary — collapses WITH the quote it introduces. */
function isQuoteBoundaryLine(line: string): boolean {
  const t = line.trim()
  if (t.length === 0) return true
  if (/^on .{0,160}wrote:$/i.test(t)) return true
  if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) return true
  if (/^-{2,}$/.test(t)) return true
  return false
}

/**
 * Substring of the server-side elision note (`apps/api/src/lib/email/strip-quoted.ts`):
 * a message body containing it had its quoted tail trimmed server-side
 * (`stripQuoted:true` page reads) and the full body must be lazily re-fetched
 * (tickets:get with `messageId` + `stripQuoted:false`) before the quote can be
 * shown. Matches both the text note ("[quoted history trimmed: N chars — …]")
 * and the HTML marker div ("[quoted history trimmed: N chars]").
 */
export const QUOTE_TRIMMED_MARKER = "[quoted history trimmed:"

const TRIMMED_MARKER_HTML_RE = /<div[^>]*>\s*\[quoted history trimmed:[^\]]*\]\s*<\/div>/gi
const TRIMMED_MARKER_TEXT_RE = /\n?\[quoted history trimmed:[^\]]*\]/g

/** True when either body carries the server's quoted-history elision note. */
export function hasTrimmedQuoteMarker(message: {
  htmlBody?: string | null
  textBody?: string | null
}): boolean {
  return (
    (message.htmlBody ?? "").includes(QUOTE_TRIMMED_MARKER) ||
    (message.textBody ?? "").includes(QUOTE_TRIMMED_MARKER)
  )
}

/** Strip the server's elision note from a body before display (the UI renders
 *  its own "Show quoted text" affordance instead of the raw note line). */
export function removeTrimmedQuoteMarker(body: string): string {
  return body
    .replace(TRIMMED_MARKER_HTML_RE, "")
    .replace(TRIMMED_MARKER_TEXT_RE, "")
    .replace(/\s+$/, "")
}

export interface QuoteSplit {
  /** The part of the body to always show. */
  visible: string
  /** The trailing quoted-history part, hidden behind the toggle (empty if none detected). */
  quoted: string
}

/**
 * Detect a trailing quoted-history block in an inbound message's plain text
 * body: the classic Gmail-style "reply above, entire prior message quoted
 * below" shape. Works line by line (whitespace/quote-marker tolerant per
 * line via normalizeLine) — finds the earliest line in `currentText` where a
 * contiguous run of lines starts matching the previous message's lines, and
 * collapses everything from there (plus any immediately preceding boundary
 * line like "On <date>, X wrote:") to the end.
 */
export function splitQuotedHistory(
  currentText: string | null | undefined,
  previousText: string | null | undefined,
): QuoteSplit {
  const current = currentText ?? ""
  if (!current) return { visible: current, quoted: "" }

  const prevLines = (previousText ?? "")
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0)
  if (prevLines.length === 0) return { visible: current, quoted: "" }
  const prevJoined = prevLines.join(" ")
  if (prevJoined.length < MIN_QUOTE_LENGTH) return { visible: current, quoted: "" }
  const firstPrevLine = prevLines[0]

  const currentLines = current.split("\n")
  const currentNormalized = currentLines.map(normalizeLine)

  // Find a line in `current` that starts the quoted run: it matches the
  // previous message's first non-blank line, and what follows (joined) still
  // contains the rest of the previous message's content.
  let quoteStart = -1
  for (let i = 0; i < currentLines.length; i++) {
    if (currentNormalized[i] !== firstPrevLine) continue
    const rest = currentNormalized
      .slice(i)
      .filter((l) => l.length > 0)
      .join(" ")
    if (rest.includes(prevJoined)) {
      quoteStart = i
      break
    }
  }
  if (quoteStart < 0) return { visible: current, quoted: "" }

  // Absorb any immediately preceding boundary line(s) — "On ... wrote:", a
  // lone "--", or blank padding — into the collapsed region.
  let splitLine = quoteStart
  while (splitLine > 0 && isQuoteBoundaryLine(currentLines[splitLine - 1])) {
    splitLine--
  }

  const visible = currentLines.slice(0, splitLine).join("\n").replace(/\s+$/, "")
  const quoted = currentLines.slice(splitLine).join("\n").replace(/^\s+/, "")
  if (quoted.trim().length < MIN_QUOTE_LENGTH) return { visible: current, quoted: "" }
  return { visible, quoted }
}

export interface QuoteHtmlSplit {
  visibleHtml: string
  quotedHtml: string
}

// ── Boundary detection ──────────────────────────────────────────────────────
// Ticket bodies and non-sealed mail bodies are sanitized server-side before
// they reach the browser: class, id, type and style are stripped and <style>
// is dropped. So the TEXT of a boundary (an attribution line, a From/Sent
// header block, a divider) is the primary signal; class and id markers only
// help sealed mail, which the browser renders from the raw message.

// Quote-container class markers across mail clients (Freshdesk, Gmail, Yahoo,
// Proton, Zoho, Thunderbird...). Matched as a substring on the element's class.
const QUOTE_CONTAINER_RE =
  /(gmail_quote|freshdesk_quote|yahoo_quoted|zmail_extra|protonmail_quote|moz-cite-prefix|msg-quote|quoted_?text|elided-text)/i
// Attribution-line class markers ("On <date>, X wrote:" / "Le ... a écrit :").
const QUOTE_ATTR_CLASS_RE = /(gmail_attr|freshdesk_attr)/i
// Attribution-line TEXT, client- and language-tolerant (EN, FR, DE, ES, IT:
// the same languages as the server-side trim in strip-quoted.ts).
const QUOTE_ATTR_TEXT_RE =
  /^\s*(on\b.{0,240}\bwrote\s*:|le\b.{0,240}\ba\s+écrit\s*:|.{1,160}\ba\s+écrit\s*:|am\b.{0,240}\bschrieb\b.{0,200}:|el\b.{0,240}\bescribió\s*:|il\b.{0,240}\bha\s+scritto\s*:)\s*$/i
// Outlook's reply/forward markers: present in sealed (raw) mail only.
const MARKER_IDS = new Set(["divRplyFwdMsg", "appendonsend"])
const MARKER_CLASS_RE = /\bOutlookMessageHeader\b/
// Header-block labels. A block starts with a From label, names a Sent/Date
// label soon after it, and a To/Cc/Subject label on a line of its own: a
// contact-form notification ("From: Jane / Date: 4 Nov / Message: ...") has
// the first two but is the customer's own message, never a quote. Separators
// tolerate a (no-break) space before the colon ("De :") and the full-width
// colon of Chinese clients.
const FROM_LABEL = "(?:From|De|Von|Da|Van|发件人|寄件者)"
const SENT_LABEL =
  "(?:Send time|Sent|Date|Envoyé|Gesendet|Datum|Inviato|Verzonden|发送时间|日期|寄件日期|时间|Enviado el|Fecha|Enviado|Enviada|Data)"
const RECIPIENT_LABEL =
  "(?:To|Cc|Subject|À|Objet|An|Betreff|Para|Asunto|A|Oggetto|Aan|Onderwerp|Assunto|收件人|抄送|主题|收件者|副本|主旨)"
const LABEL_SEP = "[\\s\\u00a0\\u202f]*[:：]"
const FROM_WORD_RE = new RegExp(`^${FROM_LABEL}(?!\\p{L})`, "iu")
const FROM_START_RE = new RegExp(`^${FROM_LABEL}${LABEL_SEP}`, "i")
const SENT_IN_RE = new RegExp(`(?:^|\\s)${SENT_LABEL}${LABEL_SEP}`, "i")
const SENT_START_RE = new RegExp(`^${SENT_LABEL}${LABEL_SEP}`, "i")
const RECIPIENT_LINE_RE = new RegExp(
  `(?:^|\\n)[ \\t\\u00a0\\u202f]*${RECIPIENT_LABEL}${LABEL_SEP}`,
  "i",
)
// The From label must reach its Sent/Date label within this many characters:
// a header block is short, a reply that merely mentions "From:" is not.
const HEADER_MAX_SPAN = 600
// Divider lines that open a quoted email (Outlook, QQ/Foxmail, Gmail forwards).
const DIVIDER_RE =
  /^(?:-{2,}\s*(?:original message|original|message d'origine|ursprüngliche nachricht|forwarded message|message transféré)\s*-{2,}|_{10,})$/i
const LEADING_DIVIDER_RE = /^(?:-{2,}[^\n]{0,60}-{2,}|_{10,})[ \t]*\n/
const ZERO_WIDTH_RE = /[​-‍﻿]/g
const VISIBLE_CHAR_RE = /[^\s​-‍﻿]/
const WORD_CHAR_RE = /[\p{L}\p{N}]/u
// Elements whose text never renders.
const HIDDEN_TAGS = new Set(["STYLE", "SCRIPT", "TITLE", "HEAD", "TEMPLATE", "NOSCRIPT"])
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "TR",
  "TABLE",
  "BLOCKQUOTE",
  "PRE",
  "UL",
  "OL",
  "HR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
])

type BoundaryKind = "container" | "attribution" | "header" | "divider" | "marker"
interface Boundary {
  node: Node
  kind: BoundaryKind
}

function isHiddenEl(el: Element): boolean {
  if (HIDDEN_TAGS.has(el.tagName)) return true
  const style = el.getAttribute("style")
  return !!style && /display\s*:\s*none/i.test(style)
}

/**
 * The first `max` characters of an element's rendered text, with a newline at
 * every block edge and `<br>` (so "From: X" and "Date: Y" in sibling divs stay
 * on separate lines, unlike textContent). Stops reading past `max`, so the
 * per-element checks below never copy a whole quoted chain.
 */
function leadingText(root: Element, max: number): { text: string; over: boolean } {
  let out = ""
  let over = false
  const visit = (n: Node): void => {
    if (over) return
    if (n.nodeType === 3) {
      out += (n.nodeValue ?? "").replace(ZERO_WIDTH_RE, "")
      if (out.length > max) over = true
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    if (isHiddenEl(el)) return
    const block = BLOCK_TAGS.has(el.tagName)
    if (block || el.tagName === "BR") out += "\n"
    for (let c = el.firstChild; c && !over; c = c.nextSibling) visit(c)
    if (block) out += "\n"
  }
  visit(root)
  return { text: out, over }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function isQuoteContainerEl(el: Element): boolean {
  if (el.tagName === "BLOCKQUOTE") return true
  const cls = el.getAttribute("class") ?? ""
  return QUOTE_CONTAINER_RE.test(cls)
}

function isMarkerEl(el: Element): boolean {
  const id = el.getAttribute("id")
  if (id && MARKER_IDS.has(id)) return true
  return MARKER_CLASS_RE.test(el.getAttribute("class") ?? "")
}

function isAttributionText(text: string): boolean {
  const t = oneLine(text)
  return t.length > 0 && t.length < 260 && QUOTE_ATTR_TEXT_RE.test(t)
}

/** An element that introduces a quote ("On ... wrote:") — by class or by its own text. */
function isAttributionEl(el: Element): boolean {
  if (QUOTE_ATTR_CLASS_RE.test(el.getAttribute("class") ?? "")) return true
  // Only the element's OWN text being just the attribution counts, never a
  // big container that merely holds one.
  const { text, over } = leadingText(el, 300)
  return !over && isAttributionText(text)
}

function isDividerEl(el: Element): boolean {
  const { text, over } = leadingText(el, 120)
  return !over && DIVIDER_RE.test(oneLine(text))
}

/**
 * An Outlook-style header block: text that starts with a From label (after an
 * optional divider line), names a Sent/Date label within HEADER_MAX_SPAN
 * characters, and starts a line with a To/Cc/Subject label in that span.
 * Checked cheaply on the first characters before reading more.
 */
function isHeaderBlockEl(el: Element): boolean {
  const head = leadingText(el, 40).text.trimStart()
  if (!FROM_WORD_RE.test(head) && !/^[-_]{2}/.test(head)) return false
  const text = leadingText(el, HEADER_MAX_SPAN + 100)
    .text.replace(/^\s+/, "")
    .replace(LEADING_DIVIDER_RE, "")
    .replace(/^\s+/, "")
  const from = FROM_START_RE.exec(text)
  if (!from) return false
  const sentAt = text.slice(from[0].length).search(SENT_IN_RE)
  if (sentAt < 0 || from[0].length + sentAt > HEADER_MAX_SPAN) return false
  return RECIPIENT_LINE_RE.test(text.slice(0, HEADER_MAX_SPAN))
}

function classifyBoundary(el: Element): BoundaryKind | null {
  if (isMarkerEl(el)) return "marker"
  if (isQuoteContainerEl(el)) return "container"
  if (isAttributionEl(el)) return "attribution"
  if (isDividerEl(el)) return "divider"
  if (isHeaderBlockEl(el)) return "header"
  return null
}

/** Previous sibling, skipping whitespace-only text (and `<br>` when asked). */
function previousMeaningful(node: Node, skipBreaks: boolean): Node | null {
  let prev = node.previousSibling
  while (prev) {
    if (prev.nodeType === 3 && !VISIBLE_CHAR_RE.test(prev.nodeValue ?? "")) {
      prev = prev.previousSibling
    } else if (skipBreaks && prev.nodeType === 1 && (prev as Element).tagName === "BR") {
      prev = prev.previousSibling
    } else break
  }
  return prev
}

/** Widen an accepted boundary over what introduces it, so that collapses too. */
function withIntroduction(el: Element, kind: BoundaryKind): Boundary {
  if (kind === "container") {
    // The loose "On ... wrote:" some clients put OUTSIDE the blockquote, as an
    // element or as a bare text line before a <br>.
    const prev = previousMeaningful(el, true)
    if (prev?.nodeType === 1 && isAttributionEl(prev as Element))
      return { node: prev, kind: "attribution" }
    if (prev?.nodeType === 3 && isAttributionText(prev.nodeValue ?? ""))
      return { node: prev, kind: "attribution" }
    return { node: el, kind }
  }
  if (kind === "header" || kind === "divider" || kind === "marker") {
    // Outlook draws an <hr> right above its reply header.
    const prev = previousMeaningful(el, false)
    if (prev?.nodeType === 1 && (prev as Element).tagName === "HR") return { node: prev, kind }
  }
  return { node: el, kind }
}

/** Advance a TreeWalker past the current node's subtree. */
function skipSubtree(walker: TreeWalker): Node | null {
  for (;;) {
    const sibling = walker.nextSibling()
    if (sibling) return sibling
    if (!walker.parentNode()) return null
  }
}

/**
 * One document-order walk over elements and text that finds where the quoted
 * history begins. A candidate is accepted only once visible text has been seen
 * before it, so a reply is never folded away whole. A LEADING quote container
 * (Foxmail and Apple Mail sometimes wrap the reply itself in cite blockquotes)
 * is skipped with its whole subtree, and only when visible unquoted content
 * follows it before the next candidate; any other leading candidate (a header,
 * divider, attribution or marker) means the message opens with quoted history,
 * a forward with no comment, and nothing is split. Pre-order means the
 * OUTERMOST container wins (Freshdesk's wrapper, not the blockquote inside it).
 */
function findQuoteBoundary(root: HTMLElement, doc: Document): Boundary | null {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let seenVisible = false
  let skippedLeading = false
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === 3) {
      if (!seenVisible && VISIBLE_CHAR_RE.test(node.nodeValue ?? "")) seenVisible = true
      node = walker.nextNode()
      continue
    }
    const el = node as Element
    if (isHiddenEl(el)) {
      node = skipSubtree(walker)
      continue
    }
    const kind = classifyBoundary(el)
    if (kind) {
      if (seenVisible) return withIntroduction(el, kind)
      if (kind !== "container" || skippedLeading) return null
      skippedLeading = true
      node = skipSubtree(walker)
      continue
    }
    node = walker.nextNode()
  }
  return null
}

/**
 * The visible text pieces of the extracted tail that sit outside quote
 * containers, attribution lines, header blocks, dividers and markers (partial
 * clones of the boundary's ancestors included), one per text node.
 */
function collectUnquotedText(parent: Node, out: string[]): string[] {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) {
      const t = (c.nodeValue ?? "").replace(/\s+/g, " ").trim()
      // A bare "--" carries no word but marks where a signature starts.
      if ((WORD_CHAR_RE.test(t) && !isAttributionText(t)) || SIGNATURE_DELIMITER_RE.test(t))
        out.push(t)
      continue
    }
    if (c.nodeType !== 1) continue
    const el = c as Element
    if (isHiddenEl(el) || classifyBoundary(el) || isTicketReferenceBlock(el)) continue
    collectUnquotedText(el, out)
  }
  return out
}

// A ticket reference footer line ("Ticket reference: [#ticket-123]", in any
// language): mail clients keep it below the quote of the message it came with.
// Only the exact footer shape counts: a sentence that merely cites a
// reference ("Done, refunded under [#4521]") is a reply.
const TICKET_REFERENCE_LINE_RE = /^[^:：]{1,40}[:：]\s*\[#[\p{L}\p{N}_-]+\]$/u
// The sender line a reference footer is signed with ("Support team").
const MAX_REFERENCE_SENDER_LENGTH = 40
/** A block holding a ticket reference footer line and, besides it, at most a
 *  short sender line ("Support team" / "Ticket reference: [#ticket-123]"). */
function isTicketReferenceBlock(el: Element): boolean {
  const { text, over } = leadingText(el, 200)
  if (over) return false
  const lines = text
    .split("\n")
    .map(oneLine)
    .filter((l) => l.length > 0)
  const footer = lines.findIndex((l) => TICKET_REFERENCE_LINE_RE.test(l))
  if (footer < 0) return false
  const rest = lines.filter((_, i) => i !== footer).join(" ")
  return rest.length <= MAX_REFERENCE_SENDER_LENGTH
}
// The signature delimiter ("-- ", RFC 3676) a signature placed below the quote
// starts with.
const SIGNATURE_DELIMITER_RE = /^--(\s|$)/
// A signature is a few short lines (name, role, address, phone). More lines,
// or a longer one, after the delimiter is a reply or a PS, which stays visible.
const MAX_SIGNATURE_LINES = 6
const MAX_SIGNATURE_LINE_LENGTH = 80

/**
 * True when the tail holds text written between or after the quotes: an inline
 * or bottom-posted reply, which must stay visible. A signature below the quote
 * (starting at its "-- " delimiter, a few short lines) and a ticket reference
 * footer are not a reply: without this, every such email kept its whole
 * history unfolded.
 */
function hasUnquotedText(parent: Node): boolean {
  const pieces = collectUnquotedText(parent, []).filter((t) => !TICKET_REFERENCE_LINE_RE.test(t))
  if (pieces.length === 0) return false
  if (!SIGNATURE_DELIMITER_RE.test(pieces[0])) return true
  const signature = pieces.slice(1)
  return (
    signature.length > MAX_SIGNATURE_LINES ||
    [pieces[0].replace(/^--\s*/, ""), ...signature].some(
      (t) => t.length > MAX_SIGNATURE_LINE_LENGTH,
    )
  )
}

export interface SplitQuotedHtmlOptions {
  /** Return the visible part as a whole serialized document (head styles and
   *  `<body>` attributes kept) instead of the body's inner HTML: Mail's
   *  renderer reads body CSS and authored colours from them. */
  document?: boolean
}

/**
 * HTML analogue of `splitQuotedHistory`: splits an email body at the start of
 * its quoted history (via a DOM Range, so nested wrappers split cleanly) into
 * the always-visible reply and the collapsible quoted tail. Returns an empty
 * `quotedHtml` when there is no quote, when the quote is trivially short, when
 * the whole message is quote, or when unquoted text follows a quote (an inline
 * reply) -- in which case the caller renders the body unsplit.
 */
export function splitQuotedHtml(
  html: string | null | undefined,
  options: SplitQuotedHtmlOptions = {},
): QuoteHtmlSplit {
  const input = html ?? ""
  const unsplit = { visibleHtml: input, quotedHtml: "" }
  if (!input || typeof DOMParser === "undefined") return unsplit
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(input, "text/html")
  } catch {
    return unsplit
  }
  const body = doc.body
  if (!body?.firstChild || !body.lastChild) return unsplit
  const boundary = findQuoteBoundary(body, doc)
  if (!boundary) return unsplit
  try {
    const range = doc.createRange()
    range.setStartBefore(boundary.node)
    range.setEndAfter(body.lastChild)
    const holder = doc.createElement("div")
    holder.appendChild(range.extractContents())
    const bodyHtml = body.innerHTML
    const quotedHtml = holder.innerHTML
    // Only collapse a substantial quote, and never hide the whole message.
    if (htmlToText(quotedHtml, { singleLine: true }).length < 40) return unsplit
    if (htmlToText(bodyHtml, { singleLine: true }).length < 1) return unsplit
    // Outlook-style kinds are exempt: Outlook never wraps the quoted email, so
    // its body is plain sibling content after the header.
    if (
      (boundary.kind === "container" || boundary.kind === "attribution") &&
      hasUnquotedText(holder)
    )
      return unsplit
    const visibleHtml = options.document ? doc.documentElement.outerHTML : bodyHtml
    return { visibleHtml, quotedHtml }
  } catch {
    return unsplit
  }
}

// ── Quoted entries ──────────────────────────────────────────────────────────

/** One earlier email inside a quoted tail. */
export interface QuotedEntry {
  sender: string
  /** The raw date string as the mail client wrote it, at most 24 characters. */
  date: string
  /** First line of the body that is not a greeting or a header line. */
  firstLine: string
  text: string
}

const MAX_ENTRIES = 60
const MAX_DATE_LENGTH = 24
const GREETING_RE = /^(hi|hello|hey|dear|bonjour|salut|cher|chère)\b/i
// A greeting LINE is short ("Hello Mei,"); a long line that opens with one is
// the message itself.
const MAX_GREETING_LENGTH = 48
const HEADER_LINE_RE =
  /^(?:From|To|Cc|Bcc|Subject|Send time|Sent|Date|Reply-To|De|À|A|Objet|Envoyé|Von|An|Betreff|Gesendet|Datum|Da|Inviato|Oggetto|Van|Aan|Onderwerp|Verzonden|Para|Asunto|Enviado el|Enviado|Enviada|Fecha|Data|Assunto|发件人|收件人|抄送|主题|发送时间|日期|时间|寄件者|收件者|副本|主旨|寄件日期)[\s ]*[:：]/i
const ATTRIBUTION_PARSERS: Array<{ re: RegExp; date: number; sender: number | null }> = [
  { re: /^On\s+(.+?)\s*,?\s*wrote\s*:\s*$/i, date: 1, sender: null },
  { re: /^Le\s+(.+?)\s+a\s+écrit\s*:\s*$/i, date: 1, sender: null },
  { re: /^Am\s+(.+?)\s+schrieb\s+(.+?)\s*:\s*$/i, date: 1, sender: 2 },
  { re: /^El\s+(.+?)\s*,?\s*escribió\s*:\s*$/i, date: 1, sender: null },
  { re: /^Il\s+(.+?)\s+ha\s+scritto\s*:\s*$/i, date: 1, sender: null },
  { re: /^(.{1,160}?)\s+a\s+écrit\s*:\s*$/i, date: 1, sender: null },
]
const TIME_OF_DAY_RE = /\d{1,2}[:h]\d{2}(?::\d{2})?(?:\s*[AaPp]\.?\s?[Mm]\.?)?/g

function isGreetingLine(line: string): boolean {
  return line.length <= MAX_GREETING_LENGTH && GREETING_RE.test(line)
}

/** Sender from a From value or attribution name: the text before `<` or `[`,
 *  quotes stripped, else the address itself. */
function cleanSender(raw: string): string {
  const s = raw.trim()
  const bracket = s.search(/[<[]/)
  const name = (bracket >= 0 ? s.slice(0, bracket) : s).replace(/^["'“”‘’\s]+|["'“”‘’;,\s]+$/g, "")
  if (name) return name
  const address = /[<[](?:mailto:)?([^>\]]+)[>\]]/i.exec(s)
  return address ? address[1].trim() : s.replace(/[;,\s]+$/, "")
}

function truncateDate(date: string): string {
  const d = date.replace(/[,\s]+$/, "").trim()
  if (d.length <= MAX_DATE_LENGTH) return d
  const cut = d.slice(0, MAX_DATE_LENGTH)
  return cut.replace(/[\s,]+\S*$/, "") || cut
}

/** "Tue, Jul 21, 2026 at 4:05 AM Jo <jo@x>" → date before the last time of
 *  day (else the last comma), name after it. */
function splitDateAndSender(inner: string): { date: string; sender: string } {
  const bracket = inner.search(/[<[]/)
  const head = bracket >= 0 ? inner.slice(0, bracket) : inner
  const tail = bracket >= 0 ? inner.slice(bracket) : ""
  let cut = -1
  for (const m of head.matchAll(TIME_OF_DAY_RE)) cut = (m.index ?? 0) + m[0].length
  if (cut < 0) cut = head.lastIndexOf(",")
  const date = cut >= 0 ? head.slice(0, cut) : ""
  const name = (cut >= 0 ? head.slice(cut) : head).replace(/^[\s,]+/, "")
  return { date: truncateDate(date), sender: cleanSender(name + tail) }
}

interface EntryStart {
  /** First line of the entry's own header (attribution, divider or From line). */
  line: number
  /** First body line after that header. */
  body: number
  sender: string
  date: string
}

function parseAttribution(line: string): { date: string; sender: string } | null {
  for (const p of ATTRIBUTION_PARSERS) {
    const m = p.re.exec(line)
    if (!m) continue
    if (p.sender !== null)
      return { date: truncateDate(m[p.date]), sender: cleanSender(m[p.sender]) }
    return splitDateAndSender(m[p.date])
  }
  return null
}

function headerStartAt(lines: string[], i: number): EntryStart | null {
  const from = FROM_START_RE.exec(lines[i])
  if (!from) return null
  for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
    const sent = SENT_START_RE.exec(lines[j])
    if (!sent) continue
    // The header runs on over its other label lines (To, Cc, Subject...).
    let body = j + 1
    while (body < lines.length && body <= i + 10 && HEADER_LINE_RE.test(lines[body])) body++
    return {
      line: i,
      body,
      sender: cleanSender(lines[i].slice(from[0].length)),
      date: truncateDate(lines[j].slice(sent[0].length)),
    }
  }
  return null
}

function entryStartAt(lines: string[], i: number): EntryStart | null {
  const line = lines[i]
  if (!line) return null
  if (DIVIDER_RE.test(line)) {
    // A QQ/Outlook divider usually sits right above its From/Date block.
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (!lines[j]) continue
      const header = headerStartAt(lines, j)
      if (header) return { ...header, line: i }
      break
    }
    return { line: i, body: i + 1, sender: "", date: "" }
  }
  if (isAttributionText(line)) {
    const parsed = parseAttribution(line)
    if (parsed) return { line: i, body: i + 1, ...parsed }
  }
  // A long attribution wrapped over two lines ("On ..., X <x@y>" / "wrote:").
  if (/^(on|le|am|el|il)\s/i.test(line) && i + 1 < lines.length) {
    const joined = `${line} ${lines[i + 1]}`
    if (isAttributionText(joined)) {
      const parsed = parseAttribution(joined)
      if (parsed) return { line: i, body: i + 2, ...parsed }
    }
  }
  return headerStartAt(lines, i)
}

function entryFromLines(start: EntryStart | null, bodyLines: string[]): QuotedEntry {
  const text = bodyLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  const candidates = bodyLines.filter((l) => l.length > 0)
  const firstLine =
    candidates.find((l) => !isGreetingLine(l) && !HEADER_LINE_RE.test(l) && !DIVIDER_RE.test(l)) ??
    candidates[0] ??
    ""
  return { sender: start?.sender ?? "", date: start?.date ?? "", firstLine, text }
}

/**
 * Splits a quoted tail into the earlier emails it holds, at attribution lines
 * ("On ... wrote:", "Le ... a écrit :", ...), dividers and From/Sent header
 * blocks. A tail with none of these yields no entries (the caller shows the
 * raw tail). At most MAX_ENTRIES; the rest merge into the last one.
 */
export function parseQuotedEntries(quoted: string, mode: "html" | "text" = "html"): QuotedEntry[] {
  const raw = mode === "html" ? htmlToText(quoted) : quoted
  const lines = raw
    .replace(ZERO_WIDTH_RE, "")
    .split("\n")
    .map((l) =>
      stripQuoteMarker(l)
        .replace(/[\s  ]+/g, " ")
        .trim(),
    )

  const entries: QuotedEntry[] = []
  let current: EntryStart | null = null
  let bodyStart = 0
  const flush = (end: number): void => {
    const bodyLines = lines.slice(bodyStart, end)
    // Text before the first header is part of the chain too, sender unknown.
    if (current || bodyLines.some((l) => l.length > 0))
      entries.push(entryFromLines(current, bodyLines))
  }
  let i = 0
  while (i < lines.length) {
    const start = entryStartAt(lines, i)
    if (!start) {
      i++
      continue
    }
    flush(start.line)
    current = start
    bodyStart = start.body
    i = Math.max(start.body, i + 1)
  }
  if (!current) return []
  flush(lines.length)

  // A header with no body of its own (an attribution right above a header
  // block) belongs to the email that follows it.
  const merged: QuotedEntry[] = []
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]
    const next = entries[k + 1]
    if (!e.text && next) {
      next.sender = next.sender || e.sender
      next.date = next.date || e.date
      continue
    }
    merged.push(e)
  }
  if (merged.length <= MAX_ENTRIES) return merged
  const kept = merged.slice(0, MAX_ENTRIES - 1)
  const rest = merged.slice(MAX_ENTRIES - 1)
  kept.push({ ...rest[0], text: rest.map((e) => e.text).join("\n\n") })
  return kept
}

// ── Thread linking ──────────────────────────────────────────────────────────

// How much of an entry must appear in a thread message for the two to be the
// same email. A short prefix is not enough: canned replies open alike, so a
// quoted second answer would link to the first.
const LINK_KEY_LENGTH = 400
const MIN_LINK_KEY_LENGTH = 24

function normalizeForLink(s: string): string {
  return s
    .replace(/[\s  ]+/g, " ")
    .trim()
    .toLowerCase()
}

/** Up to LINK_KEY_LENGTH characters of an entry's text, its greeting and
 *  header lines dropped. */
function linkKey(entry: QuotedEntry): string | null {
  const lines = entry.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isGreetingLine(l) && !HEADER_LINE_RE.test(l))
  const key = normalizeForLink(lines.join(" ")).slice(0, LINK_KEY_LENGTH)
  return key.length >= MIN_LINK_KEY_LENGTH ? key : null
}

/**
 * For each quoted entry, the id of the thread message that already holds its
 * text (so the UI links to it instead of repeating it), else null. When
 * several messages hold it (a resent answer), the latest one wins. Entries too
 * short to tell apart ("Thanks!") never link.
 */
export function linkQuotedEntries(
  entries: QuotedEntry[],
  messages: { id: string; text: string }[],
): (string | null)[] {
  const haystacks = messages.map((m) => ({ id: m.id, text: normalizeForLink(m.text) }))
  return entries.map((entry) => {
    const key = linkKey(entry)
    if (!key) return null
    for (let i = haystacks.length - 1; i >= 0; i--) {
      if (haystacks[i].text.includes(key)) return haystacks[i].id
    }
    return null
  })
}

// ── Per-message cache ───────────────────────────────────────────────────────

/** FNV-1a: cheap enough to run over a whole body on every lookup. */
function hashBody(body: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface QuoteCache<T> {
  /** The cached value for `key`, recomputed when `body` changed. */
  get(key: string, body: string, compute: () => T): T
}

/**
 * A small LRU of per-message results (split + entries), keyed by message id
 * and validated by the body's length and hash. Conversation rows remount when
 * their list re-derives, so a component-level memo alone would re-split a
 * 160 KB quoted chain on every update.
 */
export function createQuoteCache<T>(limit = 300): QuoteCache<T> {
  const entries = new Map<string, { length: number; hash: number; value: T }>()
  return {
    get(key, body, compute) {
      const hash = hashBody(body)
      const hit = entries.get(key)
      entries.delete(key)
      if (hit && hit.length === body.length && hit.hash === hash) {
        entries.set(key, hit)
        return hit.value
      }
      const value = compute()
      entries.set(key, { length: body.length, hash, value })
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return value
    },
  }
}
