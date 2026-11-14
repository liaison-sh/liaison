// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Help tab's data: the docs bundle the build ships under `/help-docs/`
 * (packages/shared/src/help-docs.ts), read lazily and cached for the session,
 * and the search over it.
 */
import {
  HELP_DOCS_BASE,
  HELP_DOCS_SITE,
  HELP_ROUTE,
  type HelpDocsEntry,
  type HelpDocsIndex,
  type HelpDocsPage,
  helpDocsPageFile,
} from "@liaison/shared"

let indexLoad: Promise<HelpDocsIndex> | null = null
const pageLoads = new Map<string, Promise<HelpDocsPage>>()

async function readJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return (await res.json()) as T
}

/** The nav and the search entries. A failed read is not cached, so a retry reads again. */
export function loadHelpIndex(): Promise<HelpDocsIndex> {
  if (!indexLoad) {
    indexLoad = readJson<HelpDocsIndex>(`${HELP_DOCS_BASE}index.json`).catch((err) => {
      indexLoad = null
      throw err
    })
  }
  return indexLoad
}

export function loadHelpPage(url: string): Promise<HelpDocsPage> {
  let load = pageLoads.get(url)
  if (!load) {
    load = readJson<HelpDocsPage>(helpDocsPageFile(url)).catch((err) => {
      pageLoads.delete(url)
      throw err
    })
    pageLoads.set(url, load)
  }
  return load
}

/** Test seam: forget what was read. */
export function resetHelpDocsCache(): void {
  indexLoad = null
  pageLoads.clear()
}

/** A link target inside the docs: the page's url ("" is the landing page) and its anchor. */
export interface HelpTarget {
  url: string
  hash: string
}

/**
 * The docs page an in-bundle href points at (`/help`, `/help/<url>`, either with
 * `#anchor`), or null for anything else (outside links, same-page anchors).
 */
export function helpTargetOf(href: string): HelpTarget | null {
  if (
    href !== HELP_ROUTE &&
    !href.startsWith(`${HELP_ROUTE}/`) &&
    !href.startsWith(`${HELP_ROUTE}#`)
  )
    return null
  const hashAt = href.indexOf("#")
  const path = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : href.slice(hashAt + 1)
  return { url: path.slice(HELP_ROUTE.length).replace(/^\/+|\/+$/g, ""), hash }
}

/** The same page on the published site, for "Open in browser". */
export function helpSiteUrl(target: HelpTarget): string {
  return `${HELP_DOCS_SITE}${target.url ? `${target.url}/` : ""}${target.hash ? `#${target.hash}` : ""}`
}

export interface HelpSearchHit {
  entry: HelpDocsEntry
  /** Set when the hit is one heading of the page. */
  heading?: { text: string; id: string }
  /** A short piece of the page's text around the first match (page hits only). */
  snippet?: string
  score: number
}

/** Lower case, accents dropped: "Réglages" finds "reglages" and the other way round. */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

const SNIPPET_BEFORE = 40
const SNIPPET_LENGTH = 160

function snippetAround(text: string, word: string): string | undefined {
  const at = normalizeForSearch(text).indexOf(word)
  if (at === -1) return undefined
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const piece = text.slice(start, start + SNIPPET_LENGTH).trim()
  return `${start > 0 ? "…" : ""}${piece}${start + SNIPPET_LENGTH < text.length ? "…" : ""}`
}

/**
 * Every page or heading that holds every word of the query. A word in the title
 * ranks first, then in a heading, then in the description, then anywhere in the
 * text; within a rank, nav order.
 */
export function searchHelp(index: HelpDocsIndex, query: string, limit = 20): HelpSearchHit[] {
  const words = normalizeForSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const all = (hay: string) => words.every((w) => hay.includes(w))
  const hits: HelpSearchHit[] = []
  for (const entry of index.entries) {
    const title = normalizeForSearch(entry.title)
    const description = normalizeForSearch(entry.description)
    const text = normalizeForSearch(entry.text)
    const section = normalizeForSearch(entry.section)
    if (all(title)) hits.push({ entry, score: 4 })
    else if (all(`${title} ${section} ${description}`)) hits.push({ entry, score: 2 })
    else if (all(`${title} ${section} ${description} ${text}`))
      hits.push({ entry, score: 1, snippet: snippetAround(entry.text, words[0] as string) })
    for (const h of entry.headings) {
      if (all(normalizeForSearch(h.text))) hits.push({ entry, heading: h, score: 3 })
    }
  }
  // Array.prototype.sort is stable, so equal scores keep nav order.
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
