// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared template primitives — sandboxed PDF DSL.
//
// Templates are TypeScript modules authored against `@liaison/app-sdk`'s
// `PdfBuilder`, a pure recorder that emits a JSON draw-command list. The build
// pipeline (freeze-app.ts) bundles each template into a sandbox-executable
// artifact that sets `globalThis.renderTemplate`; the kernel runs it INSIDE the
// QuickJS app sandbox and replays the emitted commands against pdf-lib on the
// host (apps/api/src/modules/pdf/replay.ts). No pdf-lib runs in the template,
// and no template-authored code runs on the host.
//
// IMPORTANT: every template module must export `renderTemplate(data) =>
// DrawCommand[]` (the freeze step bundles that export). WinAnsi sanitization
// stays SANDBOX-SIDE (in this module's `drawText` wrapper) so the host replayer
// stays a dumb pdf-lib executor and the unicode round-trip holds.

import { type DrawCommand, PdfBuilder, type PdfPage, rgb } from "@liaison/app-sdk"

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

export interface DocumentData {
  type: DocumentType
  /** Split-order scope, carried for the INTERNAL surfaces (list pairing,
   *  download-both) and deliberately NOT rendered on the PDF.
   *
   *  The split exists so that a customs officer sees the physical goods and
   *  nothing else. A note on the goods invoice pointing at a companion document
   *  would defeat the entire purpose and invite a request for it. A cross
   *  reference was briefly added here on 2026-08-27 and removed the same day for
   *  exactly that reason: whatever links the two halves belongs in OUR UI, never
   *  on the artifact that leaves the building. `software` renders a "digital delivery only" notice so
   *  customs never treats the document as a commercial invoice for a shipment;
   *  `goods` (or null, the default for agent/manual documents) renders normally. */
  scope?: "goods" | "software" | null
  number: string
  issued_at: string
  due_at: string | null
  currency: string
  subtotal_minor: bigint
  tax_total_minor: bigint
  grand_total_minor: bigint
  tax_treatment: string
  incoterm: string
  /** Payment settlement state (mirrors documents.payment_status: unpaid | partial | paid |
   *  refunded). A "paid" invoice is already settled (the common case for Shopify-synced orders,
   *  paid at checkout): the totals block reads "Amount paid" instead of "Total due" and the
   *  payment/banking box is suppressed (a settled invoice needs no "where to pay" instructions).
   *  Absent/any-other value renders the standard unpaid layout. */
  payment_status?: string | null
  /** Settlement date (documents.paid_at) — rendered as "Paid on <date>" under the total when paid. */
  paid_at?: string | null
  /** Credit notes only — the ORIGINAL invoice's number, when this credit note references one.
   *  Rendered as a reference line under the header meta ("Credit note for invoice <n>"). */
  original_invoice_number?: string | null
  /** Credit notes only — free-text reason, rendered under the reference line when present. */
  reason?: string | null
  /** Credit notes only — the original invoice's issue date, printed after its number. */
  original_invoice_date?: string | null
  /** The operation type in words ("Livraison de biens"), printed in the header meta block. */
  operation_label?: string | null
  /** The seller opted to pay VAT on debits: the literal French option mention prints under the legal mention. */
  vat_on_debits?: boolean | null
  /** The store order this document bills ("#1149") — the HUMAN Shopify order
   *  reference, not the numeric order id. Rendered as an "Order" line in the
   *  header meta block so the order number can be read straight off the PDF
   *  (support and accounting both search by it). Absent for non-order documents. */
  shopify_order_number?: string | null
  /** The customer's purchase order number, when they gave one. Rendered as a "PO
   *  number" line in the header meta block, directly under the "Order" line, on
   *  every document type except purchase_order (this document already IS a
   *  purchase order). Absent when the customer gave none. */
  po_number?: string | null
  /** The issuer's own reference for this customer in another system (e.g. a CRM record id).
   *  Rendered as a "Customer ref" line in the header meta block, under "PO number", on every
   *  document type. Absent/blank renders nothing. */
  customer_reference?: string | null
  /** Free-text notes (contract reference, extra customs information, a special
   *  mention). Rendered as a "Notes" block between the totals and the legal
   *  mention on EVERY document type, line breaks preserved and long lines
   *  wrapped. Absent/blank renders nothing at all, never an empty label. */
  notes?: string | null
}

export interface IssuerData {
  legal_name: string
  country: string
  vat_id: string | null
  address: string | null
  iban: string | null
  swift_bic: string | null
  bank_name: string | null
  default_language: "en" | "fr" | "de"
  /** kernel.files uuid of the issuer's logo image (png/jpeg). Optional —
   *  absence falls back to a text wordmark header, never fails the render. */
  logo_file_id?: string | null
  /** French identity mentions: SIREN, legal form, share capital (as written, e.g. "10 000") and the RCS city. */
  siren?: string | null
  legal_form?: string | null
  share_capital?: string | null
  rcs_city?: string | null
}

export interface CounterpartyData {
  legal_name: string
  country: string
  vat_id: string | null
  address: string | null
  /** Ship to address, when the goods go somewhere other than the billing address. Optional:
   *  documents issued before the ship to snapshot existed carry neither field, and the render
   *  falls back to the BILL TO block alone. RENDER ONLY, never a tax-classification input. */
  shipping_address?: string | null
  /** Consignee name for the SHIP TO block; falls back to `legal_name`. */
  shipping_name?: string | null
  /** Optional — not every caller carries a counterparty email. */
  email?: string | null
  /** The buyer's SIREN, printed in the BILL TO block when set. */
  siren?: string | null
}

export interface LineItem {
  position: number
  description: string
  quantity: string
  unit_price_minor: bigint
  /** Per-line discount (minor units, tax-exclusive). Crosses the bridge as a
   *  numeric string; absent/0 renders nothing. */
  discount_minor?: bigint | string | number
  tax_rate_bp: number
  subtotal_minor: bigint
  tax_minor: bigint
  total_minor: bigint
  hs_code?: string | null
  country_of_origin?: string | null
  customs_description?: string | null
}

export interface DocumentRenderInput {
  document: DocumentData
  issuer: IssuerData
  counterparty: CounterpartyData
  line_items: LineItem[]
  legal_mention: string
  requires_hs_code: boolean
}

