// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quoted-history stripper for email-derived message bodies.
//
// An email thread accumulates its own past: every reply carries the entire
// prior conversation below a reply marker ("On … wrote:", "Le … a écrit :",
// "> " pyramids). Stored bodies keep that tail verbatim, so reading a
// 39-message ticket returns the same conversation re-quoted dozens of times
// inside itself — the dominant token cost of agent ticket/mail reads, while
// carrying zero information the thread's own earlier messages don't already
// have. The UI merely collapses it visually; for agent reads we cut it.
//
// Design: find the EARLIEST reply-chain marker and cut there, replacing the
// tail with a one-line note so the model knows content was elided (and can
// re-fetch with the stripping disabled if it genuinely needs the chain).
// Deny-safe: when no marker matches, the body passes through untouched.
//
// Used by ticket reads (apps/tickets/search.ts) and mail reads
// (apps/mail/handlers.ts), each naming how its reader re-fetches the chain.

import { htmlToText } from "@liaison/shared"

/** Line-anchored reply-chain markers, ordered by prevalence. Each matches the
 *  HEADER of a quoted block, never body prose: attribution lines require the
 *  trailing colon (EN/FR/DE/ES/IT), divider lines require the full ruler. */
const QUOTE_MARKERS: RegExp[] = [
  // "On Mon, 21 Jul 2026 at 10:12, Support <x@y> wrote:" (line-wrapped variants
  // keep "wrote:" on the marker's own tail line, so match across one wrap).
  /^On .{4,300}? wrote:\s*$/ms,
  // FR: "Le 21 juil. 2026 à 10:12, Support <x@y> a écrit :"
  /^Le .{4,300}? a écrit\s?:\s*$/ms,
  // DE: "Am 21.07.2026 um 10:12 schrieb Support <x@y>:"
  /^Am .{4,300}? schrieb .{0,200}?:\s*$/ms,
  // ES / IT
  /^El .{4,300}? escribió:\s*$/ms,
  /^Il .{4,300}? ha scritto:\s*$/ms,
  // Outlook-style dividers.
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^-{2,}\s*Message d'origine\s*-{2,}\s*$/im,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  // Outlook top-quote header block: "From:"/"Von:"/"De :" immediately followed
  // (within two lines) by "Sent:"/"Date:"/"Gesendet:"/"Envoyé :".
  /^(?:From|Von|De)\s?: .+\r?\n(?:.*\r?\n)?(?:Sent|Date|Gesendet|Envoyé)\s?:/m,
  // Forwarded-message dividers.
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
]

/** A trailing run of ">"-prefixed lines (with at most sparse interleaved blank
 *  lines) is a quote pyramid even without an attribution line. Cut where the
 *  run starts if it holds at least three quoted lines. */
function findQuotePyramidStart(text: string): number {
  const lines = text.split("\n")
  let runStart = -1
  let quotedLines = 0
  let offset = 0
  const offsets: number[] = []
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const isQuoted = /^\s*>/.test(lines[i])
    const isBlank = lines[i].trim() === ""
    if (isQuoted) {
      if (runStart === -1) runStart = i
      quotedLines++
    } else if (!isBlank) {
      runStart = -1
      quotedLines = 0
    }
  }
  // Only a run that reaches the END of the body counts (mid-body quoting of a
  // single line the customer is answering inline stays).
  if (runStart !== -1 && quotedLines >= 3) return offsets[runStart]
  return -1
}

export interface StripQuotedResult {
  text: string
  /** Characters removed (0 when no marker matched). */
  trimmedChars: number
}

/**
 * Cut everything from the earliest quoted-history marker onward, appending a
 * one-line elision note. When the marker sits at the very top (the message IS
 * the quote, e.g. an empty forward), the original head is kept up to 400 chars
 * so the read is never empty.
 */
/** Substring both trim notes share — clients detect an elided body by it. */
export const QUOTE_TRIMMED_MARKER = "[quoted history trimmed:"

// HTML quote-container / attribution markers across mail clients: the first
// blockquote or class marker. Deliberately simpler than the web UI's
// splitQuotedHtml (apps/web/src/lib/email-quote.ts), which also skips a reply
// wrapped in leading cite blockquotes and cuts at Outlook From/Sent header
// blocks, so the two cuts can land in different places. The UI never relies on
// the server cut: a trimmed body is re-fetched whole before its quote shows.
const HTML_QUOTE_BOUNDARY_RE =
  /<blockquote\b|<[a-z][a-z0-9]*\b[^>]*class\s*=\s*["'][^"']*(?:gmail_quote|freshdesk_quote|yahoo_quoted|zmail_extra|protonmail_quote|moz-cite-prefix|msg-quote|quoted_?text|elided-text|gmail_attr|freshdesk_attr)[^"']*["']/i

export interface StripQuotedHtmlResult {
  html: string
  /** Characters removed (0 when no boundary matched / nothing worth trimming). */
  trimmedChars: number
}

/**
 * HTML analogue of `stripQuotedHistory`: cut the body at the first quote
 * boundary (blockquote / client quote-container / attribution class) and
 * replace the tail with a marker element carrying `QUOTE_TRIMMED_MARKER`, so a
 * client can detect the elision and re-fetch the single message untrimmed
 * (`messageId` + `stripQuoted:false`). String-level (no DOM in Bun): the cut
 * may leave unclosed tags, which innerHTML-style rendering tolerates.
 * Deny-safe: no boundary, trivial tail, or nothing visible left -> untouched.
 */
export function stripQuotedHtml(html: string): StripQuotedHtmlResult {
  if (!html) return { html, trimmedChars: 0 }
  const m = HTML_QUOTE_BOUNDARY_RE.exec(html)
  if (!m || m.index < 0) return { html, trimmedChars: 0 }
  const head = html.slice(0, m.index).replace(/\s+$/, "")
  const tail = html.slice(m.index)
  // Don't trim a trivial tail, and never hide the whole message.
  const textOf = (s: string): string => htmlToText(s, { singleLine: true })
  if (textOf(tail).length < 40) return { html, trimmedChars: 0 }
  if (textOf(head).length < 1) return { html, trimmedChars: 0 }
  const trimmedChars = html.length - head.length
  return {
    html: `${head}<div data-quote-trimmed="${trimmedChars}">${QUOTE_TRIMMED_MARKER} ${trimmedChars} chars]</div>`,
    trimmedChars,
  }
}

export function stripQuotedHistory(
  text: string,
  rereadHint = "re-read with stripQuoted:false if you need the full chain",
): StripQuotedResult {
  if (!text) return { text, trimmedChars: 0 }
  let cut = -1
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text)
    if (m && m.index >= 0 && (cut === -1 || m.index < cut)) cut = m.index
  }
  const pyramid = findQuotePyramidStart(text)
  if (pyramid !== -1 && (cut === -1 || pyramid < cut)) cut = pyramid
  if (cut === -1) return { text, trimmedChars: 0 }

  let head = text.slice(0, cut).replace(/\s+$/, "")
  if (head.length === 0) {
    // The whole body is quoted history — keep a bounded head of the original
    // instead of returning nothing.
    head = text.slice(0, 400).replace(/\s+$/, "")
  }
  const trimmedChars = text.length - head.length
  if (trimmedChars <= 0) return { text, trimmedChars: 0 }
  return {
    text: `${head}\n[quoted history trimmed: ${trimmedChars} chars — ${rereadHint}]`,
    trimmedChars,
  }
}
