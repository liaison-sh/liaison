// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Slack → Liaison markdown conversion (pure, no I/O). Used by the `slack
 * import` CLI (Task: Slack-export importer). Two paths:
 *
 *  - `blocksToMarkdown` — modern messages carry `blocks` (rich_text tree).
 *    Preferred when present: walks rich_text_section / preformatted / quote /
 *    list, translating each inline element (text w/ style, link, user,
 *    channel, emoji, broadcast) to markdown.
 *  - `legacyTextToMarkdown` — fallback for older exports with only a `text`
 *    field carrying Slack's own inline markup (`<@U…>`, `<url|label>`,
 *    `*bold*`, HTML entities).
 *
 * Both need a user-id → display-name resolver (export `users.json`), passed
 * in by the caller rather than looked up here, so this module stays pure and
 * independently testable.
 */
import { z } from "zod"

export type SlackUserResolver = (userId: string) => string

/**
 * Optional live references. With them, a Slack user mention becomes a Liaison
 * mention token (`@[Name](user:<uuid>)`, what the composer writes and
 * `parseMentions` reads) and a channel link becomes a link to the imported
 * channel thread (`@[name](thread:<uuid>)`). Either returning null, or being
 * absent, falls back to the plain `@Name` / `#name` text.
 */
export interface SlackRefs {
  userMention?: (userId: string) => string | null
  channelLink?: (channelId: string, name: string | undefined) => string | null
}

function userRef(id: string, resolveUser: SlackUserResolver, refs?: SlackRefs): string {
  return refs?.userMention?.(id) ?? `@${resolveUser(id)}`
}

function channelRef(id: string, name: string | undefined, refs?: SlackRefs): string {
  return refs?.channelLink?.(id, name) ?? `#${name ?? id}`
}

// ─────────────────────────────────────────────────────────────────────────
// rich_text `blocks` walk
// ─────────────────────────────────────────────────────────────────────────

const richTextStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
})
type RichTextStyle = z.infer<typeof richTextStyleSchema>

// `elements` is recursive (rich_text_list items are themselves sections of
// elements) — declared with an explicit type + z.lazy to satisfy TS.
type RichTextElement = {
  type: string
  text?: string
  style?: RichTextStyle
  url?: string
  user_id?: string
  channel_id?: string
  name?: string
  unicode?: string
  elements?: RichTextElement[]
  indent?: number
  border?: number
}

const richTextElementSchema: z.ZodType<RichTextElement> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    style: richTextStyleSchema.optional(),
    url: z.string().optional(),
    user_id: z.string().optional(),
    channel_id: z.string().optional(),
    name: z.string().optional(),
    unicode: z.string().optional(),
    elements: z.array(richTextElementSchema).optional(),
    indent: z.number().optional(),
    border: z.number().optional(),
  }),
)

export const richTextBlockSchema = z.object({
  type: z.string(),
  block_id: z.string().optional(),
  elements: z.array(richTextElementSchema).optional(),
  style: z.string().optional(), // "ordered" | "bullet" (rich_text_list)
})
export type RichTextBlock = z.infer<typeof richTextBlockSchema>

/** A top-level Slack `blocks[]` entry — `{ type: "rich_text", elements: [...] }`
 *  for text messages; other block types (e.g. "call") are skipped. */
export const slackTopBlockSchema = z.object({
  type: z.string(),
  elements: z.array(richTextBlockSchema).optional(),
})

function styleText(text: string, style: RichTextStyle | undefined): string {
  if (!style) return text
  let out = text
  if (style.code) return `\`${out}\``
  if (style.bold) out = `**${out}**`
  if (style.italic) out = `_${out}_`
  if (style.strike) out = `~~${out}~~`
  return out
}