// ── Currency exponents (ISO 4217 minor-unit digits) ──────────────────────
//
// The templates bundle is sandbox-isolated from src/ (it imports NOTHING from
// apps/api and cannot reach src/money.ts across the sandbox boundary), so the
// zero-decimal set + exponent rule is duplicated here from src/money.ts. Keep
// the two copies identical: most currencies split 2 minor digits (EUR/USD:
// 100 minor = 1 major), but the ISO 4217 zero-decimal currencies have no
// fractional unit (JPY 23900 minor = 23900 yen), so dividing them by 100 for
// display renders amounts 100x too small.
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "HUF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/** Minor-unit digit count for a currency (ISO 4217): 0, 3 (dinar family), 4 (CLF/UYW), else 2. */
function currencyExponent(currency: string): number {
  const c = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(c)) return 3
  if (c === "CLF" || c === "UYW") return 4
  return 2
}

/**
 * Format a minor-unit amount to a display string. Currency code is appended
 * (`formatMoney(amt, "EUR")` → `"100.00 EUR"`). The currency's ISO 4217
 * exponent decides how many minor digits split off: 2 for EUR/USD, 0 for
 * zero-decimal currencies (`formatMoney(23900n, "JPY")` → `"23900 JPY"`), which
 * are NOT divided by 100. Twin of src/money.ts formatMoneyMinor.
 *
 * Accepts `bigint | string | number`: in-process callers (unit tests) pass a
 * `bigint`, but templates are rendered inside the sandbox with `data` that has
 * crossed the kernel's JSON bridge — BigInt is not JSON-serialisable, so money
 * columns arrive as numeric strings. We coerce here so the template is tolerant
 * of both shapes rather than throwing `Cannot mix BigInt and other types` on
 * the wire path.
 */
export function formatMoney(minor: bigint | string | number, currency: string): string {
  const m = typeof minor === "bigint" ? minor : BigInt(minor)
  const negative = m < 0n
  const abs = negative ? -m : m
  const sign = negative ? "-" : ""
  const exp = currencyExponent(currency)
  if (exp === 0) {
    return `${sign}${abs.toString()} ${currency}`
  }
  const scale = 10n ** BigInt(exp)
  const major = abs / scale
  const cents = (abs % scale).toString().padStart(exp, "0")
  return `${sign}${major.toString()}.${cents} ${currency}`
}

/**
 * Format a quantity string (already in normalized form) for display.
 * Strips trailing zeros after the decimal, but keeps the integer form
 * if the value is whole.
 */
export function formatQty(q: string): string {
  if (!q.includes(".")) return q
  return q.replace(/\.?0+$/, "")
}

const TITLES: Record<DocumentType, string> = {
  invoice: "INVOICE",
  quote: "QUOTE",
  proforma: "PROFORMA INVOICE",
  purchase_order: "PURCHASE ORDER",
  credit_note: "CREDIT NOTE",
}

const PAGE_WIDTH = 595 // A4
const PAGE_HEIGHT = 842
const MARGIN_X = 50
const MARGIN_TOP = 50
const MARGIN_BOTTOM = 70
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2 // 495
const LINE_HEIGHT = 14

// ─────────────────────────────────────────────────────────────────────────
// Real Helvetica AFM width metrics (units per 1000 em), standard Adobe
// values for the printable ASCII range. `textWidth` / `wrapText` use these
// for accurate measurement instead of a hardcoded character budget — the
// previous ~20-char-per-line approximation is what produced the one/two
// word wrapped lines this rewrite fixes.
// ─────────────────────────────────────────────────────────────────────────

const HELV_WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584,
}

const HELV_BOLD_WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 333,
  '"': 474,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 722,
  "'": 238,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 333,
  ";": 333,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 611,
  "@": 975,
  A: 722,
  B: 722,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 556,
  K: 722,
  L: 611,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 333,
  "\\": 278,
  "]": 333,
  "^": 584,
  _: 556,
  "`": 333,
  a: 556,
  b: 611,
  c: 556,
  d: 611,
  e: 556,
  f: 333,
  g: 611,
  h: 611,
  i: 278,
  j: 278,
  k: 556,
  l: 278,
  m: 889,
  n: 611,
  o: 611,
  p: 611,
  q: 611,
  r: 389,
  s: 556,
  t: 333,
  u: 611,
  v: 556,
  w: 778,
  x: 556,
  y: 556,
  z: 500,
  "{": 389,
  "|": 280,
  "}": 389,
  "~": 584,
}

const DEFAULT_CHAR_WIDTH = 556
/** One em, the advance of a CJK ideograph or kana. */
const FULL_WIDTH_CHAR_WIDTH = 1000

/** Measured text width in points, using real Helvetica AFM metrics. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS
  let units = 0
  for (const ch of text) {
    const known = table[ch]
    if (known !== undefined) units += known
    else units += isFullWidth(ch.codePointAt(0) ?? 0) ? FULL_WIDTH_CHAR_WIDTH : DEFAULT_CHAR_WIDTH
  }
  return (units / 1000) * size
}

/**
 * Greedy word-wrap by MEASURED width (not a character-count budget). Breaks
 * a single word wider than `maxWidth` by character so ultra-long tokens
 * (a 500-char run with no whitespace) still terminate.
 */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  if (!text) return [""]
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let cur = ""

  const pushWord = (word: string) => {
    // A single word wider than maxWidth on its own: break by character.
    if (textWidth(word, size, bold) > maxWidth) {
      // The line already in progress comes first, then the word's chunks.
      if (cur) {
        lines.push(cur)
        cur = ""
      }
      let chunk = ""
      for (const ch of word) {
        const candidate = chunk + ch
        if (textWidth(candidate, size, bold) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk = candidate
        }
      }
      if (chunk) cur = chunk
      return
    }
    const candidate = cur ? `${cur} ${word}` : word
    if (textWidth(candidate, size, bold) <= maxWidth) {
      cur = candidate
    } else {
      if (cur) lines.push(cur)
      cur = word
    }
  }

  for (const word of words) pushWord(word)
  if (cur) lines.push(cur)
  return lines.length > 0 ? lines : [""]
}

