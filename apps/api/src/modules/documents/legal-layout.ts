// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The classic legal layout of a rich_text body (`page.layout = "legal"`): the
// way a contract is printed in France and most of Europe. A4, justified
// Liberation Serif 11 pt on 14.5 pt, margins of 71 pt, a title, the parties
// ("Entre les soussignés"), the recitals ("Préambule"), articles numbered by
// the renderer (Article 1, 1.1, 1.1.1, (a), (i)), references that follow a
// moved clause, defined terms, annexes on their own pages, a table of contents
// from 10 pages, a running header, "Page X sur Y", and a signature page.
//
// Host only. It emits the same DrawCommand list as the standard layout and is
// replayed by the same replayer (pdf/replay.ts), which serves the Times family
// from the embedded Liberation Serif faces. Words are measured with that face's
// own metrics and placed one by one, so a justified line needs no word spacing
// operator (a two-byte font has none that works). No hyphenation.
//
// Numbers are computed, never typed: article numbers, references, the table of
// contents and page numbers come only from here. A body is refused, naming each
// problem, when a reference points at nothing or at a clause a condition hides
// (broken_reference), when a clause cites one of this document's own articles
// by a typed number (typed_reference), when a clause's text starts with a
// number (numbered_clause), and when no face can draw a character
// (character_not_drawable).
//
// Two passes: the first numbers the visible clauses and resolves references;
// the second paginates, then writes the table of contents' page numbers and
// the header and footer. The table of contents' length does not depend on its
// page numbers, so pagination changes only the numbers it shows.

import { type DrawCommand, MAX_COMMANDS, type TextRun } from "@liaison/shared"
import {
  faceDraws,
  faceTextWidth,
  needsCjkFace,
  type UnicodeFace,
} from "~/modules/pdf/unicode-fonts"
import type { RichTextBlank, RichTextBody } from "./rich-text"

// ---------------------------------------------------------------------------
// What the rich-text module hands over
// ---------------------------------------------------------------------------

export type LegalRefusal =
  | "body_invalid"
  | "broken_reference"
  | "typed_reference"
  | "numbered_clause"
  | "character_not_drawable"
  | "document_too_large"

/** The fill of placeholders and conditions, owned by rich-text.ts. */
export interface LegalFill {
  /** Text with its placeholders resolved: record values, and blanks as grey runs. */
  runs(text: string, bold: boolean): TextRun[]
  /** Whether a block's `when` holds against the record. */
  blockPrints(when: unknown): boolean
  /** Throw the rich-text error with this code. */
  refuse(code: LegalRefusal, message: string): never
  readonly blanks: RichTextBlank[]
}

export interface LegalLaidOut {
  commands: DrawCommand[]
  blanks: RichTextBlank[]
  pageCount: number
  /** The body's text, unit by unit, numbers and references resolved: what a freeze compares. */
  intended: string[]
  /** The text the body drew, header, footer and contents left out. */
  bodyText: string
  /** Each contents entry's printed page against the page its heading landed on. */
  toc: Array<{ label: string; printedPage: number; headingPage: number }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 71
const BODY_SIZE = 11
const LEADING = 14.5
const TITLE_SIZE = 16
const ANNEX_TITLE_SIZE = 13
const FURNITURE_SIZE = 8.5
const HANG = 34
const SUB_HANG = 24
/** A body from this many pages gets a table of contents without asking. */
const TOC_FROM_PAGES = 10
const MAX_PAGES = 2000
const GREY = { r: 0.55, g: 0.55, b: 0.55 }
const FURNITURE_GREY = { r: 0.35, g: 0.35, b: 0.35 }
/** `{{ref:id}}` and `{{def:Term}}`, the two inline forms of the legal layout. */
export const LEGAL_INLINE_RE = /\{\{\s*(ref|def)\s*:\s*([^{}]+?)\s*\}\}/g

const FONT_REF: Record<"serif" | "serifBold" | "serifItalic", string> = {
  serif: "serif",
  serifBold: "serifBold",
  serifItalic: "serifItalic",
}

type Lang = "en" | "fr"

const WORDS: Record<
  Lang,
  {
    between: string
    hereinafter: (term: string) => string
    onePart: string
    otherPart: string
    and: string
    inPresence: string
    whereas: string
    agreed: string
    article: string
    articleRef: string
    annex: string
    annexRef: string
    annexArticleRef: (article: string, annex: string) => string
    contents: string
    page: (x: number, y: number) => string
    confidential: string
    doneAt: string
    signed: string
    signaturePage: string
    capacity: (c: string) => string
    company: {
      form: (form: string) => string
      capital: (c: string) => string
      seat: (s: string) => string
      rcs: (city: string | null, number: string | null) => string
      represented: (r: string) => string
    }
    personSeat: (s: string) => string
    defined: (t: string) => string
    means: string
  }
> = {
  fr: {
    between: "Entre les soussignés :",
    hereinafter: (t) => `ci-après « ${t} »,`,
    onePart: "D'une part,",
    otherPart: "D'autre part,",
    and: "Et :",
    inPresence: "En présence de :",
    whereas: "Préambule",
    agreed: "Il a été convenu ce qui suit :",
    article: "Article",
    articleRef: "article",
    annex: "Annexe",
    annexRef: "annexe",
    annexArticleRef: (a, x) => `article ${a} de l'annexe ${x}`,
    contents: "Sommaire",
    page: (x, y) => `Page ${x} sur ${y}`,
    confidential: "Confidentiel",
    doneAt: "Fait à",
    signed: "Signé électroniquement",
    signaturePage: "Page de signature",
    capacity: (c) => `en qualité de ${c}`,
    company: {
      form: (f) => `, ${f}`,
      capital: (c) => ` au capital de ${c}`,
      seat: (s) => `, dont le siège social est situé ${s}`,
      rcs: (city, n) =>
        `, immatriculée au registre du commerce et des sociétés${city ? ` de ${city}` : ""}${n ? ` sous le numéro ${n}` : ""}`,
      represented: (r) => `, représentée par ${r}`,
    },
    personSeat: (s) => `, demeurant ${s}`,
    defined: (t) => `« ${t} »`,
    means: "désigne",
  },
  en: {
    between: "Between:",
    hereinafter: (t) => `hereinafter "${t}",`,
    onePart: "Of the one part,",
    otherPart: "Of the other part,",
    and: "And:",
    inPresence: "In the presence of:",
    whereas: "Whereas",
    agreed: "It is agreed as follows:",
    article: "Clause",
    articleRef: "clause",
    annex: "Schedule",
    annexRef: "schedule",
    annexArticleRef: (a, x) => `clause ${a} of schedule ${x}`,
    contents: "Contents",
    page: (x, y) => `Page ${x} of ${y}`,
    confidential: "Confidential",
    doneAt: "Done at",
    signed: "Signed electronically",
    signaturePage: "Signature page",
    capacity: (c) => `acting as ${c}`,
    company: {
      form: (f) => `, a ${f}`,
      capital: (c) => ` with a share capital of ${c}`,
      seat: (s) => `, whose registered office is at ${s}`,
      rcs: (city, n) =>
        `, registered with the Trade and Companies Register${city ? ` of ${city}` : ""}${n ? ` under number ${n}` : ""}`,
      represented: (r) => `, represented by ${r}`,
    },
    personSeat: (s) => `, residing at ${s}`,
    defined: (t) => t,
    means: "means",
  },
}

// ---------------------------------------------------------------------------
// Block shapes (validated by rich-text.ts's schema before they reach here)
// ---------------------------------------------------------------------------

type When = { when?: unknown }
type Block = RichTextBody["blocks"][number]
type ArticleBlock = Extract<Block, { type: "article" }>
type AnnexBlock = Extract<Block, { type: "annex" }>
type AnnexInner = AnnexBlock["blocks"][number]
type AnyLegal = Block | AnnexInner

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

function letter(n: number): string {
  let s = ""
  let k = n
  while (k > 0) {
    k -= 1
    s = String.fromCharCode(97 + (k % 26)) + s
    k = Math.floor(k / 26)
  }
  return s
}

function roman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ]
  let k = n
  let s = ""
  for (const [v, r] of table) {
    while (k >= v) {
      s += r
      k -= v
    }
  }
  return s
}

