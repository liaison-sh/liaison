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

/** Any file reference, alt text or not. */
const FILE_REF_RE = new RegExp(`!\\[(?:\\\\.|[^\\]\\\\])*\\]\\(liaison-file:(${UUID})\\)`, "g")
/** Any page reference: an agent's `@[Title](…)`, a labelled link, or the bare token. */
const PAGE_REF_RE = new RegExp(
  `@?(?<!!)\\[(?:\\\\.|[^\\]\\\\])*\\]\\(knowledge:document:(${UUID})\\)`,
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
 * Apply `fn` to every stretch of text outside fenced blocks and code spans, and
 * return the text with those stretches replaced. Line endings are kept as they are.
 */
function mapOutsideCode(md: string, fn: (text: string) => string): string {
  const lines = md.split(/(?<=\n)/)
  let out = ""
  let prose = ""
  let fence: { char: string; len: number } | null = null
  const flushProse = () => {
    if (!prose) return
    let last = 0
    let mapped = ""
    for (const m of prose.matchAll(CODE_SPAN_RE)) {
      const at = m.index ?? 0
      mapped += fn(prose.slice(last, at)) + m[0]
      last = at + m[0].length
    }
    mapped += fn(prose.slice(last))
    out += mapped
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

/** Every labelled page reference outside code becomes the bare token; idempotent. */
export function normalizePageRefs(md: string): string {
  if (!md.includes("knowledge:document:")) return md
  return mapOutsideCode(md, (text) =>
    text.replace(PAGE_REF_RE, (whole, id: string) =>
      whole === pageToken(id) ? whole : pageToken(id),
    ),
  )
}

/** The ids of the pages a body links to, outside code, in order, once each. */
export function pageIdsOf(md: string): string[] {
  return collectOutsideCode(md, PAGE_REF_RE)
}

/** The ids of the files a body shows, outside code, in order, once each. */
export function fileIdsOf(md: string): string[] {
  return collectOutsideCode(md, FILE_REF_RE)
}

/** The body with every token (and any label) removed, for snippets. */
export function plainTextOf(md: string): string {
  return mapOutsideCode(md, (text) => text.replace(PAGE_REF_RE, "").replace(FILE_REF_RE, ""))
}
