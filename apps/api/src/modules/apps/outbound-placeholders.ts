// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unfilled placeholders in outbound text.
 *
 * A message an agent drafts for a person outside the org (an email, a ticket reply, a DM, a
 * document mail) must never carry a template slot such as "[DATE]", "{{name}}" or "TBD": an
 * approver skims the card, approves, and the customer reads "we will send it by [DATE]". A tool
 * declares which of its params carry such text (`outboundTextParams`), and executeToolCore
 * refuses the call before any gate stages an approval, with an error the model can act on.
 *
 * The detector is deliberately narrow. It skips quoted lines ("> ..."), blockquotes, code (fenced,
 * inline, <pre>/<code>), markdown links "[text](url)" and reference links, and footnote markers
 * ("[1]", "[^2]"); a bracket counts only when its content reads as a slot (an instruction like
 * "insert"/"your", a TBD marker, or a short label naming a field such as "Customer Name").
 */

/** Words that make a short bracketed label a field slot ("[Date]", "[Customer Name]"). */
const FIELD_WORDS = new Set([
  "date",
  "dates",
  "time",
  "day",
  "deadline",
  "name",
  "firstname",
  "lastname",
  "fullname",
  "company",
  "customer",
  "client",
  "recipient",
  "email",
  "phone",
  "address",
  "amount",
  "price",
  "link",
  "url",
  "signature",
  "contact",
  "value",
  "sender",
  "number",
  "month",
  "year",
  "week",
  "quantity",
  "eta",
])

/** Openers that make any bracketed or angled phrase an instruction to fill ("[Insert date]"). */
const FILL_OPENERS =
  /^(?:insert|enter|add|fill(?:\s+in)?|your|placeholder|specify|type|put|choose|replace(?:\s+with)?)\b/i

/** A bracket body that is only a to-be-decided marker. */
const MARKER_BODY = /^(?:tbd|tbc|todo|tba|x{2,}|\.{3}|…)$/i

/** HTML element names an ALL-CAPS angled word must not be confused with. */
const HTML_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "blockquote",
  "body",
  "br",
  "caption",
  "center",
  "code",
  "col",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "i",
  "img",
  "ins",
  "li",
  "link",
  "meta",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "style",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "u",
  "ul",
])

