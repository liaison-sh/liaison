// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scale generator (spec-context-bench.md, "Phase 3: the scale bench").
//
// It grows a corpus to N tokens WITHOUT a model: the original corpus is
// written first, so its ledger items sit at the deepest point of the thread,
// and then K mutated copies follow it in time order. A mutated copy keeps the
// shapes and reseeds the identifiers: codes, SHAs, account numbers, plain
// numbers, ISO dates and capitalised names all move, consistently inside one
// copy and differently between copies. The ledger is never mutated, so the
// probes keep asking about the original, deepest copy.
//
// Everything here is pure and deterministic from a seed. The thread is
// streamed to disk one copy at a time: 10 million tokens never exist as JS
// objects at once, the index reads them back from the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadCorpus, renderRow } from "./corpus"
import { estimateTokens } from "./tokens"
import type { CorpusRow, Probe } from "./types"

/** How many id numbers one copy is shifted by, so ids never collide. */
const ID_STRIDE_DIGITS = 1

/** Replacement names for people. Index moves per copy. */
const PERSON_POOL = [
  "Alina",
  "Bruno",
  "Celine",
  "Dorian",
  "Elif",
  "Farid",
  "Greta",
  "Hugo",
  "Ilaria",
  "Joel",
  "Katia",
  "Lucas",
  "Marta",
  "Nadir",
  "Olive",
  "Pieter",
  "Quentin",
  "Rania",
  "Sacha",
  "Tomas",
]

/** Replacement names for hubs, dealers and other organisations. */
const ORG_POOL = [
  "Northgate",
  "Helvetia",
  "Brightfold",
  "Ardenne",
  "Corvid",
  "Delmar",
  "Eastmere",
  "Forgewood",
  "Glenvar",
  "Harrowby",
  "Ironvale",
  "Juniper",
  "Kestrel",
  "Larkfield",
  "Moreno",
  "Nordhaven",
  "Ostrava",
  "Pellworm",
  "Quillon",
  "Ravensby",
]

/** Words that look like names but are not, so they are never swapped. */
const NAME_STOPWORDS = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "There",
  "Then",
  "They",
  "Their",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Good",
  "Morning",
  "Thanks",
  "Yes",
  "Noted",
  "Confirmed",
  "Done",
  "Please",
  "Also",
  "But",
  "And",
  "For",
  "With",
  "What",
  "When",
  "Where",
  "Which",
  "Who",
  "Why",
  "How",
  "One",
  "Two",
  "Three",
  "Not",
  "Now",
  "Got",
  "Can",
  "Will",
  "Should",
  "Still",
  "Same",
  "Next",
  "Last",
  "Week",
  "Just",
  "Both",
  "All",
  "Any",
  "Our",
  "Your",
  "His",
  "Her",
  "Its",
  "From",
  "Into",
  "After",
  "Before",
  "Over",
  "Under",
  "Sent",
  "Set",
  "See",
  "Let",
  "Ready",
  "Update",
  "Status",
])

/**
 * The wording swaps a NON decoy copy gets. A decoy copy keeps the original
 * wording and only its identifiers move, which is what makes it a near
 * duplicate of the original and what the needle at depth curve is about.
 */
const SYNONYMS: [RegExp, string][] = [
  [/\bshipment\b/g, "consignment"],
  [/\bshipments\b/g, "consignments"],
  [/\bcarton\b/g, "case"],
  [/\bcartons\b/g, "cases"],
  [/\bpallet\b/g, "skid"],
  [/\bpallets\b/g, "skids"],
  [/\bwarehouse\b/g, "depot"],
  [/\burgent\b/g, "pressing"],
  [/\bconfirm\b/g, "verify"],
  [/\bconfirmed\b/g, "verified"],
  [/\bdelayed\b/g, "held up"],
  [/\binvoice\b/g, "bill"],
  [/\binvoices\b/g, "bills"],
  [/\bquote\b/g, "estimate"],
  [/\bquotes\b/g, "estimates"],
  [/\btracking\b/g, "trace"],
  [/\bpickup\b/g, "collection"],
  [/\bstock\b/g, "inventory"],
]

