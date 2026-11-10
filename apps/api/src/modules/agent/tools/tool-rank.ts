// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The keyword ranker behind `tool_search` and the MCP gateway's
 * `liaison_tool_search`. Pure: it reads the catalog it is handed and imports
 * nothing with a side effect, so a test can run it over the real catalog with
 * no server.
 */

import { NAME_WORD_SYNONYMS } from "./tool-lexicon"
import { meaningPoints, type ToolMeaning } from "./tool-meaning"

/** Meaning points a tool no word matched needs to join the list: past the floor, not the tie trace. */
const MEANING_JOIN_POINTS = 0.01

/** The app whose tools connect any outside system (see creditOutsideSystemNames). */
export const CONNECTOR_APP = "api-connector"

/** Lower case with accents gone, so "réclamation" and "reclamation" are one word. */
function foldSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
}

/**
 * One query word, folded. A word under 3 letters stays as typed: folded, "à" or
 * "où" would become a substring of most tool names, where as typed it matches
 * none of them.
 */
function foldSearchTerm(term: string): string {
  const folded = foldSearchText(term)
  return folded.length < 3 ? term.toLowerCase() : folded
}

/**
 * The shortest query word matched as the start of a longer word: a name part
 * ("sub" in `subagent_create`), an app's name or a description word. Never the
 * middle of a word: "du" is not in "duplicates", "la" not in "pennylane",
 * "done" not in "abandoned". A shorter word matches only a whole name part, a
 * keyword or an app's name.
 */
const MIN_SUBSTRING_TERM = 3

function substringOk(term: string): boolean {
  return term.length >= MIN_SUBSTRING_TERM
}

/** What a word found only in a tool's description scores. */
const DESCRIPTION_SCORE = 2

interface ScoringWords {
  /** The name parts, single-word keywords and description words by stem (see wordStem). */
  nameStems: Map<string, string[]>
  keywordStems: Map<string, string[]>
  descStems: Set<string>
  /** Name parts and keywords with their stems, which a misspelling is compared to ("refnud", "refund"). */
  typoNames: string[]
  typoKeywords: string[]
  nameParts: string[]
  /** The name with its separators and case dropped: `internalCallback` is "internalcallback". */
  nameJoined: string
  keywords: string[] | undefined
  appLower: string
  appParts: string[]
  descWords: string[]
}

/**
 * A tool's words, folded once per tool row rather than once per query word.
 * Keyed by the row object: a catalog listing builds fresh rows, so a changed
 * description never meets an old entry.
 */
const scoringWordsCache = new WeakMap<ScorableDeferredTool, ScoringWords>()

function scoringWords(t: ScorableDeferredTool): ScoringWords {
  const cached = scoringWordsCache.get(t)
  if (cached) return cached
  const appLower = t.appName.toLowerCase()
  // camelCase splits too: `bulkDeactivateUsers` is bulk, deactivate, users.
  const nameParts = t.toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  const keywords = t.keywords?.map(foldSearchText)
  const appParts = appLower.split(/[^a-z0-9]+/)
  const descWords = foldSearchText(t.description).split(/[^\p{L}\p{N}]+/u)
  const single = (keywords ?? []).filter((k) => !/\s/.test(k))
  const words: ScoringWords = {
    nameStems: byStem(nameParts),
    keywordStems: byStem(single),
    descStems: new Set(descWords.map(wordStem)),
    typoNames: [...new Set([...nameParts, ...nameParts.map(wordStem)])],
    typoKeywords: [...new Set([...single, ...single.map(wordStem)])],
    nameParts,
    nameJoined: nameParts.join(""),
    keywords,
    appLower,
    appParts,
    descWords,
  }
  scoringWordsCache.set(t, words)
  return words
}

function byStem(list: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const word of list) {
    const stem = wordStem(word)
    const words = out.get(stem)
    if (!words) out.set(stem, [word])
    else if (!words.includes(word)) words.push(word)
  }
  return out
}

/**
 * True when `word` is `term` (or its singular) plus "-er": the one who does
 * it, another word than it. A "dealer" is not a "deal", nor a "sender" a
 * "send", so neither a stem nor a start of word matches one to the other.
 */
function agentNounOf(word: string, term: string): boolean {
  if (!word.endsWith("er") && !word.endsWith("ers")) return false
  const bases = term.endsWith("s") ? [term, term.slice(0, -1)] : [term]
  return bases.some((base) => word === `${base}er` || word === `${base}ers`)
}

