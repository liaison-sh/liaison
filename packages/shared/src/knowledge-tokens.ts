// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The two Knowledge tokens a page body stores, holding an id and nothing else:
 *
 * - a file or image: `![](liaison-file:<uuid>)` (the file's type decides how it is drawn);
 * - a page link: `[](knowledge:document:<uuid>)` (the title is resolved for each reader,
 *   so a reader who cannot open the page never receives it).
 *
 * Pure functions shared by the server and the web app. Code spans and fenced code
 * blocks are never read or rewritten, and a token already in canonical form is kept
 * byte for byte, so normalising twice changes nothing.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

/** A file or image token in canonical form; group 1 is the file id. */
export const FILE_TOKEN_RE = new RegExp(`!\\[\\]\\(liaison-file:(${UUID})\\)`, "g")
/** A page link token in canonical form (never an image); group 1 is the page id. */
export const PAGE_TOKEN_RE = new RegExp(`(?<!!)\\[\\]\\(knowledge:document:(${UUID})\\)`, "g")

/** Any file reference, alt text or not (one level of brackets in the alt text). */
const FILE_REF_RE = new RegExp(
  `!\\[(?:\\\\.|[^\\[\\]\\\\]|\\[(?:\\\\.|[^\\[\\]\\\\])*\\])*\\]\\(liaison-file:(${UUID})\\)`,
  "g",
)

export function fileToken(id: string): string {
  return `![](liaison-file:${id})`
}

export function pageToken(id: string): string {
  return `[](knowledge:document:${id})`
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN_RE = /(`+)(?:[\s\S]*?[^`])?\1(?!`)/g

/**
 * Apply `fn` to every prose block (the text between fenced blocks, code spans
 * included), and return the text with those blocks replaced. Line endings are kept.
 */
function mapProseBlocks(md: string, fn: (block: string) => string): string {
  const lines = md.split(/(?<=\n)/)
  let out = ""
  let prose = ""
  let fence: { char: string; len: number } | null = null
  const flushProse = () => {
    if (!prose) return
    out += fn(prose)
    prose = ""
  }
  for (const line of lines) {
    const open = FENCE_RE.exec(line)
    if (fence) {
      out += line
      const close = open?.[1]
      if (close && close[0] === fence.char && close.length >= fence.len) {
        const rest = line.replace(FENCE_RE, "").trim()
        if (rest === "") fence = null
      }
      continue
    }
    if (open?.[1]) {
      flushProse()
      fence = { char: open[1][0] ?? "`", len: open[1].length }
      out += line
      continue
    }
    prose += line
  }
  flushProse()
  return out
}

/**
 * Apply `fn` to every stretch of text outside fenced blocks and code spans, and
 * return the text with those stretches replaced. Line endings are kept as they are.
 */
function mapOutsideCode(md: string, fn: (text: string) => string): string {
  return mapProseBlocks(md, (prose) => {
    let last = 0
    let mapped = ""
    for (const m of prose.matchAll(CODE_SPAN_RE)) {
      const at = m.index ?? 0
      mapped += fn(prose.slice(last, at)) + m[0]
      last = at + m[0].length
    }
    return mapped + fn(prose.slice(last))
  })
}

function collectOutsideCode(md: string, re: RegExp): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  mapOutsideCode(md, (text) => {
    for (const m of text.matchAll(re)) {
      const id = m[1]
      if (id && !seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase())
        out.push(id)
      }
    }
    return text
  })
  return out
}

// ---------------------------------------------------------------------------
// Page references, in every Markdown form a writer or a model can produce
// ---------------------------------------------------------------------------