/** Article counters for one numbering scope (the body, or one annex). */
class Counters {
  private readonly c = [0, 0, 0, 0, 0, 0]
  private last = 0

  /** The next article's number at `level`, as printed in a reference ("6.2(c)"). */
  next(level: number, where: string, fill: LegalFill): { label: string; own: string } {
    // (a) may sit right under an article or a 1.1: a level-4 clause needs any clause before it.
    if (level > this.last + 1 && !(level === 4 && this.last >= 1)) {
      fill.refuse(
        "body_invalid",
        `${where} is at level ${level} with no clause at level ${level - 1} before it; give it level ${this.last + 1} or less.`,
      )
    }
    this.c[level] = (this.c[level] ?? 0) + 1
    for (let l = level + 1; l <= 5; l++) this.c[l] = 0
    this.last = level
    const num = (l: number) => this.c[l] ?? 0
    const dotted = [1, 2, 3]
      .filter((l) => l <= Math.min(level, 3) && num(l) > 0)
      .map((l) => String(num(l)))
      .join(".")
    let label = dotted
    if (level >= 4) label += `(${letter(num(4))})`
    if (level >= 5) label += `(${roman(num(5))})`
    const own = level === 4 ? `(${letter(num(4))})` : level === 5 ? `(${roman(num(5))})` : dotted
    return { label, own }
  }
}