/** A small deterministic PRNG, so a seed reproduces a thread exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable 32 bit hash of a string plus a numeric salt. */
export function hash32(text: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export interface CopyPlan {
  /** 0 is the original, never mutated. */
  copy: number
  /** Weeks are shifted by this many, so week 1 of copy 1 is week 7. */
  weekOffset: number
  /** Days every ISO date in the content moves by. */
  dayOffset: number
  /** What every number with 3 or more digits is shifted by. */
  numberOffset: number
  /** True when this copy keeps the original wording (a near duplicate). */
  decoy: boolean
}

/** The per copy plan, derived from the seed alone. */
export function planCopy(params: {
  copy: number
  seed: number
  weeksPerCopy: number
  decoyRatio: number
}): CopyPlan {
  const rand = mulberry32(hash32(`copy:${params.copy}`, params.seed))
  const weekOffset = params.copy * params.weeksPerCopy
  // A copy's decoy status is deterministic and evenly spread: copy c is a
  // decoy when its position in the sequence falls under the ratio.
  const roll = rand()
  const decoy = params.decoyRatio >= 1 ? true : roll < params.decoyRatio
  return {
    copy: params.copy,
    weekOffset,
    dayOffset: weekOffset * 7,
    numberOffset: 1 + Math.floor(rand() * 8999),
    decoy,
  }
}

/** The names the corpus uses, and whether each one is a person or an org. */
export interface NameTable {
  /** Lowercased author names, so a speaker is swapped through PERSON_POOL. */
  people: Set<string>
  /** Every capitalised word the generator will swap, in stable order. */
  names: string[]
}

/**
 * Which capitalised words are names. A word counts when it appears capitalised
 * away from a sentence start at least twice, which keeps "Monday" and "Please"
 * out without needing a dictionary of the corpus.
 */
export function buildNameTable(rows: CorpusRow[]): NameTable {
  const midSentence = new Map<string, number>()
  for (const row of rows) {
    const text = row.content
    const re = /([.!?]\s+|^|\s)([A-Z][a-z]{2,})/g
    let match = re.exec(text)
    while (match) {
      const isStart = match[1] !== " "
      const word = match[2] as string
      if (!isStart && !NAME_STOPWORDS.has(word)) {
        midSentence.set(word, (midSentence.get(word) ?? 0) + 1)
      }
      match = re.exec(text)
    }
  }
  const names = [...midSentence.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word]) => word)
    .sort()
  const people = new Set(rows.map((r) => r.author.toLowerCase()))
  return { people, names }
}

/** The name swaps for one copy: original name to replacement, stable inside the copy. */
export function nameMapFor(table: NameTable, copy: number, seed: number): Map<string, string> {
  const map = new Map<string, string>()
  let personIndex = 0
  let orgIndex = 0
  for (const name of table.names) {
    const isPerson = table.people.has(name.toLowerCase())
    const pool = isPerson ? PERSON_POOL : ORG_POOL
    const base = isPerson ? personIndex++ : orgIndex++
    const shift = hash32(name, seed + copy) % pool.length
    const picked = pool[(base + shift + copy * 3) % pool.length] as string
    // Copies past the pool size get a numeric suffix rather than a collision.
    const round = Math.floor((base + shift + copy * 3) / pool.length)
    map.set(name, round === 0 ? picked : `${picked}${round + 1}`)
  }
  return map
}

function shiftIsoDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms)) return date
  return new Date(ms + days * 86400000).toISOString().slice(0, 10)
}

function shiftNumber(digits: string, offset: number): string {
  const width = digits.length
  const value = Number(digits)
  if (!Number.isFinite(value)) return digits
  const modulus = 10 ** width
  return String((value + offset) % modulus).padStart(width, "0")
}

function reseedHex(token: string, plan: CopyPlan, seed: number): string {
  const h = hash32(token, seed + plan.copy * 7919)
  return h.toString(16).padStart(8, "0").slice(0, 8)
}

/**
 * Every identifier shape the mutation touches, in one alternation so a match
 * is handled once and a replacement is never rescanned. Order is priority:
 * ISO dates, then codes, then spaced account numbers, then SHAs, then plain
 * numbers with three or more digits.
 */