/** Render one inline element (inside a rich_text_section / list item / quote). */
function renderInlineElement(
  el: RichTextElement,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  switch (el.type) {
    case "text":
      return styleText(el.text ?? "", el.style)
    case "link": {
      const label = el.text?.trim() || el.url || ""
      if (!el.url) return label
      return label && label !== el.url ? `[${label}](${el.url})` : el.url
    }
    case "user":
      return el.user_id ? userRef(el.user_id, resolveUser, refs) : "@unknown"
    case "channel":
      return el.channel_id ? channelRef(el.channel_id, el.name, refs) : ""
    case "emoji":
      return el.unicode ? unicodeFromCodepoints(el.unicode) : `:${el.name ?? ""}:`
    case "broadcast":
      return el.name === "here" ? "@here" : "@channel"
    case "usergroup":
      return el.name ? `@${el.name}` : "@usergroup"
    default:
      return el.text ?? ""
  }
}

function unicodeFromCodepoints(unicode: string): string {
  try {
    return unicode
      .split("-")
      .map((cp) => String.fromCodePoint(Number.parseInt(cp, 16)))
      .join("")
  } catch {
    return unicode
  }
}

/** Render a rich_text_section's inline elements to one markdown line. */
function renderSection(
  elements: RichTextElement[],
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  return elements.map((el) => renderInlineElement(el, resolveUser, refs)).join("")
}