/** True when a word of `stems` shares the term's stem and is not its agent noun. */
function stemMatches(stems: Map<string, string[]>, stem: string, term: string): boolean {
  return stems.get(stem)?.some((word) => !agentNounOf(word, term)) ?? false
}

/** True when a word of `list` starts with the term and is not its agent noun. */
function startsWord(list: readonly string[], term: string): boolean {
  return list.some((word) => word.startsWith(term) && !agentNounOf(word, term))
}

// ── Beyond the exact word ────────────────────────────────────────────────
// A word that is another form of a name part ("invoicing", "factures"), a
// misspelling of one ("refnud"), or its translation or plain synonym
// ("rembourser", "money"), scores under the exact word and above a word found
// only in a description.
const STEM_NAME_SCORE = 7
const STEM_KEYWORD_SCORE = 6
const SYNONYM_NAME_SCORE = 7
const SYNONYM_KEYWORD_SCORE = 6
const TYPO_NAME_SCORE = 6
const TYPO_KEYWORD_SCORE = 5
const TYPO_APP_SCORE = 4
const MIN_STEM = 4
/**
 * In a query of several words, each word's score is weighed by how few tools
 * answer to it: from 1 for a word one tool answers to, down to this floor for a
 * word every tool does. A sentence's common words ("send", "list") then rank
 * tools less than its one rare word.
 */
const RARE_WORD_FLOOR = 0.5

/**
 * In a query that names no app, a word an app's tool matches no better than a
 * kernel tool of the same record does counts this share for the app's tool:
 * the organization's own records (its companies, contacts) come before an
 * app's records of the same name. A word naming the app ("shopify") lifts its
 * tools again.
 */
const SAME_WORD_APP_SHARE = 0.9

/**
 * Inflection endings, English and French, longest first, compared on folded
 * text. A word and its stem must keep MIN_STEM letters.
 */
const SUFFIXES = [
  "issements",
  "issement",
  "ements",
  "ations",
  "ateurs",
  "atrices",
  "ement",
  "ation",
  "ateur",
  "atrice",
  "ments",
  "ment",
  "ings",
  "ing",
  "ies",
  "ied",
  "euses",
  "euse",
  "eurs",
  "eur",
  "ees",
  "ee",
  "ers",
  "er",
  "ez",
  "es",
  "ed",
  "ons",
  "ent",
  "ant",
  "ais",
  "ait",
  "s",
  "x",
  "e",
  "y",
]

/** The stem two forms of one word share: "factures", "facturer", "facturé" are "factur". */
export function wordStem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM)
      return word.slice(0, -suffix.length)
  }
  return word
}

/** The name words a query word stands for, by stem (tool-lexicon.ts). */
const SYNONYMS_BY_STEM = (() => {
  const out = new Map<string, string[]>()
  for (const [word, names] of Object.entries(NAME_WORD_SYNONYMS)) {
    const stem = wordStem(word)
    out.set(stem, [...new Set([...(out.get(stem) ?? []), ...names])])
  }
  return out
})()

/** Every word the catalog holds: name parts, keywords, app parts, description words. */
const vocabularyCache = new WeakMap<readonly ScorableDeferredTool[], Set<string>>()
function vocabularyOf(tools: readonly ScorableDeferredTool[]): Set<string> {
  const cached = vocabularyCache.get(tools)
  if (cached) return cached
  const vocab = new Set<string>()
  for (const t of tools) {
    const w = scoringWords(t)
    for (const list of [w.nameParts, w.keywords ?? [], w.appParts, w.descWords])
      for (const word of list) vocab.add(word)
  }
  vocabularyCache.set(tools, vocab)
  return vocab
}

/** Shortest word read as a typo of another, and the edits allowed by length. */
const MIN_TYPO_TERM = 5
function typoEdits(length: number): number {
  return length >= 9 ? 2 : 1
}

/** True when `term` is within its allowed edits (a swap of two letters is one) of a word. */
function typoOf(term: string, words: readonly string[]): boolean {
  if (term.length < MIN_TYPO_TERM) return false
  const max = typoEdits(term.length)
  return words.some(
    (w) =>
      w.length >= MIN_TYPO_TERM - 1 &&
      Math.abs(w.length - term.length) <= max &&
      editDistance(term, w, max) <= max,
  )
}