// The host replayer embeds a real Unicode font (Liberation Sans, metrically
// identical to Helvetica) for the Helvetica family, so text is no longer
// confined to Latin-1. Two jobs remain here, both sandbox-side so the host
// replayer stays a dumb pdf-lib executor.
//
// 1. Typographic normalisation. Curly quotes, en/em dashes and the like are
//    replaced with their ASCII equivalents. Not a coverage problem any more --
//    the font has them -- but invoices are commercial documents that get
//    pasted into accounting systems and read by customs officers, and the
//    plain forms travel better.
//
// 2. A LAST-RESORT fallback for what the font genuinely lacks. Liberation Sans
//    covers Latin, Latin Extended-A/B, Greek and Cyrillic; it has no CJK. An
//    uncovered codepoint would otherwise render as .notdef -- a blank or a
//    hollow box, which on an invoice reads as a rendering fault rather than a
//    missing glyph. Where a Latin base letter exists underneath (accents,
//    strokes) we transliterate to it, which is legible; where nothing does, "?"
//    is the honest marker.
//
// The old behaviour was to force EVERY codepoint above 0xFF to "?", which is
// what printed "Igor Łukawski" as "Igor ?ukawski" on a real issued invoice.
const TYPOGRAPHIC_REPLACEMENTS: Record<string, string> = {
  "\u2264": "<=",
  "\u2265": ">=",
  // copy-lint: exempt transliteration table keyed BY the dash character; this map is what enforces the no-dash rule in rendered PDFs
  "\u2014": "-",
  // copy-lint: exempt transliteration table keyed BY the dash character
  "\u2013": "-",
  "\u2022": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2026": "...",
  "\u2192": "->",
  "\u00d7": "x",
}

/**
 * Codepoint ranges the embedded face actually covers. Deliberately a
 * conservative allowlist rather than "anything above 0xFF": a character that
 * passes here and turns out to be missing renders as an empty box, which is a
 * worse failure on an invoice than a transliteration.
 */
const COVERED_RANGES: Array<[number, number]> = [
  [0x0000, 0x024f], // Basic Latin, Latin-1, Latin Extended-A and B
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
  [0x2000, 0x206f], // General punctuation
  [0x20a0, 0x20bf], // Currency symbols
  // CJK, served by a fallback face on the host. Kept in step with CJK_RANGES in
  // apps/api/src/modules/pdf/unicode-fonts.ts: a character allowed here but not
  // routed to the fallback there renders as a hollow box.
  [0x2e80, 0x2fdf], // CJK radicals
  [0x3000, 0x30ff], // CJK punctuation, hiragana, katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
]

/**
 * CJK glyphs are full-width: roughly one em, against ~0.55 em for Latin. The
 * default advance would under-measure a Japanese address by nearly half and let
 * it run past its column. Approximate on purpose -- the host lays the text out
 * with the real font metrics; this only has to be close enough to wrap.
 */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60)
  )
}