/** Render a single top-level rich_text block to zero or more markdown lines. */
function renderBlock(
  block: RichTextBlock,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string[] {
  const elements = block.elements ?? []
  switch (block.type) {
    case "rich_text_section":
      return [renderSection(elements, resolveUser, refs)]
    case "rich_text_preformatted": {
      const code = elements
        .map((el) =>
          el.type === "text" ? (el.text ?? "") : renderInlineElement(el, resolveUser, refs),
        )
        .join("")
      return ["```", code, "```"]
    }
    case "rich_text_quote":
      return [`> ${renderSection(elements, resolveUser, refs)}`]
    case "rich_text_list": {
      const ordered = block.style === "ordered"
      // Each element of a rich_text_list is itself a rich_text_section
      // representing one list item.
      return elements.map((item, i) => {
        const marker = ordered ? `${i + 1}.` : "-"
        const content =
          item.type === "rich_text_section" && item.elements
            ? renderSection(item.elements, resolveUser, refs)
            : renderInlineElement(item, resolveUser, refs)
        return `${marker} ${content}`
      })
    }
    default:
      return []
  }
}

/**
 * Convert a Slack message's `blocks` (rich_text tree) to Liaison markdown.
 * Accepts loosely-typed input (as decoded from JSON) and validates it against
 * the rich_text schema internally — unparseable top-level blocks are skipped
 * rather than throwing, since Slack exports carry other block kinds ("call",
 * etc.) that have no plain-text representation to reconstruct.
 */
export function blocksToMarkdown(
  blocks: ReadonlyArray<Record<string, unknown>> | undefined | null,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  if (!blocks || blocks.length === 0) return ""
  const lines: string[] = []
  for (const raw of blocks) {
    const parsed = slackTopBlockSchema.safeParse(raw)
    if (!parsed.success || parsed.data.type !== "rich_text") continue
    for (const child of parsed.data.elements ?? []) {
      lines.push(...renderBlock(child, resolveUser, refs))
    }
  }
  return lines.join("\n").trimEnd()
}

// ─────────────────────────────────────────────────────────────────────────
// legacy `text` field fallback
// ─────────────────────────────────────────────────────────────────────────

/** Unescape Slack's HTML-entity-encoded text field. */
function unescapeSlackEntities(text: string): string {
  // One pass: `&amp;lt;` is the text `&lt;` someone typed, not a `<`.
  return text.replace(/&(amp|lt|gt);/g, (_m, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : ">",
  )
}

/**
 * Convert legacy Slack `text` markup to Liaison markdown:
 *  - `<@UXXXX>` / `<@UXXXX|label>` → `@Name`
 *  - `<#CXXXX|name>` → `#name`
 *  - `<!here>` / `<!channel>` → `@here` / `@channel`
 *  - `<url|label>` → `[label](url)`, `<url>` → `url`
 *  - HTML entity unescape
 *  - `*bold*` → `**bold**` (single-asterisk Slack bold, not already double)
 */
export function legacyTextToMarkdown(
  text: string,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  // Token substitution runs FIRST, on the still-entity-escaped text: Slack
  // encodes literal `<`/`>` characters as `&lt;`/`&gt;`, so only its own
  // `<...>` markup tokens appear as literal angle brackets at this point.
  // Unescaping first would turn `&lt;3 &gt;9000` into `<3 >9000`, which the
  // token regex would then misparse as a markup token.
  let out = text

  // Slack markup tokens: <@U…>, <@U…|label>, <#C…|name>, <!here>, <!channel>,
  // <!everyone>, <url|label>, <url>.
  out = out.replace(/<([^>]+)>/g, (_match, inner: string) => {
    if (inner.startsWith("@")) {
      const [id, label] = inner.slice(1).split("|")
      const live = id ? refs?.userMention?.(id) : null
      if (live) return live
      if (label) return `@${label}`
      return `@${resolveUser(id ?? "")}`
    }
    if (inner.startsWith("#")) {
      const [id, name] = inner.slice(1).split("|")
      return channelRef(id ?? "", name || undefined, refs)
    }
    if (inner.startsWith("!")) {
      const kw = inner.slice(1).split("|")[0]
      if (kw === "here") return "@here"
      if (kw === "channel") return "@channel"
      if (kw === "everyone") return "@everyone"
      return inner
    }
    // URL, optionally with a pipe-delimited label.
    const pipeIdx = inner.indexOf("|")
    if (pipeIdx === -1) return inner
    const url = inner.slice(0, pipeIdx)
    const label = inner.slice(pipeIdx + 1)
    return `[${label}](${url})`
  })

  // Slack single-asterisk bold → markdown double-asterisk. Only convert
  // pairs that look like *word* / *phrase* (not already part of `**…**`),
  // and skip a lone asterisk used as multiplication/emphasis-free text.
  out = out.replace(
    /(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    (_m, pre: string, inner: string) => `${pre}**${inner}**`,
  )

  return unescapeSlackEntities(out)
}

// ─────────────────────────────────────────────────────────────────────────
// Block Kit (bot/app messages) and legacy attachments
// ─────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null
}

/** A Block Kit text object (`{ type: "mrkdwn" | "plain_text", text }`) to markdown. */
function textObject(v: unknown, resolveUser: SlackUserResolver, refs?: SlackRefs): string | null {
  const o = asRecord(v)
  const text = asText(o?.text)
  if (!text) return null
  return o?.type === "mrkdwn" ? legacyTextToMarkdown(text, resolveUser, refs) : text
}

/**
 * Render the Block Kit blocks an app or bot posts (section, header, context,
 * image, divider) to markdown. `rich_text` blocks are left to
 * `blocksToMarkdown`; interactive blocks (actions, inputs) carry no content.
 */
export function blockKitToMarkdown(
  blocks: ReadonlyArray<Record<string, unknown>> | undefined | null,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  if (!blocks || blocks.length === 0) return ""
  const lines: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case "header": {
        const t = textObject(b.text, resolveUser, refs)
        if (t) lines.push(`**${t.trim()}**`)
        break
      }
      case "section": {
        const t = textObject(b.text, resolveUser, refs)
        if (t) lines.push(t)
        const fields = Array.isArray(b.fields) ? b.fields : []
        for (const f of fields) {
          const ft = textObject(f, resolveUser, refs)
          if (ft) lines.push(ft)
        }
        break
      }
      case "context": {
        const parts = (Array.isArray(b.elements) ? b.elements : [])
          .map((el) => textObject(el, resolveUser, refs))
          .filter((x): x is string => !!x)
        if (parts.length) lines.push(`_${parts.join(" · ")}_`)
        break
      }
      case "image": {
        const url = asText(b.image_url)
        if (url) lines.push(`[${asText(b.alt_text) ?? "image"}](${url})`)
        break
      }
      case "divider":
        lines.push("---")
        break
      case "rich_text": {
        const t = blocksToMarkdown([b], resolveUser, refs)
        if (t) lines.push(t)
        break
      }
      default:
        break
    }
  }
  return lines.join("\n").trim()
}

/**
 * Render a message's legacy `attachments` (integration posts: Jira, Rollbar,
 * alerting webhooks; shared messages) to markdown. A plain link preview
 * (an unfurl of a URL already in the text) is dropped: the text keeps the
 * link. A shared or unfurled Slack message renders as a quote.
 */