/** A typed reference to one of this document's articles, unless a statute name follows. */
const TYPED_REF_RE = /(?<![\p{L}\p{N}])(articles?|art\.|clauses?)\s+(\d+(?:\.\d+)*)/giu
const STATUTE_AFTER_RE =
  /^\s*,?\s*(?:(?:du|de la|de l['’]|des|of the|of|under the|under)\s+)?(?:code|loi|règlement|reglement|décret|decret|directive|regulation|act|traité|treaty|convention|ordonnance|C\.\s?(?:civ|com|trav|pén|pen|conso)|CGI|RGPD|GDPR|CPC)/iu
/** A clause's text that starts with a number: numbers are the renderer's. */
const NUMBERED_START_RE =
  /^\s*(?:(?:article|art\.|clause)\s+\d|\d+(?:\.\d+)+\.?\s|\d+\s*[.)–-]\s|\((?:\d+|[a-z]|[ivxlc]+)\)\s)/iu

function withoutInline(text: string): string {
  return text.replace(LEGAL_INLINE_RE, " ").replace(/\{\{[^{}]*\}\}/g, " ")
}

// ---------------------------------------------------------------------------
// Measuring with the embedded faces
// ---------------------------------------------------------------------------

type Style = "serif" | "serifBold" | "serifItalic"

interface Piece {
  text: string
  style: Style
  grey: boolean
}

/** A word: pieces drawn side by side with no space between them. */
type Word = Piece[]

const drawableCache = new Map<string, boolean>()

function drawable(face: UnicodeFace, ch: string): boolean {
  const key = `${face}:${ch}`
  const hit = drawableCache.get(key)
  if (hit !== undefined) return hit
  const ok = faceDraws(face, ch)
  drawableCache.set(key, ok)
  return ok
}

/** The width of a piece as the replayer draws it: CJK characters in the CJK face, the rest in its own. */
function pieceWidth(piece: Piece, size: number): number {
  let width = 0
  let run = ""
  let cjk = false
  const flush = () => {
    if (run !== "") width += faceTextWidth(cjk ? "cjk" : piece.style, run, size)
    run = ""
  }
  for (const ch of piece.text) {
    const c = needsCjkFace(ch)
    if (c !== cjk) {
      flush()
      cjk = c
    }
    run += ch
  }
  flush()
  return width
}

function checkDrawable(pieces: readonly Piece[], fill: LegalFill): void {
  for (const piece of pieces) {
    for (const ch of piece.text) {
      if (ch === "\n" || ch === " ") continue
      const face: UnicodeFace = needsCjkFace(ch) ? "cjk" : piece.style
      if (!drawable(face, ch)) {
        const cp = `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`
        fill.refuse(
          "character_not_drawable",
          `No font of this layout can draw the character "${ch}" (${cp}) in "${piece.text.slice(0, 60)}". Replace it; nothing was printed.`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// French spaces
// ---------------------------------------------------------------------------

const NBSP = " "
const NNBSP = " "

/**
 * French typography: a non-breaking space before ; ! ? (narrow) and : (full), and inside « ».
 * Applied to the whole unit's text so a mark right after a placeholder is spaced too.
 */
function frenchSpaces(pieces: Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p }))
  for (let i = 0; i < out.length; i++) {
    const p = out[i] as Piece
    let t = p.text
    t = t.replace(/«[   ]*/g, `«${NBSP}`)
    t = t.replace(/[   ]*»/g, `${NBSP}»`)
    t = t.replace(/[   ]+([;!?])/g, `${NNBSP}$1`)
    t = t.replace(/[   ]+:(?=\s|$)/g, `${NBSP}:`)
    t = t.replace(/([\p{L}\p{N})»])([;!?])/gu, `$1${NNBSP}$2`)
    t = t.replace(/([\p{L})»])(:)(?=\s|$)/gu, `$1${NBSP}$2`)
    // A mark that opens this piece, right after the previous piece's last character.
    const prev = out[i - 1]
    if (prev && /^[;!?]/.test(t) && /[^\s  ]$/.test(prev.text)) t = `${NNBSP}${t}`
    else if (prev && /^:(?=\s|$)/.test(t) && /[^\s  ]$/.test(prev.text)) t = `${NBSP}${t}`
    p.text = t
  }
  return out
}

/** Pieces into words: split on ordinary spaces only (a non-breaking space joins). */
function wordsOf(pieces: readonly Piece[]): Word[][] {
  const lines: Word[][] = [[]]
  let word: Word = []
  const endWord = () => {
    if (word.length > 0) lines[lines.length - 1]?.push(word)
    word = []
  }
  for (const piece of pieces) {
    let chunk = ""
    const flush = () => {
      if (chunk !== "") word.push({ ...piece, text: chunk })
      chunk = ""
    }
    for (const ch of piece.text) {
      if (ch === " " || ch === "\t") {
        flush()
        endWord()
      } else if (ch === "\n") {
        flush()
        endWord()
        lines.push([])
      } else chunk += ch
    }
    flush()
  }
  endWord()
  return lines
}

// ---------------------------------------------------------------------------
// Units: what the paginator places
// ---------------------------------------------------------------------------

type Align = "justify" | "left" | "center"

interface Unit {
  pieces: Piece[]
  size: number
  leading: number
  align: Align
  indent: number
  /** A label in the hanging margin of the first line ("1.1", "(a)"). */
  label?: Piece
  hang: number
  before: number
  after: number
  keepWithNext: boolean
  pageBreakBefore: boolean
  /** A contents entry: this unit's first drawn command is the heading it points at. */
  tocLabel?: string
  /** Table of contents lines: drawn, but neither in the freeze compare nor the body text. */
  isToc: boolean
  /** The index of the contents entry this line prints, for its page number. */
  tocEntry?: number
}

interface Line {
  words: Word[]
  widths: number[]
  last: boolean
}

// ---------------------------------------------------------------------------
// Building the units from the body
// ---------------------------------------------------------------------------

interface Numbered {
  /** id → the reference text ("article 6.2(c)"). */
  refs: Map<string, string>
  /** Every id declared, visible or not. */
  declared: Set<string>
}

class Builder {
  readonly units: Unit[] = []
  readonly tocEntries: string[] = []
  /** The entries the contents print: the previous build's headings, known before this one starts. */
  contents: string[] = []
  private readonly words: (typeof WORDS)[Lang]
  private readonly defs = new Map<string, string>()

  constructor(
    private readonly body: RichTextBody,
    private readonly fill: LegalFill,
    private readonly lang: Lang,
    private readonly numbered: Numbered,
    private readonly title: string | undefined,
  ) {
    this.words = WORDS[lang]
  }

  private pieces(runs: readonly TextRun[], style?: Style): Piece[] {
    const out = runs
      .filter((r) => r.text !== "")
      .map((r) => ({
        text: r.text,
        style: style ?? (r.bold ? ("serifBold" as const) : ("serif" as const)),
        grey: r.color === "placeholder",
      }))
    const spaced = this.lang === "fr" ? frenchSpaces(out) : out
    checkDrawable(spaced, this.fill)
    return spaced
  }

  /** A legal text: placeholders filled, `{{ref:id}}` and `{{def:Term}}` resolved. */
  private text(text: string, bold = false): TextRun[] {
    const out: TextRun[] = []
    let last = 0
    for (const m of text.matchAll(LEGAL_INLINE_RE)) {
      const index = m.index ?? 0
      if (index > last) out.push(...this.fill.runs(text.slice(last, index), bold))
      const kind = m[1]
      const key = (m[2] ?? "").trim()
      if (kind === "ref") out.push({ text: this.numbered.refs.get(key) ?? key, bold })
      else out.push({ text: this.defs.get(defKey(key)) ?? key, bold: true })
      last = index + m[0].length
    }
    if (last < text.length) out.push(...this.fill.runs(text.slice(last), bold))
    return out
  }

  private unit(pieces: Piece[], u: Partial<Unit> = {}): Unit {
    const unit: Unit = {
      pieces,
      size: BODY_SIZE,
      leading: LEADING,
      align: "justify",
      indent: 0,
      hang: 0,
      before: 0,
      after: 6,
      keepWithNext: false,
      pageBreakBefore: false,
      isToc: false,
      ...u,
    }
    this.units.push(unit)
    return unit
  }

  /** The defined terms: a party's `defined_as` and a definitions block's terms, as printed. */
  collectDefinitions(blocks: readonly AnyLegal[]): void {
    for (const b of blocks) {
      if (!this.fill.blockPrints((b as When).when)) continue
      if (b.type === "parties") {
        for (const g of b.groups)
          for (const item of g.items) {
            const shown = runsText(this.fill.runs(item.defined_as, false))
            this.defs.set(defKey(shown), this.words.defined(shown))
          }
      } else if (b.type === "definitions") {
        for (const item of b.items) {
          const shown = runsText(this.fill.runs(item.term, false))
          this.defs.set(defKey(shown), this.words.defined(shown))
        }
      } else if (b.type === "annex") this.collectDefinitions(b.blocks)
    }
  }

  hasDefinition(term: string): boolean {
    return this.defs.has(defKey(term))
  }

  build(withToc: boolean): void {
    const blocks = this.body.blocks
    if (this.title) {
      this.unit(this.pieces([{ text: this.title, bold: true }]), {
        size: TITLE_SIZE,
        leading: TITLE_SIZE * 1.3,
        align: "center",
        after: 18,
      })
    }
    const explicitToc = blocks.some((b) => b.type === "toc" && this.fill.blockPrints(b.when))
    // Without a toc block, contents go after the recitals, else after the parties, else first.
    const autoAfter = withToc && !explicitToc ? autoTocIndex(blocks, this.fill) : -2
    if (autoAfter === -1) this.toc()
    let scope = new Counters()
    let annexes = 0
    blocks.forEach((block, i) => {
      if (!this.fill.blockPrints(block.when)) return
      switch (block.type) {
        case "toc":
          if (withToc) this.toc()
          break
        case "annex": {
          annexes += 1
          this.annex(block, annexes)
          break
        }
        default:
          scope = this.leaf(block, scope, null)
      }
      if (i === autoAfter) this.toc()
    })
  }

  private toc(): void {
    this.unit(this.pieces([{ text: this.words.contents, bold: true }]), {
      align: "center",
      before: 0,
      after: 12,
      keepWithNext: true,
      pageBreakBefore: true,
      isToc: true,
    })
    this.contents.forEach((entry, i) => {
      this.unit(this.pieces([{ text: entry }]), {
        align: "left",
        after: 2,
        isToc: true,
        tocEntry: i,
      })
    })
    // The body after the contents starts on a new page.
    this.breakNext = true
  }

  private breakNext = false

  private push(pieces: Piece[], u: Partial<Unit>): void {
    if (this.breakNext) {
      u.pageBreakBefore = true
      this.breakNext = false
    }
    this.unit(pieces, u)
  }

  private leaf(block: AnyLegal, scope: Counters, annex: number | null): Counters {
    const w = this.words
    switch (block.type) {
      case "heading": {
        const size = block.level === 1 || block.level === undefined ? 13 : 12
        this.push(this.pieces(this.text(block.text, true)), {
          size,
          leading: size * 1.3,
          align: "left",
          before: 10,
          after: 6,
          keepWithNext: true,
        })
        break
      }
      case "paragraph": {
        this.push(this.pieces(this.text(block.text)), {})
        break
      }
      case "spacer": {
        this.push([], { before: block.height, after: 0 })
        break
      }
      case "parties":
        this.parties(block)
        break
      case "recitals":
        this.recitals(block)
        break
      case "definitions": {
        for (const item of block.items) {
          const term = this.pieces(this.fill.runs(item.term, true))
          const quoted =
            this.lang === "fr"
              ? [{ text: "« ", style: "serifBold" as const, grey: false }, ...term]
              : [{ text: "“", style: "serifBold" as const, grey: false }, ...term]
          quoted.push({ text: this.lang === "fr" ? " »" : "”", style: "serifBold", grey: false })
          const pieces = this.pieces([
            ...quoted.map((p) => ({
              text: p.text,
              bold: true,
              ...(p.grey ? { color: "placeholder" } : {}),
            })),
            { text: ` ${w.means} ` },
            ...this.text(item.text),
          ])
          this.push(pieces, { indent: 0, after: 4 })
        }
        break
      }
      case "article":
        this.article(block, scope, annex)
        break
      case "signature_block":
        this.signature(block)
        break
      default:
        break
    }
    return scope
  }

  private article(block: ArticleBlock, scope: Counters, annex: number | null): void {
    const where = block.id ? `The clause "${block.id}"` : "A clause"
    const { label, own } = scope.next(block.level, where, this.fill)
    const w = this.words
    const body = block.text.trim() === "" ? [] : this.text(block.text)
    if (block.level === 1) {
      const heading = block.heading ? this.text(block.heading, true) : []
      const head = [
        { text: `${w.article} ${label}`, bold: true },
        ...(heading.length > 0 ? [{ text: " – ", bold: true }, ...heading] : []),
      ]
      const tocLabel = runsText(head)
      if (annex === null) this.tocEntries.push(tocLabel)
      this.push(this.pieces(head), {
        align: "left",
        before: 10,
        after: 5,
        keepWithNext: true,
        ...(annex === null ? { tocLabel } : {}),
      })
      if (body.length > 0) this.push(this.pieces(body), {})
      return
    }
    const indent = block.level <= 3 ? 0 : block.level === 4 ? HANG : HANG + SUB_HANG
    const hang = block.level <= 3 ? HANG + (block.level === 3 ? 8 : 0) : SUB_HANG
    const heading = block.heading ? [...this.text(block.heading, true), { text: " " }] : []
    this.push(this.pieces([...heading, ...body]), {
      indent,
      hang,
      label: { text: own, style: "serif", grey: false },
    })
  }

  private parties(block: Extract<Block, { type: "parties" }>): void {
    const w = this.words
    this.push(this.pieces(this.fill.runs(block.lead ?? w.between, true)), {
      align: "left",
      after: 8,
      keepWithNext: true,
    })
    block.groups.forEach((group, gi) => {
      if (gi > 0)
        this.push(this.pieces([{ text: w.and, bold: true }]), {
          align: "left",
          before: 4,
          after: 8,
          keepWithNext: true,
        })
      for (const item of group.items) {
        const name = this.fill.runs(item.name, true)
        const parts: string[] = []
        if (item.kind === "company") {
          if (item.form) parts.push(w.company.form(item.form))
          if (item.capital) parts.push(w.company.capital(item.capital))
          if (item.seat) parts.push(w.company.seat(item.seat))
          if (item.rcs_city || item.rcs_number)
            parts.push(w.company.rcs(item.rcs_city ?? null, item.rcs_number ?? null))
          if (item.represented_by) parts.push(w.company.represented(item.represented_by))
          if (item.capacity) parts.push(`, ${w.capacity(item.capacity)}`)
        } else if (item.seat) parts.push(w.personSeat(item.seat))
        parts.push(",")
        this.push(this.pieces([...name, ...this.fill.runs(parts.join(""), false)]), { after: 4 })
        this.push(this.pieces(this.fill.runs(w.hereinafter(item.defined_as), false)), {
          align: "left",
          after: 4,
        })
      }
      const side = group.side ?? (gi === 0 ? "one" : "other")
      this.push(this.pieces([{ text: side === "one" ? w.onePart : w.otherPart }]), {
        align: "left",
        after: 8,
      })
    })
    if (block.in_presence) {
      this.push(
        this.pieces([{ text: `${w.inPresence} `, bold: true }, ...this.text(block.in_presence)]),
        { after: 8 },
      )
    }
  }

  private recitals(block: Extract<Block, { type: "recitals" }>): void {
    const w = this.words
    this.push(this.pieces([{ text: w.whereas, bold: true }]), {
      align: "left",
      before: 10,
      after: 6,
      keepWithNext: true,
    })
    block.items.forEach((item, i) => {
      this.push(this.pieces(this.text(item)), {
        hang: HANG,
        label: { text: `(${String.fromCharCode(65 + (i % 26))})`, style: "serif", grey: false },
      })
    })
    this.push(this.pieces(this.fill.runs(block.closing ?? w.agreed, true)), {
      align: "left",
      before: 6,
      after: 10,
    })
  }

  private annex(block: AnnexBlock, n: number): void {
    const w = this.words
    const head = [
      { text: `${w.annex} ${n}`, bold: true },
      { text: " – ", bold: true },
      ...this.text(block.title, true),
    ]
    const tocLabel = runsText(head)
    this.tocEntries.push(tocLabel)
    this.push(this.pieces(head), {
      size: ANNEX_TITLE_SIZE,
      leading: ANNEX_TITLE_SIZE * 1.3,
      align: "center",
      after: 14,
      keepWithNext: true,
      pageBreakBefore: true,
      tocLabel,
    })
    let scope = new Counters()
    for (const inner of block.blocks) {
      if (!this.fill.blockPrints((inner as When).when)) continue
      scope = this.leaf(inner, scope, n)
    }
  }

  private signature(block: Extract<Block, { type: "signature_block" }>): void {
    const w = this.words
    this.push(this.pieces([{ text: w.signaturePage, bold: true }]), {
      align: "center",
      after: 16,
      keepWithNext: true,
      pageBreakBefore: true,
    })
    this.push(this.pieces([{ text: `${w.doneAt} ` }, ...this.fill.runs(block.place, false)]), {
      align: "left",
      after: 18,
    })
    for (const line of block.lines) {
      this.push(this.pieces(this.fill.runs(line.party, true)), {
        align: "left",
        after: 2,
        keepWithNext: true,
      })
      this.push(this.pieces(this.fill.runs(line.name, false)), {
        align: "left",
        after: 2,
        keepWithNext: true,
      })
      this.push(this.pieces(this.fill.runs(w.capacity(line.capacity), false)), {
        align: "left",
        after: 2,
        keepWithNext: true,
      })
      this.push(this.pieces([{ text: w.signed }], "serifItalic"), { align: "left", after: 22 })
    }
  }
}

function runsText(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join("")
}

/** A defined term's key: case and a leading article left out ("la Société" is "société"). */
function defKey(term: string): string {
  return term
    .trim()
    .replace(/^(?:la|le|les|l['’]|the)\s*/iu, "")
    .replace(/[«»“”"]/g, "")
    .trim()
    .toLowerCase()
}

/** Where automatic contents go: after the recitals, else the parties; -1 at the start. */
function autoTocIndex(blocks: RichTextBody["blocks"], fill: LegalFill): number {
  let at = -1
  blocks.forEach((b, i) => {
    if (!fill.blockPrints(b.when)) return
    if (b.type === "recitals") at = i
    else if (b.type === "parties" && !blocks.slice(0, i).some((x) => x.type === "recitals"))
      at = Math.max(at, i)
  })
  return at
}

// ---------------------------------------------------------------------------
// Pass 1: numbering, references, the clauses' own words
// ---------------------------------------------------------------------------

function numberClauses(body: RichTextBody, fill: LegalFill, lang: Lang): Numbered {
  const w = WORDS[lang]
  const refs = new Map<string, string>()
  const declared = new Set<string>()
  const declare = (b: AnyLegal) => {
    if ((b.type === "article" || b.type === "annex") && b.id) declared.add(b.id)
    if (b.type === "annex") for (const inner of b.blocks) declare(inner)
  }
  for (const b of body.blocks) declare(b)

  // Numbering only counts the clauses that print.
  const top = new Counters()
  let annexes = 0
  for (const b of body.blocks) {
    if (!fill.blockPrints(b.when)) continue
    if (b.type === "article") {
      const { label } = top.next(b.level, b.id ? `The clause "${b.id}"` : "A clause", fill)
      if (b.id) refs.set(b.id, `${w.articleRef} ${label}`)
    } else if (b.type === "annex") {
      annexes += 1
      if (b.id) refs.set(b.id, `${w.annexRef} ${annexes}`)
      const scope = new Counters()
      for (const inner of b.blocks) {
        if (!fill.blockPrints((inner as When).when) || inner.type !== "article") continue
        const { label } = scope.next(
          inner.level,
          inner.id ? `The clause "${inner.id}"` : "A clause",
          fill,
        )
        if (inner.id) refs.set(inner.id, w.annexArticleRef(label, String(annexes)))
      }
    }
  }
  return { refs, declared }
}

/** The texts of the visible blocks, with where each one is, for the checks of pass 1. */
function visibleTexts(
  body: RichTextBody,
  fill: LegalFill,
): Array<{ where: string; text: string; block: AnyLegal }> {
  const out: Array<{ where: string; text: string; block: AnyLegal }> = []
  const visit = (b: AnyLegal, where: string) => {
    if (!fill.blockPrints((b as When).when)) return
    const add = (text: string | undefined, suffix = "") => {
      if (text) out.push({ where: `${where}${suffix}`, text, block: b })
    }
    switch (b.type) {
      case "article":
        add(b.heading, " (heading)")
        add(b.text)
        break
      case "paragraph":
      case "heading":
        add(b.text)
        break
      case "recitals":
        b.items.forEach((t, i) => {
          add(t, ` (${String.fromCharCode(65 + (i % 26))})`)
        })
        break
      case "definitions":
        for (const item of b.items) add(item.text, ` ("${item.term}")`)
        break
      case "parties":
        add(b.in_presence)
        break
      case "annex":
        add(b.title, " (title)")
        b.blocks.forEach((inner, i) => {
          visit(inner, `${where}, block ${i + 1}`)
        })
        break
      default:
        break
    }
  }
  body.blocks.forEach((b, i) => {
    visit(b, b.type === "article" && b.id ? `clause "${b.id}"` : `block ${i + 1}`)
  })
  return out
}

function checkClauses(
  body: RichTextBody,
  fill: LegalFill,
  numbered: Numbered,
  builder: Builder,
): void {
  const texts = visibleTexts(body, fill)
  // A clause, a clause's heading or a heading whose text starts with a number: the renderer
  // numbers clauses, so a typed "1. Scope" would print a number nothing keeps true.
  const starts = texts.filter(
    (t) =>
      (t.block.type === "article" || t.block.type === "heading") &&
      NUMBERED_START_RE.test(`${withoutInline(t.text)} `),
  )
  if (starts.length > 0) {
    fill.refuse(
      "numbered_clause",
      `A clause or a heading starts with a number, and numbers are computed: ${starts
        .map((t) => `${t.where} ("${t.text.trim().slice(0, 30)}")`)
        .join(", ")}. Remove the typed number; the layout numbers each clause.`,
    )
  }
  // References to nothing, or to a clause a condition hides; terms nobody defined.
  const broken: string[] = []
  for (const t of texts) {
    for (const m of t.text.matchAll(LEGAL_INLINE_RE)) {
      const key = (m[2] ?? "").trim()
      if (m[1] === "ref" && !numbered.refs.has(key)) {
        broken.push(
          numbered.declared.has(key)
            ? `{{ref:${key}}} in ${t.where} points at a clause a condition hides`
            : `{{ref:${key}}} in ${t.where} points at no clause`,
        )
      }
      if (m[1] === "def" && !builder.hasDefinition(key))
        broken.push(`{{def:${key}}} in ${t.where} names a term no party or definition defines`)
    }
  }
  if (broken.length > 0) {
    fill.refuse(
      "broken_reference",
      `${broken.length} reference(s) lead nowhere: ${broken.join("; ")}. Point each one at a clause that prints, or remove it.`,
    )
  }
  // A typed "article 6" where 6 is an article here, unless a statute name follows.
  const own = new Set<string>()
  for (const v of numbered.refs.values()) {
    const n = /(\d+(?:\.\d+)*)/.exec(v)?.[1]
    if (n && !v.includes(" de l'annexe ") && !v.includes(" of schedule ")) own.add(n)
  }
  const typed: string[] = []
  for (const t of texts) {
    if (t.block.type === "article" && t.block.citation === true) continue
    const plain = withoutInline(t.text)
    for (const m of plain.matchAll(TYPED_REF_RE)) {
      const n = m[2] ?? ""
      const after = plain.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60)
      if (!own.has(n) || STATUTE_AFTER_RE.test(after)) continue
      typed.push(`"${m[0]}" in ${t.where}`)
    }
  }
  if (typed.length > 0) {
    fill.refuse(
      "typed_reference",
      `A clause cites this document's own articles by a typed number: ${typed.join(", ")}. Use {{ref:<clause id>}} so the number follows the clause, or mark the clause as a citation when it cites another text.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Pass 2: pagination and drawing
// ---------------------------------------------------------------------------

class Pager {
  readonly commands: DrawCommand[] = []
  readonly intended: string[] = []
  private readonly body: string[] = []
  readonly headingAt: Array<{ label: string; page: number }> = []
  readonly tocLines: Array<{ entry: number; page: number; y: number; size: number }> = []
  page = -1
  private y = 0
  private readonly contentWidth = A4.width - 2 * MARGIN

  constructor(
    private readonly fill: LegalFill,
    title: string | undefined,
  ) {
    this.commands.push({
      op: "setMetadata",
      ...(title ? { title: title.slice(0, 300) } : {}),
      producer: "Liaison",
      creator: "Liaison",
    })
    this.commands.push({ op: "embedFont", ref: FONT_REF.serif, standardFont: "TimesRoman" })
    this.commands.push({ op: "embedFont", ref: FONT_REF.serifBold, standardFont: "TimesRomanBold" })
    this.commands.push({
      op: "embedFont",
      ref: FONT_REF.serifItalic,
      standardFont: "TimesRomanItalic",
    })
    this.newPage()
  }

  get bodyText(): string {
    return this.body.join(" ")
  }

  private atTop(): boolean {
    return this.y >= A4.height - MARGIN
  }

  newPage(): void {
    this.page += 1
    if (this.page >= MAX_PAGES)
      this.fill.refuse(
        "document_too_large",
        `The document would run past ${MAX_PAGES} pages; nothing was printed`,
      )
    this.commands.push({ op: "addPage", width: A4.width, height: A4.height })
    this.y = A4.height - MARGIN
  }

  push(cmd: DrawCommand): void {
    if (this.commands.length >= MAX_COMMANDS - 1000)
      this.fill.refuse(
        "document_too_large",
        "The document has too much content to print; nothing was printed",
      )
    this.commands.push(cmd)
  }

  lines(unit: Unit): Line[] {
    const width = this.contentWidth - unit.indent - unit.hang
    const space = faceTextWidth("serif", " ", unit.size)
    const out: Line[] = []
    for (const hard of wordsOf(unit.pieces)) {
      let cur: Word[] = []
      let curW: number[] = []
      let used = 0
      const flush = (last: boolean) => {
        out.push({ words: cur, widths: curW, last })
        cur = []
        curW = []
        used = 0
      }
      for (const word of hard) {
        for (const part of splitLongWord(word, width, unit.size)) {
          const ww = part.reduce((n, p) => n + pieceWidth(p, unit.size), 0)
          const need = cur.length === 0 ? ww : used + space + ww
          if (cur.length > 0 && need > width + 0.01) flush(false)
          used = cur.length === 0 ? ww : used + space + ww
          cur.push(part)
          curW.push(ww)
        }
      }
      flush(true)
    }
    return out
  }

  place(unit: Unit, lines: Line[], next: { unit: Unit; lines: Line[] } | undefined): void {
    if (unit.pageBreakBefore && !this.atTop()) this.newPage()
    if (!this.atTop()) this.y -= unit.before
    const height = (n: number, u: Unit) => n * u.leading
    if (unit.keepWithNext && next) {
      const own = height(lines.length, unit) + unit.after
      const following = height(Math.min(2, next.lines.length), next.unit) + next.unit.before
      if (this.y - own - following < MARGIN && !this.atTop()) this.newPage()
    }
    const text = [unit.label?.text ?? "", unit.pieces.map((p) => p.text).join("")]
      .filter((t) => t !== "")
      .join(" ")
    if (!unit.isToc && text !== "") this.intended.push(text)
    let first = true
    for (const line of lines) {
      if (this.y - unit.leading < MARGIN) this.newPage()
      const baseline = this.y - unit.size
      if (first && unit.tocLabel !== undefined)
        this.headingAt.push({ label: unit.tocLabel, page: this.page })
      if (first && unit.label) this.draw(unit.label, MARGIN + unit.indent, baseline, unit, false)
      if (unit.tocEntry !== undefined && first)
        this.tocLines.push({ entry: unit.tocEntry, page: this.page, y: baseline, size: unit.size })
      this.drawLine(line, unit, baseline)
      this.y -= unit.leading
      first = false
    }
    this.y -= unit.after
  }

  private draw(piece: Piece, x: number, y: number, unit: Unit, furniture: boolean): void {
    if (piece.text === "") return
    this.push({
      op: "drawText",
      page: this.page,
      text: piece.text,
      x,
      y,
      size: unit.size,
      font: FONT_REF[piece.style],
      ...(piece.grey ? { color: GREY } : {}),
    })
    if (!furniture && !unit.isToc) this.body.push(piece.text)
  }

  private drawLine(line: Line, unit: Unit, baseline: number): void {
    const x0 = MARGIN + unit.indent + unit.hang
    const width = this.contentWidth - unit.indent - unit.hang
    const sum = line.widths.reduce((n, w) => n + w, 0)
    const space = faceTextWidth("serif", " ", unit.size)
    const n = line.words.length
    let gap = space
    let x = x0
    if (unit.align === "justify" && !line.last && n > 1) gap = (width - sum) / (n - 1)
    else if (unit.align === "center") x = x0 + (width - (sum + space * (n - 1))) / 2
    line.words.forEach((word, i) => {
      let px = x
      for (const piece of word) {
        this.draw(piece, px, baseline, unit, false)
        px += pieceWidth(piece, unit.size)
      }
      x += (line.widths[i] ?? 0) + gap
    })
  }

  /** Header (short title, Confidentiel) from page 2, and Page X sur Y on every page. */
  furniture(lang: Lang, shortTitle: string | undefined, confidential: boolean): void {
    const total = this.page + 1
    const w = WORDS[lang]
    for (let p = 0; p < total; p++) {
      const footer = w.page(p + 1, total)
      const fw = faceTextWidth("serif", footer, FURNITURE_SIZE)
      this.push({
        op: "drawText",
        page: p,
        text: footer,
        x: (A4.width - fw) / 2,
        y: MARGIN / 2,
        size: FURNITURE_SIZE,
        font: FONT_REF.serif,
        color: FURNITURE_GREY,
      })
      if (p === 0) continue
      const headerY = A4.height - MARGIN / 2
      if (shortTitle)
        this.push({
          op: "drawText",
          page: p,
          text: shortTitle,
          x: MARGIN,
          y: headerY,
          size: FURNITURE_SIZE,
          font: FONT_REF.serifItalic,
          color: FURNITURE_GREY,
        })
      if (confidential) {
        const cw = faceTextWidth("serifBold", w.confidential, FURNITURE_SIZE)
        this.push({
          op: "drawText",
          page: p,
          text: w.confidential,
          x: A4.width - MARGIN - cw,
          y: headerY,
          size: FURNITURE_SIZE,
          font: FONT_REF.serifBold,
          color: FURNITURE_GREY,
        })
      }
    }
  }

  /** The contents' page numbers, right-aligned on each entry's line. */
  tocNumbers(): Array<{ entry: number; printed: number }> {
    const out: Array<{ entry: number; printed: number }> = []
    for (const line of this.tocLines) {
      const at = this.headingAt[line.entry]
      const printed = (at?.page ?? 0) + 1
      const text = String(printed)
      const tw = faceTextWidth("serif", text, line.size)
      this.push({
        op: "drawText",
        page: line.page,
        text,
        x: A4.width - MARGIN - tw,
        y: line.y,
        size: line.size,
        font: FONT_REF.serif,
      })
      out.push({ entry: line.entry, printed })
    }
    return out
  }
}

/** A word wider than the line is broken by character; it never runs into the margin. */
function splitLongWord(word: Word, width: number, size: number): Word[] {
  const total = word.reduce((n, p) => n + pieceWidth(p, size), 0)
  if (total <= width) return [word]
  const out: Word[] = []
  let cur: Word = []
  let used = 0
  for (const piece of word) {
    let chunk = ""
    for (const ch of piece.text) {
      const cw = pieceWidth({ ...piece, text: ch }, size)
      if (used + cw > width && (chunk !== "" || cur.length > 0)) {
        if (chunk !== "") cur.push({ ...piece, text: chunk })
        out.push(cur)
        cur = []
        chunk = ""
        used = 0
      }
      chunk += ch
      used += cw
    }
    if (chunk !== "") cur.push({ ...piece, text: chunk })
  }
  if (cur.length > 0) out.push(cur)
  return out
}

function paginate(builder: Builder, fill: LegalFill, title: string | undefined): Pager {
  const pager = new Pager(fill, title)
  const laid = builder.units.map((unit) => ({ unit, lines: pager.lines(unit) }))
  laid.forEach((item, i) => {
    pager.place(item.unit, item.lines, laid[i + 1])
  })
  return pager
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Lay a legal body out into draw commands (pure: no image, no I/O beyond the font files). */
export function layoutLegal(
  body: RichTextBody,
  fill: LegalFill,
  title: string | undefined,
): LegalLaidOut {
  const lang: Lang = body.page?.lang === "en" ? "en" : "fr"
  const numbered = numberClauses(body, fill, lang)
  const shownTitle = title ?? body.page?.shortTitle
  const make = () => new Builder(body, fill, lang, numbered, shownTitle)

  // Pass 1 runs the checks against the definitions before any page exists.
  let builder = make()
  builder.collectDefinitions(body.blocks)
  checkClauses(body, fill, numbered, builder)

  const explicitToc = body.blocks.some((b) => b.type === "toc" && fill.blockPrints(b.when))
  // The fill records blanks as it resolves text: a second build must not count them twice.
  const blanksBefore = fill.blanks.length
  builder.build(false)
  let pager = paginate(builder, fill, title)
  if (explicitToc || pager.page + 1 >= TOC_FROM_PAGES) {
    // Second build with the contents: their entries are the first build's headings.
    const entries = builder.tocEntries
    fill.blanks.splice(blanksBefore)
    builder = make()
    builder.collectDefinitions(body.blocks)
    builder.contents = entries
    builder.build(true)
    pager = paginate(builder, fill, title)
  }
  const printed = pager.tocNumbers()
  pager.furniture(lang, body.page?.shortTitle ?? shownTitle, body.page?.confidential === true)
  return {
    commands: pager.commands,
    blanks: fill.blanks,
    pageCount: pager.page + 1,
    intended: pager.intended,
    bodyText: pager.bodyText,
    toc: printed.map((p) => ({
      label: builder.tocEntries[p.entry] ?? "",
      printedPage: p.printed,
      headingPage:
        (pager.headingAt.find((h) => h.label === builder.tocEntries[p.entry])?.page ?? -1) + 1,
    })),
  }
}