function isCovered(cp: number): boolean {
  for (const [lo, hi] of COVERED_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

/**
 * Strip a character down to its Latin base letter, when it has one.
 *
 * NFD splits a precomposed letter into base + combining marks, so dropping the
 * marks leaves the base: "ā" -> "a". Characters whose difference is a stroke
 * rather than a mark (Ł, Ø, Đ) do not decompose, so they are listed explicitly.
 */
const STROKE_LETTERS: Record<string, string> = {
  "\u0141": "L",
  "\u0142": "l",
  "\u00d8": "O",
  "\u00f8": "o",
  "\u0110": "D",
  "\u0111": "d",
  "\u0126": "H",
  "\u0127": "h",
  "\u0166": "T",
  "\u0167": "t",
  "\u00c6": "AE",
  "\u00e6": "ae",
  "\u0152": "OE",
  "\u0153": "oe",
  "\u00df": "ss",
}

function transliterate(ch: string): string {
  const stroke = STROKE_LETTERS[ch]
  if (stroke !== undefined) return stroke
  const decomposed = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  // Only accept a decomposition that actually reduced to renderable ASCII --
  // NFD on a CJK ideograph returns the ideograph.
  if (decomposed !== "" && /^[\x20-\x7e]+$/.test(decomposed)) return decomposed
  return "?"
}

/**
 * Prepare text for drawing. Named for what it does now, not for the WinAnsi
 * ceiling it used to work around.
 */
export function sanitizeForPdfText(text: string): string {
  let out = text
  for (const [from, to] of Object.entries(TYPOGRAPHIC_REPLACEMENTS)) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return Array.from(out)
    .map((ch) => (isCovered(ch.codePointAt(0) ?? 0) ? ch : transliterate(ch)))
    .join("")
}

const GRAY_DARK: [number, number, number] = [0.13, 0.13, 0.13]
const GRAY_LABEL: [number, number, number] = [0.45, 0.45, 0.45]
const GRAY_MUTED: [number, number, number] = [0.35, 0.35, 0.35]
const GRAY_RULE: [number, number, number] = [0.9, 0.9, 0.9]
const GRAY_HEADER_BG: [number, number, number] = [0.95, 0.95, 0.96]
const GRAY_BORDER: [number, number, number] = [0.75, 0.75, 0.75]

// ─────────────────────────────────────────────────────────────────────────
// Layout engine — a page-spanning cursor + a list of every created page (so
// the footer pass at the end can stamp "Page N of M" once the total is known).
// ─────────────────────────────────────────────────────────────────────────

interface Cursor {
  y: number
}

interface DrawCtx {
  pdf: PdfBuilder
  page: PdfPage
  font: string
  bold: string
  oblique: string
  cursor: Cursor
}

interface LayoutState {
  pdf: PdfBuilder
  font: string
  bold: string
  oblique: string
  cursor: Cursor
  page: PdfPage
  pages: PdfPage[]
  imageRef?: string
  /** False on an exempt document that carries no tax: the "Tax %" column and the Tax totals row
   *  are left out entirely (see `showsTaxColumns`). */
  showTax: boolean
}

function draw(
  ctx: DrawCtx,
  text: string,
  opts: {
    x?: number
    y?: number
    size?: number
    bold?: boolean
    oblique?: boolean
    color?: [number, number, number]
  } = {},
): void {
  const size = opts.size ?? 10
  const x = opts.x ?? MARGIN_X
  const y = opts.y ?? ctx.cursor.y
  const font = opts.oblique ? ctx.oblique : opts.bold ? ctx.bold : ctx.font
  const color = opts.color ?? [0, 0, 0]
  ctx.page.drawText(sanitizeForPdfText(text), {
    x,
    y,
    size,
    font,
    color: rgb(color[0], color[1], color[2]),
  })
}

/** Right-align `text` so its right edge lands at `rightX`. */
function drawRight(
  ctx: DrawCtx,
  text: string,
  rightX: number,
  opts: { y?: number; size?: number; bold?: boolean; color?: [number, number, number] } = {},
): void {
  const size = opts.size ?? 10
  const w = textWidth(text, size, !!opts.bold)
  draw(ctx, text, { ...opts, x: rightX - w })
}

function newPage(state: LayoutState): void {
  const page = state.pdf.addPage(PAGE_WIDTH, PAGE_HEIGHT)
  state.pages.push(page)
  state.page = page
  state.cursor.y = PAGE_HEIGHT - MARGIN_TOP
}

/** Start a new page when `need` points of vertical space are not available
 *  above the footer zone. Returns true when a new page was started. */
function ensureSpace(state: LayoutState, need: number): boolean {
  if (state.cursor.y - need < MARGIN_BOTTOM) {
    newPage(state)
    return true
  }
  return false
}

function ctxOf(state: LayoutState): DrawCtx {
  return {
    pdf: state.pdf,
    page: state.page,
    font: state.font,
    bold: state.bold,
    oblique: state.oblique,
    cursor: state.cursor,
  }
}

/**
 * Treatments whose legal mention declares the document exempt from (or zero rated for) the
 * issuer's tax. Kept in step with src/tax.ts EXEMPT_TREATMENTS by hand: the templates bundle is
 * sandbox-isolated from src/.
 */
const EXEMPT_TAX_TREATMENTS: ReadonlySet<string> = new Set([
  "eu_reverse_charge",
  "eu_export_non_eu",
  "uk_export_eu",
  "uk_export_non_eu",
  "us_export",
])

/**
 * Whether the document prints a "Tax %" column and a Tax totals row. An exempt document (export,
 * reverse charge) whose lines carry no tax prints neither: a "0.00%" column and a "Tax 0.00" row
 * printed next to "VAT-exempt under Article 146" read as a tax decision the mention contradicts.
 * An exempt document that DOES carry tax (issued before issuance refused that combination) keeps
 * both, because hiding an amount its total includes would make the totals unreadable.
 */
export function showsTaxColumns(input: DocumentRenderInput): boolean {
  if (!EXEMPT_TAX_TREATMENTS.has(input.document.tax_treatment)) return true
  if (toBigIntLoose(input.document.tax_total_minor) !== 0n) return true
  return input.line_items.some((l) => Number(l.tax_rate_bp) !== 0)
}

const TABLE_COLS = {
  index: { x: MARGIN_X, width: 22 },
  description: { x: 72, width: 248 },
  qty: { rightX: 350 },
  unitPrice: { rightX: 425 },
  taxPct: { rightX: 465 },
  amount: { rightX: MARGIN_X + CONTENT_WIDTH },
}

/** Draw the items-table header row (label band + column labels). Repeated on
 *  every page the table spans. */
function drawTableHeader(state: LayoutState): void {
  ensureSpace(state, 28)
  const headerTop = state.cursor.y + 4
  state.page.drawRectangle({
    x: MARGIN_X,
    y: headerTop - 18,
    width: CONTENT_WIDTH,
    height: 18,
    color: rgb(...GRAY_HEADER_BG),
  })
  const ctx = ctxOf(state)
  const labelY = headerTop - 13
  draw(ctx, "#", { x: TABLE_COLS.index.x, y: labelY, size: 8.5, bold: true, color: GRAY_DARK })
  draw(ctx, "Description", {
    x: TABLE_COLS.description.x,
    y: labelY,
    size: 8.5,
    bold: true,
    color: GRAY_DARK,
  })
  drawRight(ctx, "Qty", TABLE_COLS.qty.rightX, { y: labelY, size: 8.5, bold: true, color: GRAY_DARK })
  drawRight(ctx, "Unit price", TABLE_COLS.unitPrice.rightX, {
    y: labelY,
    size: 8.5,
    bold: true,
    color: GRAY_DARK,
  })
  if (state.showTax) {
    drawRight(ctx, "Tax %", TABLE_COLS.taxPct.rightX, {
      y: labelY,
      size: 8.5,
      bold: true,
      color: GRAY_DARK,
    })
  }
  drawRight(ctx, "Amount", TABLE_COLS.amount.rightX, {
    y: labelY,
    size: 8.5,
    bold: true,
    color: GRAY_DARK,
  })
  state.cursor.y = headerTop - 18 - 8
}

function drawWrappedParagraph(
  state: LayoutState,
  text: string,
  opts: { x: number; maxWidth: number; size: number; bold?: boolean; oblique?: boolean; color?: [number, number, number]; leading?: number },
): void {
  const lines = wrapText(text, opts.maxWidth, opts.size, !!opts.bold)
  const leading = opts.leading ?? opts.size + 3
  for (const line of lines) {
    ensureSpace(state, leading)
    const ctx = ctxOf(state)
    draw(ctx, line, {
      x: opts.x,
      size: opts.size,
      bold: opts.bold,
      oblique: opts.oblique,
      color: opts.color,
    })
    state.cursor.y -= leading
  }
}

/**
 * Build a complete document command list. Header → parties → line table →
 * totals → notes → legal mention → payment details → footer (every page).
 *
 * Returns the accumulated draw-command list (the host replays it to bytes).
 */
export function renderDocument(input: DocumentRenderInput): DrawCommand[] {
  const pdf = new PdfBuilder()
  const title = TITLES[input.document.type]
  pdf.setMetadata({ title, producer: "Liaison Invoicing", creator: "Liaison Invoicing" })

  const font = pdf.embedFont("Helvetica")
  const bold = pdf.embedFont("HelveticaBold")
  const oblique = pdf.embedFont("HelveticaOblique")

  const imageRef =
    input.issuer.logo_file_id != null && input.issuer.logo_file_id !== ""
      ? pdf.embedImage(input.issuer.logo_file_id, "logo")
      : undefined

  const cursor: Cursor = { y: PAGE_HEIGHT - MARGIN_TOP }
  const firstPage = pdf.addPage(PAGE_WIDTH, PAGE_HEIGHT)
  const state: LayoutState = {
    pdf,
    font,
    bold,
    oblique,
    cursor,
    page: firstPage,
    pages: [firstPage],
    imageRef,
    showTax: showsTaxColumns(input),
  }

  drawHeader(state, input)
  drawParties(state, input)
  drawItemsTable(state, input)
  drawTotals(state, input)
  drawNotes(state, input)
  drawLegalMention(state, input)
  drawPaymentDetails(state, input)
  drawFooters(state, input)

  return pdf.build()
}

const LOGO_BOX = { width: 140, height: 48 }

function drawHeader(state: LayoutState, input: DocumentRenderInput): void {
  const top = state.cursor.y
  const rightX = MARGIN_X + CONTENT_WIDTH

  if (state.imageRef) {
    state.page.drawImage({
      ref: state.imageRef,
      x: MARGIN_X,
      y: top + 8,
      maxWidth: LOGO_BOX.width,
      maxHeight: LOGO_BOX.height,
    })
  } else {
    const ctx = ctxOf(state)
    draw(ctx, input.issuer.legal_name, { x: MARGIN_X, y: top - 8, size: 16, bold: true, color: GRAY_DARK })
  }

  // Right-aligned title block.
  const titleText = TITLES[input.document.type]
  let ry = top - 8
  const ctx1 = ctxOf(state)
  drawRight(ctx1, titleText, rightX, { y: ry, size: 20, bold: true, color: GRAY_DARK })
  ry -= 18
  const ctx2 = ctxOf(state)
  drawRight(ctx2, input.document.number, rightX, { y: ry, size: 10.5, color: GRAY_LABEL })
  ry -= 18

  const metaLines: Array<[string, string]> = [["Issued", formatDateLike(input.document.issued_at)]]
  if (input.document.due_at) metaLines.push(["Due", formatDateLike(input.document.due_at)])
  metaLines.push(["Incoterm", input.document.incoterm])
  // Store order reference — sits in the meta block next to the document number so
  // a reader can go from invoice to order (and back) without opening the admin.
  const operation = input.document.operation_label?.trim()
  if (operation) metaLines.push(["Operation", operation])
  const orderNumber = input.document.shopify_order_number?.trim()
  if (orderNumber) metaLines.push(["Order", orderNumber])
  // Customer's purchase order reference — sits directly under the Order line.
  // Not meaningful on a purchase_order document (this document already IS a
  // purchase order), so it is deliberately excluded there even if carried.
  const poNumber =
    input.document.type !== "purchase_order" ? input.document.po_number?.trim() : undefined
  if (poNumber) metaLines.push(["PO number", poNumber])
  // The issuer's own reference for the customer (a CRM record id), so the PDF can be matched to
  // the customer's record in that other system.
  const customerRef = input.document.customer_reference?.trim()
  if (customerRef) metaLines.push(["Customer ref", customerRef])
  for (const [label, value] of metaLines) {
    const ctxLabel = ctxOf(state)
    drawRight(ctxLabel, `${label}:`, rightX - 70, { y: ry, size: 8.5, color: GRAY_LABEL })
    const ctxVal = ctxOf(state)
    drawRight(ctxVal, value, rightX, { y: ry, size: 8.5, color: GRAY_DARK })
    ry -= 13
  }

  // Credit-note reference line — "Credit note for invoice <n>", plus the reason when supplied.
  // Only rendered when the document actually carries the original invoice number (resolved by the
  // caller at buildTemplateData time from external_refs.original_document_id).
  if (input.document.type === "credit_note" && input.document.original_invoice_number) {
    const ctxRef = ctxOf(state)
    drawRight(ctxRef, `Credit note for invoice ${input.document.original_invoice_number}${
        input.document.original_invoice_date ? ` of ${formatDateLike(input.document.original_invoice_date)}` : ""
      }`, rightX, {
      y: ry,
      size: 8.5,
      bold: true,
      color: GRAY_DARK,
    })
    ry -= 13
    if (input.document.reason) {
      const ctxReason = ctxOf(state)
      drawRight(ctxReason, `Reason: ${input.document.reason}`, rightX, {
        y: ry,
        size: 8.5,
        color: GRAY_LABEL,
      })
      ry -= 13
    }
  }

  state.cursor.y = Math.min(top - LOGO_BOX.height - 12, ry - 8)
  ensureSpace(state, 0)
}

/** Issue-time renders pass bare ISO dates, but RE-renders (retry, documents_update)
 *  rebuild template data from the persisted row, where pg returns full
 *  timestamptz strings ("2026-07-02 00:00:00+00") — far too wide for the header
 *  meta column and overlapping its label. Extract the leading YYYY-MM-DD
 *  whatever the source; pass anything else through untouched. */
function formatDateLike(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value))
  return m ? m[1] : String(value)
}

