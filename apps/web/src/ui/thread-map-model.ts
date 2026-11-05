// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The data side of the thread map (desktop strip, `ThreadMap`) and its phone
// form (`ThreadMapDrawer`): what one entry is, how its one-line title is cut
// out of a message body, how the current entry is found from a scroll offset,
// and how a jump lands a message's top in view. Pure, and free of any domain
// module, so both surfaces (Mail, Tickets) feed it their own message lists.

/** One message (or event) of a conversation, as the map shows it. */
export interface ThreadMapItem {
  /** Matches the `data-thread-map-id` attribute on the message's root element. */
  id: string
  /** `in`: received; `out`: sent; `note`: internal note; `event`: a 1px tick. */
  kind: "in" | "out" | "note" | "event"
  who: string
  dateLabel: string
  line: string
}

/** An item with where its element sits in the scroller's content, in px. */
export interface MeasuredThreadItem {
  item: ThreadMapItem
  top: number
  height: number
}

/** The attribute every message root carries so the map can find it. */
export const THREAD_MAP_ID_ATTR = "data-thread-map-id"

const GREETING = /^(hi|hello|hey|dear|bonjour|salut|cher|chère)\b/i
const LINE_MAX = 90

/**
 * The body's first line worth a title: the first non-empty line that is not a
 * greeting ("Hi Lina,") and not a quoted `>` line, cut to 90 characters. A
 * body that is nothing but a greeting keeps the greeting rather than nothing.
 */
export function threadMapFirstLine(text: string | null | undefined): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && !l.startsWith(">"))
  const line = lines.find((l) => !GREETING.test(l)) ?? lines[0] ?? ""
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1).trimEnd()}…` : line
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
}

/**
 * A cheap HTML → text for titles only: block ends become line breaks so the
 * first-line rule above sees the reply's lines, everything else is dropped.
 * No DOM parse: it runs once per message per change, for a 90 character label.
 */
export function threadMapPlainText(html: string | null | undefined): string {
  const lined = stripRawBlocks(html ?? "").replace(
    /<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/gi,
    "\n",
  )
  return stripTags(lined).replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
}

const RAW_BLOCK_OPEN = /<(style|script|head|title)\b/gi
const RAW_BLOCK_CLOSE: Record<string, RegExp> = {
  style: /<\/style>/gi,
  script: /<\/script>/gi,
  head: /<\/head>/gi,
  title: /<\/title>/gi,
}

/** `html` without its style, script, head and title blocks. Mail bodies are outside
 *  text of any shape, so the cost must stay linear: each kind's next closing tag is
 *  remembered, and the search for it only ever moves forward. */
function stripRawBlocks(html: string): string {
  const nextClose = new Map<string, { start: number; end: number } | null>()
  let out = ""
  let copied = 0
  for (const open of html.matchAll(RAW_BLOCK_OPEN)) {
    if (open.index < copied) continue
    const name = open[1].toLowerCase()
    const from = open.index + open[0].length
    let close = nextClose.get(name)
    if (close === undefined || (close !== null && close.start < from)) {
      const closeRe = RAW_BLOCK_CLOSE[name]
      closeRe.lastIndex = from
      const found = closeRe.exec(html)
      close = found ? { start: found.index, end: found.index + found[0].length } : null
      nextClose.set(name, close)
    }
    if (close === null) continue
    out += html.slice(copied, open.index)
    copied = close.end
  }
  return out + html.slice(copied)
}

/** `text` without its tags: each `<` through the next `>`. With no `>` left, nothing
 *  after that point can be a tag, so the scan ends there and stays linear. */
function stripTags(text: string): string {
  let out = ""
  let at = 0
  while (true) {
    const open = text.indexOf("<", at)
    if (open === -1) break
    const close = text.indexOf(">", open + 1)
    if (close === -1) break
    out += text.slice(at, open)
    at = close + 1
  }
  return out + text.slice(at)
}

/**
 * Index of the entry the reader is on: the last one whose top is at or above
 * `probe` (a point 30% down the viewport), stepping back off an event so the
 * counter always names a message. Binary search: this runs on every scroll
 * frame and must not grow with the thread.
 */
export function currentThreadItemIndex(items: MeasuredThreadItem[], probe: number): number {
  let lo = 0
  let hi = items.length - 1
  let idx = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid]!.top <= probe) {
      idx = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  while (idx > 0 && items[idx]!.item.kind === "event") idx--
  return idx
}

/** The element of an item inside the content, or null when it is not rendered. */
export function threadItemElement(content: ParentNode, id: string): HTMLElement | null {
  return content.querySelector<HTMLElement>(`[${THREAD_MAP_ID_ATTR}="${CSS.escape(id)}"]`)
}

/** Where an element's top sits in the scroller's content, in px. */
export function offsetInScroller(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Scrolls the message's TOP into view (a few px of air above it), smoothly
 * unless the reader asked for reduced motion. Measured at click time: the
 * positions the map drew from may be a resize old.
 */
export function scrollToThreadItem(scroller: HTMLElement, content: ParentNode, id: string): void {
  const el = threadItemElement(content, id)
  if (!el) return
  const top = Math.max(0, offsetInScroller(scroller, el) - 8)
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" })
  } else {
    scroller.scrollTop = top
  }
}
