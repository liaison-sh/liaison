// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Summary lines as a reviewer should read them.
 *
 * Approvals created before the server's default summarizer rendered params as
 * "key: value" lines stored the whole payload as ONE JSON line, and the feed
 * row and card print stored lines verbatim: a 77-day-old RGPD delete showed
 * `{"hub_id":"2222...","customer_id":"d100..."}` as its description. A line
 * that is a JSON object is expanded here the way the server's default
 * summarizer does today (`approval-summarizers.ts#defaultSummary`), one
 * "key: value" line per top-level field.
 *
 * Some summarizers also write instructions for the AGENT that proposed the
 * action, which reads the same summary back before it replies ("ROUTINE-SIZING
 * HONESTY — your reply MUST make clear ...:" and the bullets under it). Those
 * blocks are dropped: a reviewer must not read orders addressed to the agent
 * (walk 2026-10-12, a create-routine card ended on one). Any other line is kept
 * as written.
 *
 * A summarizer may quote outside text (an import's sample record) inside the
 * `<external-content source="untrusted">` fence, because the agent reads the
 * same lines and must take them as data. The lines keep that marking here;
 * `quotedParts` splits a line so a surface shows the quoted part as a quote,
 * set apart from the platform's own words, without the tags.
 */
const AGENT_DIRECTIVE = /—\s*your reply (?:MUST|should)\b/i
const FENCE_OPEN = /<\s*external-content(?:\s+source="[a-z]+")?\s*>/i
const FENCE_CLOSE = /<\s*\/\s*external-content\s*>/i
const ESCAPED_FENCE_TAG = /&lt;(\s*\/?\s*external-content)/gi

/** One part of a summary line: the platform's words, or text quoted from outside. */
export interface SummaryLinePart {
  text: string
  quoted: boolean
}

/**
 * A line split into the platform's words and the outside text it quotes. A
 * fence clipped before its closing tag quotes the rest of the line.
 */
export function quotedParts(line: string): SummaryLinePart[] {
  if (!FENCE_OPEN.test(line)) return [{ text: line, quoted: false }]
  const parts: SummaryLinePart[] = []
  let rest = line
  for (;;) {
    const open = FENCE_OPEN.exec(rest)
    if (!open) break
    const before = rest.slice(0, open.index)
    if (before.trim()) parts.push({ text: before.trimEnd(), quoted: false })
    rest = rest.slice(open.index + open[0].length)
    const close = FENCE_CLOSE.exec(rest)
    const inside = close ? rest.slice(0, close.index) : rest
    // The fence escapes any fence tag inside the quote (`&lt;/external-content`);
    // the reader sees the outside text as written.
    const quote = inside.trim().replace(ESCAPED_FENCE_TAG, "<$1")
    if (quote) parts.push({ text: quote, quoted: true })
    rest = close ? rest.slice(close.index + close[0].length) : ""
  }
  if (rest.trim()) parts.push({ text: rest.trim(), quoted: false })
  return parts
}

export function readableSummaryLines(lines: readonly string[]): string[] {
  const out: string[] = []
  let inAgentBlock = false
  for (const line of lines) {
    if (AGENT_DIRECTIVE.test(line)) {
      inAgentBlock = true
      continue
    }
    if (inAgentBlock && line.trimStart().startsWith("•")) continue
    inAgentBlock = false
    const expanded = expandJsonObjectLine(line)
    if (expanded) out.push(...expanded)
    else out.push(line)
  }
  return out
}

function expandJsonObjectLine(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return null
  const lines = entries.slice(0, 7).map(([key, value]) => `${key}: ${compact(value)}`.slice(0, 200))
  if (entries.length > 7) lines.push(`(and ${entries.length - 7} more fields)`)
  return lines
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return "(none)"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

/**
 * The subtitle the server writes when nothing better is known
 * (`approval-summarizers.ts#defaultSummary`, `createHandlerApprovalRequest`).
 * It is stored once, at creation, so it goes on saying "Pending approval" after
 * the request was approved: surfaces drop it once the row is no longer pending.
 */
export const GENERIC_PENDING_SUBTITLE = "Pending approval"

/**
 * A subtitle that speaks of the pending state: the generic one, or an app's
 * own that opens with it ("Pending approval, nothing is shipped or bought
 * yet"). Written at creation, it is wrong once the request is decided.
 */
export function isPendingSubtitle(subtitle: string | null | undefined): boolean {
  return (
    subtitle === GENERIC_PENDING_SUBTITLE ||
    (typeof subtitle === "string" && subtitle.startsWith(`${GENERIC_PENDING_SUBTITLE},`))
  )
}