/** Two addresses are "the same address" when they differ only in whitespace or case, so a
 *  trivially different spelling of the billing address does not get printed a second time as a
 *  SHIP TO block. Deliberately conservative: anything beyond whitespace/case counts as different
 *  and IS printed, because failing to show a real ship to is the worse error. */
function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) =>
    (v ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase()
  return norm(a) === norm(b)
}

function drawParties(state: LayoutState, input: DocumentRenderInput): void {
  const shipAddress = input.counterparty.shipping_address?.trim() || null
  // Print SHIP TO only when there IS a ship to AND it is not just the billing address respelled.
  const showShipTo = !!shipAddress && !sameAddress(shipAddress, input.counterparty.address)
  // The SHIP TO block sits under BILL TO in the right column, so reserve room for it too:
  // its label + name + one line per address line + the leading below the block.
  const shipToBudget = showShipTo
    ? 14 + 13 + 12 * Math.max(1, shipAddress.split(/\r?\n/).filter((l) => l.trim() !== "").length) + 10
    : 0
  ensureSpace(state, 90 + shipToBudget)
  const startY = state.cursor.y
  const colWidth = 250
  const leftX = MARGIN_X
  const rightX = 320
  const rightColWidth = PAGE_WIDTH - MARGIN_X - rightX

  const isPO = input.document.type === "purchase_order"
  const fromLabel = "FROM"
  const toLabel = isPO ? "VENDOR" : "BILL TO"

  const drawParty = (
    x: number,
    width: number,
    label: string,
    party: {
      legal_name: string
      country?: string | null
      vat_id?: string | null
      address: string | null
      email?: string | null
      siren?: string | null
      identity?: string | null
    },
    blockTop: number = startY,
  ): number => {
    let y = blockTop
    const ctxLabel: DrawCtx = { pdf: state.pdf, page: state.page, font: state.font, bold: state.bold, oblique: state.oblique, cursor: { y } }
    draw(ctxLabel, label, { x, y, size: 7.5, bold: true, color: GRAY_LABEL })
    y -= 14
    const ctxName: DrawCtx = { ...ctxLabel, cursor: { y } }
    draw(ctxName, party.legal_name, { x, y, size: 10, bold: true, color: GRAY_DARK })
    y -= 13
    if (party.address) {
      // Stored addresses are multiline ("street\nzip city\ncountry") — honor
      // the explicit breaks, wrapping each segment independently.
      const lines = party.address
        .split(/\r?\n/)
        .filter((seg) => seg.trim() !== "")
        .flatMap((seg) => wrapText(seg, width, 9))
      for (const line of lines) {
        const c: DrawCtx = { ...ctxLabel, cursor: { y } }
        draw(c, line, { x, y, size: 9, color: GRAY_MUTED })
        y -= 12
      }
    }
    if (party.country) {
      const c1: DrawCtx = { ...ctxLabel, cursor: { y } }
      draw(c1, party.country, { x, y, size: 9, color: GRAY_MUTED })
      y -= 12
    }
    if (party.vat_id) {
      const c2: DrawCtx = { ...ctxLabel, cursor: { y } }
      draw(c2, `VAT: ${party.vat_id}`, { x, y, size: 9, color: GRAY_MUTED })
      y -= 12
    }
    if (party.siren) {
      const cs: DrawCtx = { ...ctxLabel, cursor: { y } }
      draw(cs, `SIREN ${party.siren}`, { x, y, size: 9, color: GRAY_MUTED })
      y -= 12
    }
    if (party.identity) {
      // A long legal form plus capital wraps inside the column instead of running into BILL TO.
      for (const line of wrapText(party.identity, width, 9)) {
        const ci: DrawCtx = { ...ctxLabel, cursor: { y } }
        draw(ci, line, { x, y, size: 9, color: GRAY_MUTED })
        y -= 12
      }
    }
    if (party.email) {
      const c3: DrawCtx = { ...ctxLabel, cursor: { y } }
      draw(c3, party.email, { x, y, size: 9, color: GRAY_MUTED })
      y -= 12
    }
    return y
  }

  const leftEnd = drawParty(leftX, colWidth, fromLabel, {
    legal_name: input.issuer.legal_name,
    country: input.issuer.country,
    vat_id: input.issuer.vat_id,
    address: input.issuer.address,
    siren: input.issuer.siren?.trim() || null,
    identity: legalFormCapital(input.issuer),
  })
  const rightEnd = drawParty(rightX, rightColWidth, toLabel, {
    legal_name: input.counterparty.legal_name,
    country: input.counterparty.country,
    vat_id: input.counterparty.vat_id,
    address: input.counterparty.address,
    email: input.counterparty.email,
    siren: input.counterparty.siren?.trim() || null,
  })
  // Third party block: where the goods actually go. No country / VAT / email line: those
  // identify the BILLED party and would read as a second, contradictory legal identity.
  const shipEnd = showShipTo
    ? drawParty(
        rightX,
        rightColWidth,
        "SHIP TO",
        {
          legal_name:
            input.counterparty.shipping_name?.trim() || input.counterparty.legal_name,
          address: shipAddress,
        },
        rightEnd - 10,
      )
    : rightEnd

  // Fold EVERY block's end into the cursor: a long ship to must push the items table down,
  // never be drawn over by it.
  state.cursor.y = Math.min(leftEnd, rightEnd, shipEnd) - 10
}

