// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE EXCERPT A QUOTE CARRIES (S13, A1).
//
// The reader selects RENDERED text, while the server checks the excerpt
// against the message's STORED text: markdown, with mention tokens like
// `@[Alice](user:…)`. "a bold word" is not a substring of "a **bold** word",
// so a selection sent as is would be refused for most formatted messages.
//
// The stored text is projected onto the text a reader sees, each visible
// character remembering the stored span it came from; the selection is found
// in the projection and the excerpt is the stored span it covers. A marker
// that opens or closes the selected run is kept with it, so a quote of a bold
// word carries both of its `**`. What cannot be mapped is sent as selected and
// the server has the last word.

import { QUOTE_EXCERPT_MAX_CHARS } from "@liaison/shared"

interface ProjectedChar {
  ch: string
  /** The stored span this visible character stands for. */
  from: number
  to: number
}

const MENTION_TOKEN = /^[@#]\[((?:[^\]\\]|\\.)+)\]\(([^)]+)\)/
const LINK = /^!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
const LINE_MARKER = /^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/
const INLINE_MARKERS = ["**", "~~", "*", "`"]

function project(raw: string): ProjectedChar[] {
  const out: ProjectedChar[] = []
  let pending: number | null = null
  let i = 0
  const emit = (ch: string, from: number, to: number) => {
    if (/\s/.test(ch)) {
      pending = null
      const last = out[out.length - 1]
      if (last && last.ch === " ") {
        last.to = to
        return
      }
      out.push({ ch: " ", from, to })
      return
    }
    out.push({ ch, from: pending ?? from, to })
    pending = null
  }
  while (i < raw.length) {
    const atLineStart = i === 0 || raw[i - 1] === "\n"
    if (atLineStart) {
      const marker = LINE_MARKER.exec(raw.slice(i, i + 16))
      if (marker) {
        i += marker[0].length
        continue
      }
    }
    const rest = raw.slice(i, i + 600)
    const mention = MENTION_TOKEN.exec(rest)
    if (mention) {
      const end = i + mention[0].length
      const label = `${raw[i]}${mention[1].replace(/\\(.)/g, "$1")}`
      for (const ch of label) out.push({ ch, from: pending ?? i, to: end })
      pending = null
      i = end
      continue
    }
    const link = LINK.exec(rest)
    if (link) {
      const end = i + link[0].length
      const text = link[1]
      const textStart = i + (raw[i] === "!" ? 2 : 1)
      for (let k = 0; k < text.length; k++) {
        const from = k === 0 ? (pending ?? i) : textStart + k
        const to = k === text.length - 1 ? end : textStart + k + 1
        emit(text[k], from, to)
      }
      i = end
      continue
    }
    const marker = INLINE_MARKERS.find((m) => raw.startsWith(m, i))
    if (marker) {
      const end = i + marker.length
      // A marker closing the run before it travels with that run...
      const last = out[out.length - 1]
      if (last && last.ch !== " " && last.to === i) last.to = end
      // ...and one opening the next run travels with it.
      pending ??= i
      i = end
      continue
    }
    emit(raw[i], i, i + 1)
    i++
  }
  return out
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function capExcerpt(text: string): string {
  if (text.length <= QUOTE_EXCERPT_MAX_CHARS) return text
  return `${text.slice(0, QUOTE_EXCERPT_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * The excerpt to send for `selected`, a selection of the rendered `raw`
 * message: the stored span it covers, whitespace collapsed the way the server
 * collapses it, cut at 500 characters with an ellipsis.
 */
export function excerptForQuote(selected: string, raw: string): string {
  const wanted = normaliseWhitespace(selected)
  if (!wanted) return ""
  const chars = project(raw)
  const visible = chars.map((c) => c.ch).join("")
  const at = visible.indexOf(wanted)
  if (at < 0) return capExcerpt(wanted)
  const first = chars[at]
  const last = chars[at + wanted.length - 1]
  if (!first || !last) return capExcerpt(wanted)
  return capExcerpt(normaliseWhitespace(raw.slice(first.from, last.to)))
}

/**
 * The excerpt for a quote of the WHOLE message (the long-press action on a
 * touch screen, where there is no selection to start from): the stored text,
 * whitespace collapsed, cut the same way.
 */
export function excerptForWholeMessage(raw: string): string {
  return capExcerpt(normaliseWhitespace(raw))
}

/** An excerpt as a reader sees it: no markdown markers, mentions by name. */
export function plainQuoteText(excerpt: string): string {
  return normaliseWhitespace(
    project(excerpt)
      .map((c) => c.ch)
      .join(""),
  )
}