const IDENTIFIER_RE =
  /(\d{4}-\d{2}-\d{2})|([A-Z]{2,5}-\d{3,})|(\d{3,}(?: \d{2,})+)|\b((?=[0-9a-f]{8}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{8})\b|(\d{3,})/g

/**
 * Reseed one text for one copy. `memo` is the copy's memory, so the same code
 * always becomes the same code inside the copy and a different one in the next.
 */
export function reseedText(params: {
  text: string
  plan: CopyPlan
  seed: number
  names: Map<string, string>
  /** The alternation of every swapped name, built once per copy. */
  namesRe: RegExp | null
  memo: Map<string, string>
}): string {
  const { plan, seed, memo } = params
  let out = params.text.replace(
    IDENTIFIER_RE,
    (whole, iso?: string, code?: string, spaced?: string, sha?: string, number?: string) => {
      const memoKey = `${iso ? "d" : code ? "c" : spaced ? "s" : sha ? "h" : "n"}:${whole}`
      const seen = memo.get(memoKey)
      if (seen !== undefined) return seen
      let replacement: string
      if (iso) {
        replacement = shiftIsoDate(iso, plan.dayOffset)
      } else if (code) {
        const dash = code.lastIndexOf("-")
        replacement = `${code.slice(0, dash + 1)}${shiftNumber(code.slice(dash + 1), plan.numberOffset)}`
      } else if (spaced) {
        replacement = spaced
          .split(" ")
          .map((group) => shiftNumber(group, plan.numberOffset))
          .join(" ")
      } else if (sha) {
        replacement = reseedHex(sha, plan, seed)
      } else {
        replacement = shiftNumber(number as string, plan.numberOffset)
      }
      memo.set(memoKey, replacement)
      return replacement
    },
  )
  if (params.namesRe) {
    params.namesRe.lastIndex = 0
    out = out.replace(params.namesRe, (word) => params.names.get(word) ?? word)
  }
  if (!plan.decoy) {
    for (const [pattern, replacement] of SYNONYMS) out = out.replace(pattern, replacement)
  }
  return out
}

function shiftId(id: string, copy: number, stride: number): string {
  const match = /^([^0-9]*)(\d+)$/.exec(id)
  if (!match) return copy === 0 ? id : `${id}-c${copy}`
  const prefix = match[1] as string
  const value = Number(match[2])
  return copy === 0 ? id : `${prefix}${value + copy * stride}`
}

export interface MutateOptions {
  rows: CorpusRow[]
  plan: CopyPlan
  seed: number
  names: Map<string, string>
  idStride: number
  /** Where this copy's timestamps start, in milliseconds. */
  tsStartMs: number
  /** The first timestamp of the original, so offsets inside the copy hold. */
  originTsMs: number
}

/** One alternation over every name a copy swaps, so a row is scanned once. */
export function namesRegex(names: Map<string, string>): RegExp | null {
  if (names.size === 0) return null
  const alternation = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  return new RegExp(`\\b(?:${alternation})\\b`, "g")
}

/** One mutated copy of the corpus, in memory. One copy at a time, never K. */
export function mutateCopy(options: MutateOptions): CorpusRow[] {
  const memo = new Map<string, string>()
  const namesRe = namesRegex(options.names)
  return options.rows.map((row) => {
    const offset = Date.parse(row.ts) - options.originTsMs
    return {
      id: shiftId(row.id, options.plan.copy, options.idStride),
      week: row.week + options.plan.weekOffset,
      ts: new Date(options.tsStartMs + offset).toISOString(),
      authorType: row.authorType,
      author: row.author,
      kind: row.kind,
      content: reseedText({
        text: row.content,
        plan: options.plan,
        seed: options.seed,
        names: options.names,
        namesRe,
        memo,
      }),
    }
  })
}

/** The message ids the corpus's proof map points at, for `--drop-needles`. */
export function loadProofMessageIds(corpusDir: string): Set<string> {
  const path = join(corpusDir, "proof-map.json")
  if (!existsSync(path)) return new Set<string>()
  const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, { messageId?: string }>
  const ids = new Set<string>()
  for (const value of Object.values(map)) {
    if (value?.messageId) ids.add(value.messageId)
  }
  return ids
}

/**
 * The rows a mutated copy drops in `--drop-needles` mode: every proof row, and
 * the row immediately after it, which is the reply that usually restates the
 * fact. Dropping both is what makes the original corpus's probed facts unique
 * in the whole thread while everything around them still repeats.
 */
export function needleDropIndices(rows: CorpusRow[], proofIds: Set<string>): Set<number> {
  const drop = new Set<number>()
  rows.forEach((row, index) => {
    if (!proofIds.has(row.id)) return
    drop.add(index)
    if (index + 1 < rows.length) drop.add(index + 1)
  })
  return drop
}

export interface GenerateOptions {
  corpusDir: string
  /** The thread's target size in chars/4 tokens. */
  targetTokens: number
  seed?: number
  /** Fraction of copies that keep the original wording. Default 1. */
  decoyRatio?: number
  /**
   * Drop, from every MUTATED copy, the rows that prove a ledger item and the
   * reply that follows each. The original copy keeps them, so the probed facts
   * are unique in the thread while every other fact shape still repeats.
   */
  dropNeedles?: boolean
  /** Where the transcript lands. */
  threadPath: string
  /**
   * When set, a corpus directory is written beside the thread: messages.jsonl
   * (a copy of the thread), the UNCHANGED ledger, the probes with the final
   * week added as an answer key, the proof map and the persona.
   */
  corpusOutDir?: string
}

export interface GenerateResult {
  threadPath: string
  corpusDir: string | null
  rows: number
  tokens: number
  /** Copies written, the original included. */
  copies: number
  decoyCopies: number
  /** Rows each mutated copy dropped, zero unless `dropNeedles` is set. */
  droppedPerCopy: number
  finalWeek: number
  /** The week the original corpus ends at, the depth the probes ask about. */
  originalFinalWeek: number
}

/**
 * Grow a corpus to `targetTokens`. The original goes first and is written
 * byte for byte, so the needle really is at the deepest point; mutated copies
 * follow until the target is met. A target under the corpus's own size yields
 * the original alone, and the result reports the size it actually reached.
 */
export function generateScaledThread(options: GenerateOptions): GenerateResult {
  const seed = options.seed ?? 20260915
  const decoyRatio = options.decoyRatio ?? 1
  const corpus = loadCorpus(options.corpusDir)
  const rows = corpus.rows
  if (rows.length === 0) throw new Error(`corpus ${options.corpusDir} has no rows`)
  const weeksPerCopy = Math.max(...rows.map((r) => r.week))
  const maxIdNumber = rows.reduce((max, r) => {
    const match = /^([^0-9]*)(\d+)$/.exec(r.id)
    return match ? Math.max(max, Number(match[2])) : max
  }, 0)
  const idStride = 10 ** (String(maxIdNumber).length + ID_STRIDE_DIGITS)
  const nameTable = buildNameTable(rows)
  const originTsMs = Date.parse(rows[0]?.ts ?? new Date().toISOString())
  const lastTsMs = Date.parse(rows[rows.length - 1]?.ts ?? new Date().toISOString())
  const spanMs = Math.max(lastTsMs - originTsMs, 86400000)
  /** A day of quiet between one copy and the next. */
  const gapMs = 86400000

  const dropIndices = options.dropNeedles
    ? needleDropIndices(rows, loadProofMessageIds(options.corpusDir))
    : new Set<number>()
  // The original copy is never touched. Only the copies lose their needles.
  const copySource = dropIndices.size > 0 ? rows.filter((_, i) => !dropIndices.has(i)) : rows

  mkdirSync(dirname(options.threadPath), { recursive: true })
  rmSync(options.threadPath, { force: true })

  let written = 0
  let tokens = 0
  let copies = 0
  let decoyCopies = 0
  let finalWeek = 0
  const emit = (batch: CorpusRow[]): void => {
    let buffer = ""
    for (const row of batch) {
      buffer += `${JSON.stringify(row)}\n`
      tokens += estimateTokens(`${renderRow(row)}\n`)
      finalWeek = Math.max(finalWeek, row.week)
    }
    appendFileSync(options.threadPath, buffer)
    written += batch.length
  }

  emit(rows)
  copies = 1
  while (tokens < options.targetTokens) {
    const plan = planCopy({ copy: copies, seed, weeksPerCopy, decoyRatio })
    if (plan.decoy) decoyCopies++
    const tsStartMs = originTsMs + copies * (spanMs + gapMs)
    emit(
      mutateCopy({
        rows: copySource,
        plan,
        seed,
        names: nameMapFor(nameTable, copies, seed),
        idStride,
        tsStartMs,
        originTsMs,
      }),
    )
    copies++
  }

  let corpusDir: string | null = null
  if (options.corpusOutDir) {
    corpusDir = options.corpusOutDir
    mkdirSync(corpusDir, { recursive: true })
    // messages.jsonl is the thread. It is copied rather than linked so the
    // corpus directory stands on its own when it is archived.
    writeFileSync(join(corpusDir, "messages.jsonl"), readFileSync(options.threadPath))
    writeFileSync(join(corpusDir, "ledger.json"), JSON.stringify(corpus.ledger, null, 2))
    // The ledger is NOT mutated: the probes still ask about the original,
    // deepest copy. The only thing added is the final week as an answer key,
    // so a resume at the end of the scaled thread has an expected answer.
    const deepest = String(weeksPerCopy)
    const probes: Probe[] = corpus.probes.map((probe) => ({
      ...probe,
      answer_at_week: {
        ...probe.answer_at_week,
        [String(finalWeek)]: probe.answer_at_week[deepest] ?? "unknown",
      },
    }))
    writeFileSync(join(corpusDir, "probes.json"), JSON.stringify(probes, null, 2))
    const proofMapPath = join(options.corpusDir, "proof-map.json")
    try {
      writeFileSync(join(corpusDir, "proof-map.json"), readFileSync(proofMapPath))
    } catch {
      // A corpus without a proof map still measures everything but the needle.
    }
    writeFileSync(join(corpusDir, "persona.md"), `${corpus.persona}\n`)
  }

  return {
    threadPath: options.threadPath,
    corpusDir,
    rows: written,
    tokens,
    copies,
    decoyCopies,
    droppedPerCopy: dropIndices.size,
    finalWeek,
    originalFinalWeek: weeksPerCopy,
  }
}