const ROW_LEADING = 12
const CUSTOMS_LEADING = 10
// Clearance below the items-table row separator rule before the next content
// (either the next row, or the totals block) may draw text — must exceed the
// tallest text size drawn immediately after (the "Total due" line is 11pt).
const ROW_GAP_AFTER_RULE = 14

/** Bridge-tolerant bigint coercion (money columns arrive as numeric strings). */
function toBigIntLoose(v: bigint | string | number | null | undefined): bigint {
  if (v == null) return 0n
  if (typeof v === "bigint") return v
  if (typeof v === "number") return BigInt(Math.round(v))
  if (typeof v === "string" && v.length > 0) return BigInt(v)
  return 0n
}

function drawItemsTable(state: LayoutState, input: DocumentRenderInput): void {
  drawTableHeader(state)

  for (const line of input.line_items) {
    const wrapped = wrapText(line.description, TABLE_COLS.description.width, 9)
    const hasCustoms = !!(line.hs_code || line.country_of_origin || line.customs_description)
    const customsLines = hasCustoms
      ? wrapText(
          [
            line.hs_code ? `HS ${line.hs_code}` : "",
            line.country_of_origin ? `Origin ${line.country_of_origin}` : "",
            line.customs_description ?? "",
          ]
            .filter(Boolean)
            .join(" · "),
          TABLE_COLS.description.width,
          7.5,
        )
      : []

    // Keep the whole row (description lines + customs sub-row) together on
    // one page when it can possibly fit on a fresh page — a customs sub-row
    // orphaned at the top of the next page reads as belonging to the wrong
    // item. Rows taller than a full page fall back to line-by-line breaking.
    const rowHeight = ROW_LEADING * wrapped.length + CUSTOMS_LEADING * customsLines.length + 4
    const freshPageCapacity = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM - 28
    const need = rowHeight <= freshPageCapacity ? rowHeight : ROW_LEADING + 4
    if (ensureSpace(state, need)) drawTableHeader(state)

    const rowTopY = state.cursor.y
    const ctxIndex: DrawCtx = {
      pdf: state.pdf,
      page: state.page,
      font: state.font,
      bold: state.bold,
      oblique: state.oblique,
      cursor: { y: rowTopY },
    }
    draw(ctxIndex, String(line.position), { x: TABLE_COLS.index.x, y: rowTopY, size: 9 })
    drawRight(ctxIndex, formatQty(line.quantity), TABLE_COLS.qty.rightX, { y: rowTopY, size: 9 })
    drawRight(
      ctxIndex,
      formatMoney(line.unit_price_minor, input.document.currency).replace(
        ` ${input.document.currency}`,
        "",
      ),
      TABLE_COLS.unitPrice.rightX,
      { y: rowTopY, size: 9 },
    )
    if (state.showTax) {
      drawRight(ctxIndex, `${(line.tax_rate_bp / 100).toFixed(2)}%`, TABLE_COLS.taxPct.rightX, {
        y: rowTopY,
        size: 9,
      })
    }
    drawRight(
      ctxIndex,
      formatMoney(line.total_minor, input.document.currency).replace(
        ` ${input.document.currency}`,
        "",
      ),
      TABLE_COLS.amount.rightX,
      { y: rowTopY, size: 9 },
    )
    // First description line, drawn at the row's top (same page reserved above).
    if (wrapped[0] !== undefined) {
      draw(ctxIndex, wrapped[0], { x: TABLE_COLS.description.x, y: rowTopY, size: 9 })
    }
    state.cursor.y -= ROW_LEADING

    // Continuation description lines — each gets its own page-break check
    // (a long wrapped description spans as many pages as it needs; the
    // table header repeats at the top of every continuation page).
    for (const dLine of wrapped.slice(1)) {
      if (ensureSpace(state, ROW_LEADING)) drawTableHeader(state)
      const c = ctxOf(state)
      draw(c, dLine, { x: TABLE_COLS.description.x, size: 9 })
      state.cursor.y -= ROW_LEADING
    }

    // Discount sub-row — a reduction must be VISIBLE on the document (never
    // silently folded into the unit price): "Discount −12.00" under the
    // description, so unit price x qty − discount = amount reads plainly.
    const discountMinor = toBigIntLoose(line.discount_minor)
    if (discountMinor > 0n) {
      if (ensureSpace(state, ROW_LEADING)) drawTableHeader(state)
      const dy = state.cursor.y
      const cD = ctxOf(state)
      draw(cD, "Discount", { x: TABLE_COLS.description.x, y: dy, size: 8.5, color: GRAY_LABEL })
      const cDv = ctxOf(state)
      drawRight(
        cDv,
        `-${formatMoney(discountMinor, input.document.currency).replace(` ${input.document.currency}`, "")}`,
        TABLE_COLS.unitPrice.rightX,
        { y: dy, size: 8.5, color: GRAY_LABEL },
      )
      state.cursor.y -= ROW_LEADING
    }

    for (const cLine of customsLines) {
      if (ensureSpace(state, CUSTOMS_LEADING)) drawTableHeader(state)
      const c = ctxOf(state)
      draw(c, cLine, { x: TABLE_COLS.description.x, size: 7.5, color: GRAY_LABEL })
      state.cursor.y -= CUSTOMS_LEADING
    }

    // Row separator BELOW this row's content — never through drawn text. Sits
    // in the middle of the inter-row gap so it clears both this row's last
    // text band (above) and whatever the caller draws next (below, at least
    // `ROW_GAP_AFTER_RULE` clear of the rule).
    const ruleY = state.cursor.y - 4
    state.page.drawLine({
      start: { x: MARGIN_X, y: ruleY },
      end: { x: MARGIN_X + CONTENT_WIDTH, y: ruleY },
      thickness: 0.5,
      color: rgb(...GRAY_RULE),
    })
    state.cursor.y = ruleY - ROW_GAP_AFTER_RULE
  }
}