/** Optimal string alignment distance, cut off past `max`. */
function editDistance(a: string, b: string, max: number): number {
  const m = a.length
  const n = b.length
  let prev2: number[] = []
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2] + 1)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[n]
}

/** The minimal shape the keyword scorer needs from a deferred-tool row. */
export interface ScorableDeferredTool {
  toolName: string
  appName: string
  description: string
  /**
   * Words the tool answers to beyond its name, weighed almost like a name part:
   * a connector tool's operation names and connected system ("add_company_note",
   * "crm"), which its static description cannot know.
   */
  keywords?: readonly string[]
}

/**
 * Tokenized keyword scoring shared by the in-agent `tool_search` and the MCP
 * gateway's `liaison_tool_search`. Tokenizes the query on the separators models
 * (and humans) actually type — whitespace, `,` `:` `.` `/` `_` `-` — so
 * "create skill" matches `create_skill` instead of requiring the exact
 * underscore form (the naive single-substring match this replaces made the
 * MCP discovery search return nothing for it).
 */
export function scoreDeferredTools<T extends ScorableDeferredTool>(
  tools: readonly T[],
  query: string,
  /** The org's app names, so a kernel tool is not held to match the app it acts on. */
  opts?: {
    appNames?: Iterable<string>
    /** The catalog whose words count as known (typos), when `tools` is a part of it. */
    vocabularyOf?: readonly ScorableDeferredTool[]
  },
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  let terms = query
    .toLowerCase()
    .split(/[\s,:./_'’-]+/)
    .filter(Boolean)
    .map(foldSearchTerm)
  const appTerms = new Set([...(opts?.appNames ?? [])].map((n) => n.toLowerCase()))
  // Filler words ("an", "de") name nothing, so a tool is not held to match
  // them, unless the query is nothing but filler.
  const named = terms.filter((term) => !FILLER_WORDS.has(term))
  if (named.length > 0) terms = named
  const vocab = vocabularyOf(opts?.vocabularyOf ?? tools)
  // A word no tool's name, keyword, app or description holds is read as a typo
  // of the closest such word; a word the catalog knows is never "corrected".
  const unknown = new Set(terms.filter((term) => !vocab.has(term)))
  const termStems = terms.map(wordStem)
  // A stem too short to tell words apart ("cre") is not compared.
  const stemOk = termStems.map((stem) => stem.length >= MIN_STEM)
  const termSynonyms = terms.map(
    (term, i) => SYNONYMS_BY_STEM.get(termStems[i]) ?? SYNONYMS_BY_STEM.get(term) ?? [],
  )
  const rows = tools.map((t) => {
    let score = 0
    let termsMatched = 0
    let termCount = 0
    const words = scoringWords(t)
    const { nameParts, nameJoined, keywords, appLower, appParts, descWords } = words
    const isKernel = t.appName === "kernel"

    const per: number[] = []
    for (const [i, term] of terms.entries()) {
      const before = score
      // Exact name part match (high weight); a singular term also names its
      // plural part ("app" names `apps_set_enabled`).
      // The whole name typed as one word ("internalcallback") names it as well.
      if (
        nameParts.some((p) => p === term || p === `${term}s`) ||
        nameJoined === term ||
        nameJoined === `${term}s`
      )
        score += 10
      // A keyword the tool declares for this org (singular or plural either way)
      else if (keywords?.some((k) => k === term || k === `${term}s` || `${k}s` === term)) score += 8
      // The tool's app named exactly: every tool of the app answers alike, so
      // another form of a name part does not set one of them apart.
      else if (appLower === term) score += 6
      // Another form of a name part or keyword ("invoicing", "facturer").
      else if (stemOk[i] && stemMatches(words.nameStems, termStems[i], term))
        score += STEM_NAME_SCORE
      // A translation or plain synonym of a name part (tool-lexicon.ts).
      else if (termSynonyms[i].some((x) => nameParts.some((p) => p === x || p === `${x}s`)))
        score += SYNONYM_NAME_SCORE
      else if (stemOk[i] && stemMatches(words.keywordStems, termStems[i], term))
        score += STEM_KEYWORD_SCORE
      // Partial name match: the start of a name part ("invoice" in `invoices`),
      // never the middle of one ("done" is not in `abandoned`). The whole name's
      // start counts too ("internalcall" in `internalCallback`).
      else if (
        substringOk(term) &&
        (startsWord(nameParts, term) ||
          (term.length > nameParts[0].length && nameJoined.startsWith(term)))
      )
        score += 5
      // App name match
      else if (appLower === term || (substringOk(term) && appParts.some((p) => p.startsWith(term))))
        score += 6
      // A translation or plain synonym of a keyword.
      else if (termSynonyms[i].some((x) => keywords?.includes(x))) score += SYNONYM_KEYWORD_SCORE
      // A misspelt name part, keyword or app name, for a word the catalog does not hold.
      else if (unknown.has(term) && typoOf(term, words.typoNames)) score += TYPO_NAME_SCORE
      else if (unknown.has(term) && typoOf(term, words.typoKeywords)) score += TYPO_KEYWORD_SCORE
      else if (unknown.has(term) && typoOf(term, appParts)) score += TYPO_APP_SCORE
      // Description match (lower weight), at the start of a word
      else if (substringOk(term) && descWords.some((w) => w.startsWith(term)))
        score += DESCRIPTION_SCORE
      else if (stemOk[i] && words.descStems.has(termStems[i])) score += DESCRIPTION_SCORE
      per[i] = score - before
      if (score > before) termsMatched++
      // Another app's name is the ARGUMENT of a kernel tool, which acts on
      // apps ("turn the social app off"), not a term the tool must match.
      else if (isKernel && appTerms.has(term)) continue
      termCount++
    }

    return { tool: t, score, termsMatched, termCount, per }
  })
  preferOwnRecords(rows, terms)
  if (terms.length < 2) return rows.map(({ per: _, ...r }) => r)
  // A word many tools answer to tells them apart less than a rare one.
  const n = Math.max(2, tools.length)
  const weight = terms.map((_, i) => {
    const answering = rows.filter((r) => r.per[i] > 0).length
    return (
      RARE_WORD_FLOOR +
      (1 - RARE_WORD_FLOOR) * (Math.log((n + 1) / (answering + 1)) / Math.log(n + 1))
    )
  })
  return rows.map(({ per, ...r }) => ({
    ...r,
    score: Math.round(per.reduce((sum, v, i) => sum + v * weight[i], 0) * 100) / 100,
  }))
}

/** True when a query word names an app of the catalog, as the scorer reads app names. */
function namesAnApp(rows: ReadonlyArray<{ tool: ScorableDeferredTool }>, terms: readonly string[]) {
  return rows.some(({ tool }) => {
    if (tool.appName === "kernel") return false
    const { appLower, appParts } = scoringWords(tool)
    return terms.some(
      (term) =>
        appLower === term ||
        appLower === `${term}s` ||
        (substringOk(term) && appParts.some((p) => p.startsWith(term))),
    )
  })
}

/**
 * The record a tool acts on: the stems of its name before the action, as tools
 * are named `<record>_<action>` (`companies_search`). A word that ends some
 * tool's name is an action (`create`, `search`), so `create_role` and
 * `create_shipment` share no record.
 */
function recordStems(t: ScorableDeferredTool, actions: ReadonlySet<string>): string[] {
  const { nameParts } = scoringWords(t)
  return nameParts
    .slice(0, -1)
    .map(wordStem)
    .filter((stem) => !actions.has(stem))
}

/**
 * The kernel's tool comes first on a word it shares with an app's tool of the
 * same record, unless the query names an app (SAME_WORD_APP_SHARE). Each word
 * is weighed apart, so an app tool still leads on a word only it answers to
 * ("B2B").
 */
function preferOwnRecords(
  rows: Array<{ tool: ScorableDeferredTool; score: number; per: number[] }>,
  terms: readonly string[],
): void {
  if (namesAnApp(rows, terms)) return
  const actions = new Set(rows.map((r) => wordStem(scoringWords(r.tool).nameParts.at(-1) ?? "")))
  const kernel = rows
    .filter((r) => r.tool.appName === "kernel")
    .map((r) => ({ r, records: recordStems(r.tool, actions) }))
    .filter((k) => k.records.length > 0)
  if (kernel.length === 0) return
  for (const r of rows) {
    if (r.tool.appName === "kernel") continue
    const records = recordStems(r.tool, actions)
    if (records.length === 0) continue
    const same = kernel.filter((k) => k.records.some((stem) => records.includes(stem)))
    for (const i of terms.keys()) {
      const v = r.per[i] ?? 0
      if (v === 0 || !same.some((k) => (k.r.per[i] ?? 0) >= v)) continue
      r.per[i] = v * SAME_WORD_APP_SHARE
      r.score -= v - r.per[i]
    }
  }
}

/**
 * The matches a keyword search LOADS, as opposed to lists. A query for
 * `mail:read` used to load its five padded hits: mail__read and then
 * google-drive__read, database__db_read, gitlab__gitlab_read_file and
 * mail__listAccounts, each of those a whole app whose full instruction guide
 * then rode in the cached prefix for the life of the thread. A strong match
 * satisfies EVERY query term and ties the best score; the rest stay listed,
 * one direct call or one `select:` away. A bare app name is a request for that
 * app's whole surface, so every usable hit is strong.
 */
export function strongMatches<T extends { score: number; termsMatched: number; termCount: number }>(
  scored: readonly T[],
  wholeAppQuery: boolean,
): T[] {
  if (wholeAppQuery) return [...scored]
  const top = scored.reduce((best, s) => Math.max(best, s.score), 0)
  // A tool whose every word was found only in its description is listed, not
  // loaded: "signature" loaded a mail-inbox setter for the word in its prose.
  return scored.filter(
    (s) =>
      s.score === top &&
      s.termsMatched === s.termCount &&
      s.score > DESCRIPTION_SCORE * s.termCount,
  )
}

/** Words of a request that name no capability ("connect OUR crm"). */
const FILLER_WORDS = new Set([
  ..."a an the our my your their its it we us i you me to for of in on at with and or from please can could would some do does what how is are be this that".split(
    " ",
  ),
  // French. Words under 3 letters are compared as typed, so "à" and "où" keep their accent.
  ..."le la les l d de du des un une et ou au aux en pour par sur dans avec sans mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces qui que quoi est sont je tu il elle on nous vous ils elles me te se y à moi toi lui tout tous toute toutes stp svp peux pouvez".split(
    " ",
  ),
])

/** What a word must score alone to be kept: a tool's name part (10) or keyword (8). */
const NAMED_TERM_SCORE = 8

/**
 * The query a keyword search scores with. A strong match must satisfy every
 * term, so "connect our CRM" loaded nothing for want of "our", and a weak model
 * concluded the capability was missing. Filler words and words no tool answers
 * to at all (a vendor's name: "connect HubSpot") are dropped, but only when
 * every word kept NAMES a tool (a name part or a keyword) or an installed app:
 * a word found only in descriptions ("post" in "post to facebook" with the
 * social app off) must not load whatever mentions it. Null: the query is
 * scored as typed. `outside` holds the dropped words no tool answers to: the
 * name of a system Liaison has no app for (creditOutsideSystemNames).
 */
function loadingTerms(
  tools: readonly ScorableDeferredTool[],
  terms: readonly string[],
  appNames: Iterable<string>,
): { query: string; outside: string[] } | null {
  const apps = [...appNames].map((a) => a.toLowerCase())
  const best = (term: string) =>
    Math.max(0, ...scoreDeferredTools(tools, term, { appNames: apps }).map((s) => s.score))
  const kept = terms.filter((term) => !FILLER_WORDS.has(term) && best(term) > 0)
  if (kept.length === 0 || kept.length === terms.length) return null
  const named = kept.every((term) => best(term) >= NAMED_TERM_SCORE || apps.includes(term))
  if (!named) return null
  const outside = terms.filter((term) => !FILLER_WORDS.has(term) && !kept.includes(term))
  return { query: kept.join(" "), outside }
}

/**
 * A word no tool answers to is the name of a system Liaison has no app for
 * ("connect HubSpot"), and the API connector is the app that connects any such
 * system: its tools answer to that name as a keyword, exactly as they answer
 * to the name of a system already connected (withConnectorHints). So a
 * connector tool is scored on the kept words plus that name, every other tool
 * on the kept words alone. Without it, dropping the name left "connect", and
 * the tool with "connect" in its own name (sending a member a link for their
 * own Gmail) outscored the adapter save that connects the system named.
 */
function creditOutsideSystemNames<T extends ScorableDeferredTool>(
  scored: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>,
  loading: { query: string; outside: string[] },
  appNames: Iterable<string>,
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  if (loading.outside.length === 0) return scored
  const query = [loading.query, ...loading.outside].join(" ")
  // The whole catalog is scored again, so each word is weighed by how many
  // tools answer to it there (RARE_WORD_FLOOR), the credited ones included.
  // Only a connector tool the rest of the query already asks for ("connect"):
  // in "book a call with Lumen", the name is a person's or a customer's, not a
  // system to connect.
  const credit = (s: (typeof scored)[number]) => s.tool.appName === CONNECTOR_APP && s.score > 0
  if (!scored.some(credit)) return scored
  const credited = scored.map((s) =>
    credit(s) ? { ...s.tool, keywords: [...(s.tool.keywords ?? []), ...loading.outside] } : s.tool,
  )
  const rescored = scoreDeferredTools(credited, query, { appNames })
  return scored.map((s, i) => (credit(s) ? { ...rescored[i], tool: s.tool } : s))
}

/**
 * A query that names one app and several of its actions ("search and read
 * mail") asks for each of those tools. No single tool satisfies every word of
 * it, so the every-word rule loaded none of them and the model called them
 * blind. Here each action word picks the app's tool whose whole name it is
 * (`mail__search`, `mail__read`), and those tools load together. Null unless
 * every named word is the app's name or such a tool's name, with at least two
 * tools named: a word that is only part of names ("list") keeps the usual rule.
 */
function appActionMatches<T extends ScorableDeferredTool>(
  catalog: readonly T[],
  terms: readonly string[],
): T[] | null {
  const named = terms.filter((term) => !FILLER_WORDS.has(term))
  if (named.length < 3) return null
  const apps = new Set(catalog.map((t) => t.appName).filter((a) => a !== "kernel"))
  for (const app of apps) {
    const appLower = app.toLowerCase()
    const appParts = appLower.split(/[^a-z0-9]+/)
    const isAppWord = (term: string) =>
      appLower === term || appLower === `${term}s` || appParts.includes(term)
    const actions = named.filter((term) => !isAppWord(term))
    if (actions.length < 2 || actions.length === named.length) continue
    const tools = catalog.filter((t) => t.appName === app)
    const picked = actions.map((term) =>
      tools.find((t) => {
        const { nameJoined } = scoringWords(t)
        return nameJoined === term || nameJoined === `${term}s`
      }),
    )
    if (picked.every((t) => t !== undefined)) return [...new Set(picked as T[])]
  }
  return null
}

/**
 * One keyword search over a catalog: the tools to list, best first, and which of
 * them the search LOADS. A usable tool always ranks above a locked one. `appNames`
 * is the org's apps (On or Off, without the kernel); `cap` the hits to list.
 */
export function rankDeferredTools<
  T extends ScorableDeferredTool & { sdkName: string; locked?: boolean },
>(
  catalog: readonly T[],
  query: string,
  opts: { cap: number; appNames: Iterable<string>; meaning?: ToolMeaning | null },
): RankedTools<T> {
  const byWords = rankByKeywords(catalog, query, opts)
  return opts.meaning ? addMeaning(catalog, byWords, opts.cap, opts.meaning) : byWords
}

interface RankedTools<T> {
  ranked: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  /** Every tool that scored, best first: `ranked` is its head. */
  all: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  strongNames: Set<string>
  /** The app a bare app-name query asked for, or null. */
  wholeApp: string | null
}

/**
 * The keyword ranking with meaning added (tool-meaning.ts): each tool's score
 * gains its meaning points, and a tool no word matched joins when it stands
 * out by meaning. What the keywords load keeps its place ahead, a usable tool
 * still ranks above a locked one, and a bare app name keeps its app listing.
 * Only tools of `catalog` can rank.
 */
function addMeaning<T extends ScorableDeferredTool & { sdkName: string; locked?: boolean }>(
  catalog: readonly T[],
  byWords: RankedTools<T>,
  cap: number,
  meaning: ToolMeaning,
): RankedTools<T> {
  if (byWords.wholeApp) return byWords
  // A tool some but not all of the query's words matched (the refund tools for
  // "politique remboursement") meets the higher partial floor (tool-meaning.ts).
  const partial = new Set(
    byWords.all
      .filter((s) => s.termsMatched > 0 && s.termsMatched < s.termCount)
      .map((s) => s.tool.sdkName),
  )
  const points = meaningPoints(catalog, meaning, partial)
  if (points.size === 0) return byWords
  const scored = new Set(byWords.all.map((s) => s.tool))
  const joined = catalog
    .filter((t) => !scored.has(t) && (points.get(t.sdkName) ?? 0) >= MEANING_JOIN_POINTS)
    .map((tool) => ({ tool, score: 0, termsMatched: 0, termCount: 0 }))
  const fused = (s: { tool: T; score: number }) => s.score + (points.get(s.tool.sdkName) ?? 0)
  const lead = (s: { tool: T }) => (byWords.strongNames.has(s.tool.sdkName) ? 0 : 1)
  const all = [...byWords.all, ...joined]
    .map((s) => ({ s, f: fused(s) }))
    .sort((a, b) => {
      const al = a.s.tool.locked ? 1 : 0
      const bl = b.s.tool.locked ? 1 : 0
      if (al !== bl) return al - bl
      if (lead(a.s) !== lead(b.s)) return lead(a.s) - lead(b.s)
      return b.f - a.f
    })
    .map(({ s, f }) => ({ ...s, score: f }))
  const listed = Math.max(
    cap,
    byWords.ranked.filter((s) => byWords.strongNames.has(s.tool.sdkName)).length,
  )
  return { ...byWords, all, ranked: all.slice(0, listed) }
}

function rankByKeywords<T extends ScorableDeferredTool & { sdkName: string; locked?: boolean }>(
  catalog: readonly T[],
  query: string,
  opts: { cap: number; appNames: Iterable<string> },
): {
  ranked: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  /** Every tool that scored, best first: `ranked` is its head. */
  all: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  strongNames: Set<string>
  /** The app a bare app-name query asked for, or null. */
  wholeApp: string | null
} {
  // An apostrophe splits too: French elides "de" and "le" ("d'approbation").
  // Tokenized on the separators models actually type (`tickets:reply`,
  // `tickets.reply`, `mail/compose`): whitespace-only splitting scored those
  // queries 0 against everything and dumped the agent into the catalog fallback.
  const terms = query
    .toLowerCase()
    .split(/[\s,:./'’]+/)
    .filter(Boolean)
    .map(foldSearchTerm)

  // A query that names an app exactly (e.g. "tickets") means "show me this
  // app's tools": return ALL of them (up to the hard cap) instead of an
  // arbitrary cap-sized slice of a same-score tie. The tie slice is how
  // `tickets__reply` got crowded out by search/get/create/addNote/assign.
  const catalogApps = new Set(catalog.map((t) => t.appName.toLowerCase()))
  const wholeAppQuery = terms.length === 1 && catalogApps.has(terms[0])
  const effectiveCap = wholeAppQuery ? Math.max(opts.cap, 20) : opts.cap

  const loading = loadingTerms(catalog, terms, opts.appNames)
  const scored = loading
    ? creditOutsideSystemNames(
        scoreDeferredTools(catalog, loading.query, { appNames: opts.appNames }),
        loading,
        opts.appNames,
      )
    : scoreDeferredTools(catalog, query, { appNames: opts.appNames })

  const all = scored
    .filter((s) => s.score > 0)
    // Available tools first, then locked ones (so a usable tool is never crowded out of
    // the cap by a locked one), each group by descending score.
    .sort((a, b) => {
      const al = a.tool.locked ? 1 : 0
      const bl = b.tool.locked ? 1 : 0
      if (al !== bl) return al - bl
      return b.score - a.score
    })
  // Words that name no capability ("what can you do") load nothing, however many
  // descriptions happen to contain them. They still list.
  const namesNothing = terms.every((term) => FILLER_WORDS.has(term))
  const actions = wholeAppQuery || namesNothing ? null : appActionMatches(catalog, terms)
  if (actions) {
    // The app's named actions are the answer: they lead the list and load.
    const picked = all.filter((s) => actions.includes(s.tool))
    const ranked = [...picked, ...all.filter((s) => !actions.includes(s.tool))].slice(
      0,
      Math.max(effectiveCap, picked.length),
    )
    return {
      ranked,
      all,
      strongNames: new Set(picked.map((s) => s.tool.sdkName)),
      wholeApp: null,
    }
  }
  const ranked = all.slice(0, effectiveCap)
  const strongNames = new Set(
    namesNothing ? [] : strongMatches(ranked, wholeAppQuery).map((s) => s.tool.sdkName),
  )
  return { ranked, all, strongNames, wholeApp: wholeAppQuery ? terms[0] : null }
}