export function attachmentsToMarkdown(
  attachments: ReadonlyArray<Record<string, unknown>> | undefined | null,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  if (!attachments || attachments.length === 0) return ""
  const out: string[] = []
  for (const a of attachments) {
    const isMessageShare = a.is_share === true || a.is_msg_unfurl === true
    const isLinkPreview = !isMessageShare && (!!a.original_url || a.is_app_unfurl === true)
    if (isLinkPreview) continue
    const lines: string[] = []
    const mrk = (v: unknown) => {
      const t = asText(v)
      return t ? legacyTextToMarkdown(t, resolveUser, refs) : null
    }
    const pretext = mrk(a.pretext)
    if (pretext) lines.push(pretext)
    const author = asText(a.author_name)
    if (author && isMessageShare) lines.push(`**${author}**`)
    else if (author) lines.push(`_${author}_`)
    const title = mrk(a.title)
    const titleLink = asText(a.title_link)
    if (title) lines.push(titleLink ? `**[${title}](${titleLink})**` : `**${title}**`)
    const text = mrk(a.text)
    if (text) lines.push(text)
    const fields = Array.isArray(a.fields) ? a.fields : []
    for (const f of fields) {
      const fr = asRecord(f)
      const ft = mrk(fr?.title)
      const fv = mrk(fr?.value)
      if (ft && fv) lines.push(`**${ft}**: ${fv}`)
      else if (fv) lines.push(fv)
      else if (ft) lines.push(`**${ft}**`)
    }
    const blocks = Array.isArray(a.blocks) ? (a.blocks as Record<string, unknown>[]) : []
    const bk = blockKitToMarkdown(blocks, resolveUser, refs)
    if (bk) lines.push(bk)
    const image = asText(a.image_url)
    if (image) lines.push(`[image](${image})`)
    if (lines.length === 0) {
      const fallback = mrk(a.fallback)
      if (fallback) lines.push(fallback)
    }
    if (lines.length === 0) continue
    const body = lines.join("\n")
    out.push(
      isMessageShare
        ? body
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")
        : body,
    )
  }
  return out.join("\n\n")
}

/** The fields of a Slack message `messageToMarkdown` reads. */
export interface SlackRenderableMessage {
  text?: string
  blocks?: ReadonlyArray<Record<string, unknown>>
  attachments?: ReadonlyArray<Record<string, unknown>>
}

/**
 * A Slack message's full content as Liaison markdown: its rich text (or, for
 * an app post, its Block Kit sections, or else its `text`), followed by its
 * attachments. The `text` field of an app post is the notification fallback
 * of its blocks, so it is used only when the blocks render nothing.
 */
export function messageToMarkdown(
  m: SlackRenderableMessage,
  resolveUser: SlackUserResolver,
  refs?: SlackRefs,
): string {
  const parts: string[] = []
  const rich = blocksToMarkdown(m.blocks, resolveUser, refs)
  const body =
    rich ||
    blockKitToMarkdown(
      (m.blocks ?? []).filter((b) => b.type !== "rich_text"),
      resolveUser,
      refs,
    ) ||
    legacyTextToMarkdown(m.text ?? "", resolveUser, refs)
  if (body.trim()) parts.push(body)
  const att = attachmentsToMarkdown(m.attachments, resolveUser, refs)
  if (att) parts.push(att)
  return parts.join("\n\n")
}

// ─────────────────────────────────────────────────────────────────────────
// reply quote-prefix
// ─────────────────────────────────────────────────────────────────────────

/** First ~80 chars of the parent message's content, collapsed to one line. */
export function truncateSingleLine(content: string, maxLen = 80): string {
  const singleLine = content.replace(/\s+/g, " ").trim()
  if (singleLine.length <= maxLen) return singleLine
  return `${singleLine.slice(0, maxLen)}…`
}

/**
 * Build the `> ↳ reply to <Name>: "…"` quote-prefix line + blank line that
 * precedes a thread reply's own content.
 */
export function buildReplyQuotePrefix(parentAuthorName: string, parentContent: string): string {
  const snippet = truncateSingleLine(parentContent)
  return `> ↳ reply to ${parentAuthorName}: "${snippet}"\n\n`
}