function drawTotals(state: LayoutState, input: DocumentRenderInput): void {
  ensureSpace(state, 70)
  state.cursor.y -= 4
  const rightX = MARGIN_X + CONTENT_WIDTH
  const labelX = rightX - 200

  const uniformTaxBp =
    input.line_items.length > 0 &&
    input.line_items.every((l) => l.tax_rate_bp === input.line_items[0]!.tax_rate_bp)
      ? input.line_items[0]?.tax_rate_bp
      : undefined

  const row = (label: string, value: string, opts: { bold?: boolean; size?: number } = {}) => {
    const ctx = ctxOf(state)
    draw(ctx, label, { x: labelX, size: opts.size ?? 10, bold: opts.bold, color: GRAY_DARK })
    const ctxVal = ctxOf(state)
    drawRight(ctxVal, value, rightX, { size: opts.size ?? 10, bold: opts.bold, color: GRAY_DARK })
    state.cursor.y -= (opts.size ?? 10) + 6
  }

  row("Subtotal", formatMoney(input.document.subtotal_minor, input.document.currency))
  if (state.showTax) {
    row(
      uniformTaxBp !== undefined ? `Tax (${(uniformTaxBp / 100).toFixed(2)}%)` : "Tax",
      formatMoney(input.document.tax_total_minor, input.document.currency),
    )
  }

  // Rule sits in the gap BELOW the Tax row's text band and ABOVE the Total
  // row's text band — clearance below must exceed the Total row's 11pt size
  // (plus margin) so the rule never falls inside that band.
  state.cursor.y -= 4
  const ruleY = state.cursor.y
  state.page.drawLine({
    start: { x: labelX, y: ruleY },
    end: { x: rightX, y: ruleY },
    thickness: 1,
    color: rgb(...GRAY_DARK),
  })
  state.cursor.y -= 16

  // An already-settled invoice (payment_status="paid", the norm for a Shopify order paid at
  // checkout) reads "Total" with its settlement status under it, not "Total due": nothing is owed.
  // It never says "Amount paid": a split order's payment covers several documents at once, so no
  // single document can state the amount the customer paid. The unpaid/partial case keeps
  // "Total due".
  const isPaid = input.document.payment_status === "paid"
  row(
    isPaid ? "Total" : "Total due",
    formatMoney(input.document.grand_total_minor, input.document.currency),
    { bold: true, size: 11 },
  )
  if (isPaid) {
    const ctxPaid = ctxOf(state)
    drawRight(
      ctxPaid,
      input.document.paid_at ? `Paid on ${formatDateLike(input.document.paid_at)}` : "Paid",
      rightX,
      { size: 8.5, color: GRAY_LABEL },
    )
    state.cursor.y -= 8.5 + 4
  }
  state.cursor.y -= 10
}

/** Hard cap on the notes lines actually drawn. `notes` is capped at 2000 characters at the
 *  write boundary (mutations.ts), which wraps to well under this, so the clamp only ever bites
 *  on a legacy row written before the cap existed: it keeps the rest of the document
 *  (legal mention, payment details, footer) on the page instead of pushing it off. Same
 *  defensive posture the long-address path takes. */
const NOTES_MAX_RENDERED_LINES = 60

/**
 * The document's free-text notes, drawn under the totals and above the legal mention on EVERY
 * document type (a contract reference, extra customs information, a special mention). Author-typed
 * line breaks are preserved, each logical line is wrapped to the content width, and
 * drawWrappedParagraph's own ensureSpace paginates onto a second page rather than overflowing.
 */