const ID_GROUP = `(${UUID})`
const TARGET = `<?knowledge:document:${ID_GROUP}>?`
const LINK_TITLE = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\((?:\\\\.|[^()\\\\])*\\))`
/** The end of an inline link to a page: `](target "title")`; the label is found backwards. */
const INLINE_END_RE = new RegExp(`\\]\\(\\s*${TARGET}(?:\\s+${LINK_TITLE})?\\s*\\)`, "gi")
/** `<knowledge:document:id>` */
const AUTOLINK_RE = new RegExp(`<knowledge:document:${ID_GROUP}>`, "gi")
/** `<a href="knowledge:document:id" …>label</a>` */
const ANCHOR_RE = new RegExp(
  `<a\\b[^>]*?\\bhref\\s*=\\s*["']?knowledge:document:${ID_GROUP}["']?[^>]*>[\\s\\S]*?</a\\s*>`,
  "gi",
)
/** A reference definition naming a page: `[label]: knowledge:document:id "title"`. */
const DEFINITION_RE = new RegExp(
  `^ {0,3}\\[((?:\\\\.|[^\\[\\]\\\\])+)\\]:[ \\t]*(?:\\r?\\n[ \\t]*)?${TARGET}(?:[ \\t]+${LINK_TITLE})?[ \\t]*(?:\\r?\\n|$)`,
  "gim",
)
/** The end of a full or collapsed reference link: `][label]` or `][]`. */
const REFERENCE_END_RE = /\]\[((?:\\.|[^[\]\\])*)\]/g
/** A shortcut reference: `[label]` not followed by a target or another label. */
const SHORTCUT_RE = /\[((?:\\.|[^[\]\\])+)\](?![([:])/g

function refLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase()
}

/** A stretch of prose holding one page reference; `id` null: a definition, removed. */
interface PageRefSpan {
  start: number
  end: number
  id: string | null
}

class Prose {
  private readonly code: Array<[number, number]>

  constructor(readonly text: string) {
    this.code = [...text.matchAll(CODE_SPAN_RE)].map((m) => [
      m.index ?? 0,
      (m.index ?? 0) + m[0].length,
    ])
  }

  /** The start of the code span holding `i`, or -1. */
  codeStart(i: number): number {
    for (const [from, to] of this.code) if (i >= from && i < to) return from
    return -1
  }

  /** A bracket that counts: outside code and not escaped by an odd run of backslashes. */
  bracketAt(i: number): "[" | "]" | null {
    const c = this.text[i]
    if (c !== "[" && c !== "]") return null
    let slashes = 0
    for (let j = i - 1; j >= 0 && this.text[j] === "\\"; j--) slashes++
    return slashes % 2 === 0 ? c : null
  }

  lineStart(i: number, floor: number): number {
    return Math.max(floor, this.text.lastIndexOf("\n", i - 1) + 1)
  }

  /**
   * Where the label ending at `close` (the `]` before a page target) begins, never
   * before `floor`. The CommonMark start (balanced brackets) first; then, as a model
   * that forgot to escape a title can leave an opening bracket unmatched before it
   * (`@[Q3 [draft](…)`), the earliest unmatched `[` of the line when the label holds
   * text or the bracket opens a mention. With more `]` than `[` (no balanced start),
   * the nearest mention on the line, else its first `[`. A leading `@` or `!` goes with
   * the label. Stripping a few of the writer's own words on a malformed line is the
   * price of never keeping a title.
   */
  labelStart(close: number, floor: number): number {
    const t = this.text
    let depth = 0
    let balanced = -1
    for (let i = close; i >= floor; i--) {
      const cs = this.codeStart(i)
      if (cs >= 0) {
        i = cs
        continue
      }
      // A blank line ends the paragraph: no label crosses it.
      if (t[i] === "\n" && /^[ \t\r]*$/.test(t.slice(this.lineStart(i, floor), i))) break
      const b = this.bracketAt(i)
      if (b === "]") depth++
      else if (b === "[" && --depth === 0) {
        balanced = i
        break
      }
    }
    let start: number
    if (balanced >= 0) {
      start = balanced
      const labelEmpty = close === balanced + 1
      let d = 0
      for (let i = balanced - 1; i >= this.lineStart(balanced, floor); i--) {
        const cs = this.codeStart(i)
        if (cs >= 0) {
          i = cs
          continue
        }
        const b = this.bracketAt(i)
        if (b === "]") d++
        else if (b === "[") {
          if (d > 0) d--
          else if (!labelEmpty || t[i - 1] === "@") start = i
        }
      }
    } else {
      let mention = -1
      let earliest = -1
      for (let i = close - 1; i >= this.lineStart(close, floor); i--) {
        const cs = this.codeStart(i)
        if (cs >= 0) {
          i = cs
          continue
        }
        if (this.bracketAt(i) !== "[") continue
        if (mention < 0 && t[i - 1] === "@") mention = i
        earliest = i
      }
      start = mention >= 0 ? mention : earliest >= 0 ? earliest : close
    }
    if (start > floor && (t[start - 1] === "@" || t[start - 1] === "!")) start--
    return start
  }
}

/** The page reference definitions of a text (outside code): label to page id. */
function pageDefinitions(md: string): Map<string, string> {
  const defs = new Map<string, string>()
  if (!md.includes("]:")) return defs
  mapOutsideCode(md, (text) => {
    for (const m of text.matchAll(DEFINITION_RE)) {
      const label = refLabel(m[1] ?? "")
      if (m[2] && !defs.has(label)) defs.set(label, m[2])
    }
    return text
  })
  return defs
}

interface Candidate {
  /** Where the reference is found: its end mark for a backwards label, else its start. */
  at: number
  /** A fixed start, or null: the label is found backwards from `at`. */
  start: number | null
  end: number
  id: string | null
  /** Collapsed reference: the label itself names the definition. */
  collapsed?: boolean
}

function pageRefSpans(prose: Prose, defs: Map<string, string>): PageRefSpan[] {
  const t = prose.text
  const found: Candidate[] = []
  const add = (c: Candidate) => {
    if (prose.codeStart(c.start ?? c.at) < 0) found.push(c)
  }
  for (const m of t.matchAll(INLINE_END_RE)) {
    const at = m.index ?? 0
    add({ at, start: null, end: at + m[0].length, id: m[1] ?? null })
  }
  for (const m of t.matchAll(AUTOLINK_RE)) {
    const at = m.index ?? 0
    add({ at, start: at, end: at + m[0].length, id: m[1] ?? null })
  }
  for (const m of t.matchAll(ANCHOR_RE)) {
    const at = m.index ?? 0
    add({ at, start: at, end: at + m[0].length, id: m[1] ?? null })
  }
  if (defs.size > 0) {
    for (const m of t.matchAll(DEFINITION_RE)) {
      const at = m.index ?? 0
      add({ at, start: at, end: at + m[0].length, id: null })
    }
    for (const m of t.matchAll(REFERENCE_END_RE)) {
      const at = m.index ?? 0
      const label = m[1] ?? ""
      if (label.trim() === "") {
        add({ at, start: null, end: at + m[0].length, id: null, collapsed: true })
      } else {
        const id = defs.get(refLabel(label))
        if (id) add({ at, start: null, end: at + m[0].length, id })
      }
    }
    for (const m of t.matchAll(SHORTCUT_RE)) {
      const at = m.index ?? 0
      const id = defs.get(refLabel(m[1] ?? ""))
      if (id && t[at - 1] !== "]") add({ at, start: at, end: at + m[0].length, id })
    }
  }
  found.sort((a, b) => a.at - b.at || b.end - a.end)
  const spans: PageRefSpan[] = []
  let floor = 0
  for (const c of found) {
    if (c.at < floor) continue
    const start = c.start ?? prose.labelStart(c.at, floor)
    if (start < floor) continue
    let id = c.id
    if (c.collapsed) {
      id = defs.get(refLabel(t.slice(start, c.at).replace(/^[@!]?\[/, ""))) ?? null
      if (!id) continue
    }
    spans.push({ start, end: c.end, id })
    floor = c.end
  }
  return spans
}

/** Apply `fn` to the page references of every prose block (outside fenced blocks). */
function mapPageRefs(md: string, fn: (span: PageRefSpan, text: string) => string): string {
  if (!/knowledge:document:/i.test(md)) return md
  const defs = pageDefinitions(md)
  return mapProseBlocks(md, (block) => {
    const prose = new Prose(block)
    const spans = pageRefSpans(prose, defs)
    if (spans.length === 0) return block
    let out = ""
    let last = 0
    for (const span of spans) {
      out += block.slice(last, span.start) + fn(span, block.slice(span.start, span.end))
      last = span.end
    }
    return out + block.slice(last)
  })
}

/**
 * Every page reference outside code becomes the bare token, whatever its form (an
 * agent's mention, a labelled link with any brackets, escapes or code in its label, a
 * link title, an image, an autolink, an HTML anchor, a reference link); a reference
 * definition naming a page is removed. Idempotent; canonical bytes are kept.
 */
export function normalizePageRefs(md: string): string {
  return mapPageRefs(md, (span, text) => {
    if (span.id === null) return ""
    return text === pageToken(span.id) ? text : pageToken(span.id)
  })
}

/** The ids of the pages a body links to, outside code, in order, once each. */
export function pageIdsOf(md: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  mapPageRefs(md, (span, text) => {
    if (span.id && !seen.has(span.id.toLowerCase())) {
      seen.add(span.id.toLowerCase())
      out.push(span.id)
    }
    return text
  })
  return out
}

/** The ids of the files a body shows, outside code, in order, once each. */
export function fileIdsOf(md: string): string[] {
  return collectOutsideCode(md, FILE_REF_RE)
}

/** The body with every token (and any label) removed, for snippets. */
export function plainTextOf(md: string): string {
  return mapOutsideCode(
    mapPageRefs(md, () => ""),
    (text) => text.replace(FILE_REF_RE, ""),
  )
}

/**
 * The body with the file ids `map` names (any case) replaced by their new ids, in
 * every file reference outside code. Every other byte, an alt text included, is kept.
 */
export function replaceFileIds(md: string, map: Readonly<Record<string, string>>): string {
  const to = new Map(Object.entries(map).map(([from, id]) => [from.toLowerCase(), id]))
  if (to.size === 0 || !md.includes("liaison-file:")) return md
  return mapOutsideCode(md, (text) =>
    text.replace(FILE_REF_RE, (whole, id: string) => {
      const next = to.get(id.toLowerCase())
      return next ? `${whole.slice(0, whole.length - id.length - 1)}${next})` : whole
    }),
  )
}