function isSlotLabel(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length === 0 || trimmed.length > 60) return false
  if (FILL_OPENERS.test(trimmed) || MARKER_BODY.test(trimmed)) return true
  // A short label naming a field: letters and separators only (no digits, no sentence
  // punctuation), at most five words, one of which names a field.
  if (!/^[\p{L}][\p{L}'’ _/-]*$/u.test(trimmed)) return false
  const words = trimmed
    .toLowerCase()
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/['’]s$/, ""))
  if (words.length > 5) return false
  return words.some((w) => FIELD_WORDS.has(w) || FIELD_WORDS.has(w.replace(/s$/, "")))
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&amp;/gi, "&")
}

/** Remove the spans that are never the author's own slot: quotes, code, links, footnotes. */
function stripExempt(text: string): string {
  return (
    text
      // fenced code blocks
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      // inline code
      .replace(/`[^`\n]*`/g, " ")
      // quoted lines ("> customer wrote ...")
      .replace(/^[ \t]*>.*$/gm, " ")
      // markdown links and images [text](url), reference links [text][ref], definitions [ref]: url
      .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ")
      .replace(/\[[^\]\n]*\]\[[^\]\n]*\]/g, " ")
      .replace(/^[ \t]*\[[^\]\n]+\]:.*$/gm, " ")
  )
}

/** HTML: drop quoted and code elements, then the tags, then decode entities. */
function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code\b[\s\S]*?<\/code>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<div\b[^>]*class="[^"]*\bgmail_quote\b[^"]*"[\s\S]*$/i, " ")
  return decodeEntities(withoutBlocks.replace(/<\/?[a-z][a-z0-9-]*\b[^<>]*>/gi, " "))
}

/** ALL-CAPS angled words that are not an HTML element ("<DATE>", "<CUSTOMER NAME>"). */
function angledCapsSlots(raw: string, out: Set<string>): void {
  for (const m of raw.matchAll(/<([A-Z][A-Z _]{1,40})>/g)) {
    const body = m[1] ?? ""
    if (HTML_ELEMENTS.has(body.toLowerCase())) continue
    if (body.replace(/[ _]/g, "").length < 2) continue
    out.add(m[0])
  }
}

/**
 * The distinct placeholders in `text`, in order of first appearance. `html` treats the text as
 * an HTML body (quoted and code elements are skipped, tags removed, entities decoded).
 */
export function findPlaceholders(text: string, opts: { html?: boolean } = {}): string[] {
  if (typeof text !== "string" || text.length === 0) return []
  const found = new Set<string>()
  if (opts.html) angledCapsSlots(text, found)
  const plain = stripExempt(opts.html ? htmlToText(text) : text)

  // {{merge field}} and {single_identifier}
  for (const m of plain.matchAll(/\{\{[^{}\n]{0,60}\}\}/g)) found.add(m[0])
  for (const m of plain.matchAll(/(?<!\{)\{\s*[A-Za-z_][A-Za-z0-9_.]{0,40}\s*\}(?!\})/g)) {
    found.add(m[0])
  }
  // [bracketed slot]; a footnote "[1]" / "[^1]" has no letters and never matches the label rule
  for (const m of plain.matchAll(/\[([^[\]\n]{1,60})\]/g)) {
    if (isSlotLabel(m[1] ?? "")) found.add(m[0])
  }
  // <angled slot>: an instruction ("<insert date>") or an ALL-CAPS label ("<DATE>")
  for (const m of plain.matchAll(/<([^<>\n]{1,60})>/g)) {
    const body = (m[1] ?? "").trim()
    if (FILL_OPENERS.test(body) || MARKER_BODY.test(body)) found.add(m[0])
  }
  if (!opts.html) angledCapsSlots(plain, found)
  // Date / amount masks: XX/XX, XX/XX/XXXX, __/__/____, $XX, XX €
  for (const m of plain.matchAll(
    /(?<![\p{L}\d])(?:X{2}|x{2}|_{2})(?:[/.-](?:X{2,4}|x{2,4}|_{2,4})){1,2}(?![\p{L}\d])/gu,
  )) {
    found.add(m[0])
  }
  for (const m of plain.matchAll(/[$€£]\s?X{2,}(?:[.,]X{2})?(?![\p{L}\d])/gu)) found.add(m[0])
  for (const m of plain.matchAll(
    /(?<![\p{L}\d])X{2,}(?:[.,]X{2})?\s?(?:€|EUR|USD|GBP)(?![\p{L}\d])/gu,
  )) {
    found.add(m[0])
  }
  // A bare to-be-decided marker, in capitals: "by TBD", "Date: TBC"
  for (const m of plain.matchAll(/(?<![\p{L}\d])(?:TBD|TBC|TBA)(?![\p{L}\d])/gu)) found.add(m[0])
  return [...found]
}

/** The placeholders in a tool call's declared outbound text params, keyed by param. */
export function findOutboundPlaceholders(
  params: unknown,
  outboundTextParams: readonly string[] | undefined,
): Array<{ param: string; placeholders: string[] }> {
  if (!outboundTextParams || outboundTextParams.length === 0) return []
  if (typeof params !== "object" || params === null || Array.isArray(params)) return []
  const p = params as Record<string, unknown>
  const hits: Array<{ param: string; placeholders: string[] }> = []
  for (const name of outboundTextParams) {
    const value = p[name]
    if (typeof value !== "string") continue
    const placeholders = findPlaceholders(value, { html: /html/i.test(name) })
    if (placeholders.length > 0) hits.push({ param: name, placeholders })
  }
  return hits
}

/** Today's date as the person reads it, e.g. "Monday, October 26, 2026". */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now)
  try {
    return `${fmt(timezone)} (${timezone})`
  } catch {
    return `${fmt("UTC")} (UTC)`
  }
}

/** The model-facing refusal for a draft with unfilled placeholders. */
export function outboundPlaceholderMessage(
  hits: Array<{ param: string; placeholders: string[] }>,
  today: string,
): string {
  const tokens = [...new Set(hits.flatMap((h) => h.placeholders))].slice(0, 5).join(", ")
  const params = hits.map((h) => h.param).join(", ")
  return (
    `Your draft contains a placeholder (${tokens}) in ${params}, and this message goes to a person, so nothing was sent or staged. ` +
    `Replace it with a concrete value: today is ${today}; propose a realistic date (the approver can edit it), ` +
    "use the real name or figure from the conversation, or say plainly in the message that you will confirm it. Then call the tool again."
  )
}