function drawNotes(state: LayoutState, input: DocumentRenderInput): void {
  const raw = input.document.notes?.trim()
  if (!raw) return
  // Preserve the author's line breaks: each source line is wrapped independently, so a short
  // line stays short and a long one flows, exactly as it was typed.
  const sourceLines = raw.split(/\r?\n/)
  const wrapped: string[] = []
  for (const line of sourceLines) {
    const trimmed = line.trim()
    // An empty source line is a deliberate paragraph break, kept as blank vertical space.
    if (trimmed === "") {
      wrapped.push("")
      continue
    }
    wrapped.push(...wrapText(trimmed, CONTENT_WIDTH, 9))
  }
  const clamped = wrapped.slice(0, NOTES_MAX_RENDERED_LINES)
  // Keep the label with at least its first line: a "Notes" heading stranded alone at the foot
  // of page 1 reads as a rendering bug.
  ensureSpace(state, 12 + 12)
  draw(ctxOf(state), "Notes", { x: MARGIN_X, size: 9, bold: true, color: GRAY_DARK })
  state.cursor.y -= 13
  for (const line of clamped) {
    if (line === "") {
      state.cursor.y -= 6
      continue
    }
    ensureSpace(state, 12)
    draw(ctxOf(state), line, { x: MARGIN_X, size: 9, color: GRAY_MUTED })
    state.cursor.y -= 12
  }
  state.cursor.y -= 6
}

/** Twin of src/tax.ts VAT_ON_DEBITS_TEXT (this bundle is sandbox-isolated from src/). */
const VAT_ON_DEBITS_TEXT = "Option pour le paiement de la taxe d'après les débits"

/** "SAS au capital de 10 000 €" (French issuer) or "SAS, share capital 10 000" (others); null when neither is set. */
function legalFormCapital(issuer: IssuerData): string | null {
  const form = issuer.legal_form?.trim() ?? ""
  const capital = issuer.share_capital?.trim() ?? ""
  if (!form && !capital) return null
  const fr = issuer.default_language === "fr"
  const capitalText = capital
    ? fr
      ? `au capital de ${/[€]|eur/i.test(capital) ? capital : `${capital} €`}`
      : `share capital ${capital}`
    : ""
  return [form, capitalText].filter(Boolean).join(fr ? " " : ", ")
}

function drawLegalMention(state: LayoutState, input: DocumentRenderInput): void {
  const paragraphs = [input.legal_mention, input.document.vat_on_debits ? VAT_ON_DEBITS_TEXT : ""].filter(Boolean)
  for (const text of paragraphs) {
    drawWrappedParagraph(state, text, {
      x: MARGIN_X,
      maxWidth: CONTENT_WIDTH,
      size: 8,
      oblique: true,
      color: GRAY_LABEL,
    })
    state.cursor.y -= 6
  }
}

function drawPaymentDetails(state: LayoutState, input: DocumentRenderInput): void {
  const eligible = input.document.type === "invoice" || input.document.type === "proforma"
  if (!eligible || !input.issuer.iban) return
  // A settled invoice needs no payment instructions — showing "where to pay" our IBAN on an
  // already-paid invoice is what the field report flagged. Suppress the box once paid.
  if (input.document.payment_status === "paid") return

  const lines: string[] = [`IBAN: ${input.issuer.iban}`]
  if (input.issuer.swift_bic) lines.push(`SWIFT/BIC: ${input.issuer.swift_bic}`)
  if (input.issuer.bank_name) lines.push(`Bank: ${input.issuer.bank_name}`)

  const boxHeight = 22 + lines.length * 12
  ensureSpace(state, boxHeight + 10)
  const boxTop = state.cursor.y
  state.page.drawRectangle({
    x: MARGIN_X,
    y: boxTop - boxHeight,
    width: 260,
    height: boxHeight,
    borderColor: rgb(...GRAY_BORDER),
    borderWidth: 0.75,
  })
  let y = boxTop - 14
  const ctxTitle: DrawCtx = { pdf: state.pdf, page: state.page, font: state.font, bold: state.bold, oblique: state.oblique, cursor: { y } }
  draw(ctxTitle, "Payment details", { x: MARGIN_X + 10, y, size: 9, bold: true, color: GRAY_DARK })
  y -= 14
  for (const line of lines) {
    const c: DrawCtx = { ...ctxTitle, cursor: { y } }
    draw(c, line, { x: MARGIN_X + 10, y, size: 9, color: GRAY_MUTED })
    y -= 12
  }
  state.cursor.y = boxTop - boxHeight - 10
}

/** Clearance between the footer's identity text and the page number. */
const FOOTER_GAP = 12
/** Lines the footer identity may take before it shrinks: they stay under MARGIN_BOTTOM (70pt). */
const FOOTER_MAX_LINES = 2
const FOOTER_MIN_SIZE = 5.5

function drawFooters(state: LayoutState, input: DocumentRenderInput): void {
  const total = state.pages.length
  const footerY = 40
  for (const [i, page] of state.pages.entries()) {
    const ctx: DrawCtx = { pdf: state.pdf, page, font: state.font, bold: state.bold, oblique: state.oblique, cursor: { y: footerY } }
    const rcs = input.issuer.rcs_city?.trim()
      ? `RCS ${input.issuer.rcs_city.trim()}${input.issuer.siren?.trim() ? ` ${input.issuer.siren.trim()}` : ""}`
      : ""
    const leftText = [
      input.issuer.legal_name,
      legalFormCapital(input.issuer),
      rcs,
      input.issuer.vat_id ? `VAT ${input.issuer.vat_id}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
    const rightText = `Page ${i + 1} of ${total}`
    // The identity text wraps into the space left of the page number (never reaching it), the
    // last line on the footer baseline and earlier lines stacked above it inside the bottom
    // margin; past FOOTER_MAX_LINES it shrinks until it fits.
    const leftWidth = CONTENT_WIDTH - textWidth(rightText, 7.5) - FOOTER_GAP
    let size = 7.5
    let lines = wrapText(leftText, leftWidth, size)
    while (lines.length > FOOTER_MAX_LINES && size > FOOTER_MIN_SIZE) {
      size = Math.max(FOOTER_MIN_SIZE, size - 0.5)
      lines = wrapText(leftText, leftWidth, size)
    }
    const leading = size + 1.5
    for (const [k, line] of lines.entries()) {
      const y = footerY + (lines.length - 1 - k) * leading
      draw({ ...ctx, cursor: { y } }, line, { x: MARGIN_X, y, size, color: GRAY_LABEL })
    }
    const ctxRight: DrawCtx = { ...ctx, cursor: { y: footerY } }
    drawRight(ctxRight, rightText, MARGIN_X + CONTENT_WIDTH, { y: footerY, size: 7.5, color: GRAY_LABEL })
  }
}
