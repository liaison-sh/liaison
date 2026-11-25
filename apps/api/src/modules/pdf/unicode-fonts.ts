// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unicode text for the PDF replayer.
//
// pdf-lib's `StandardFonts.Helvetica` is one of the PDF base-14 fonts, which
// carry a WinAnsi (Latin-1) encoding and physically cannot encode a codepoint
// above U+00FF. Templates therefore had to strip everything else to "?" before
// drawing, and customers with ordinary European names got mangled invoices:
// "Igor Łukawski" printed as "Igor ?ukawski" on a real issued document
// (INV-2026-3456). Polish, Czech, Turkish, Greek and Cyrillic names were all
// unrenderable.
//
// The fix is to embed a real font. Liberation Sans is chosen for one specific
// reason beyond its licence (SIL OFL): it is METRICALLY IDENTICAL to Helvetica.
// Every glyph advance in the ASCII range matches the Adobe AFM values to the
// unit, which matters because the templates measure text with a hardcoded
// Helvetica width table to wrap lines and right-align columns. A font that was
// merely similar would silently shift every wrap point and every right-aligned
// figure in the totals block -- a layout regression across every document, in
// exchange for fixing a name. This one changes nothing that already rendered.
//
// Embedded with `subset: true`: a full Liberation Sans face is ~400 KB and
// three faces would add well over a megabyte to every invoice. Subsetting emits
// only the glyphs actually drawn, which for a typical invoice is a few dozen.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import fontkit from "@pdf-lib/fontkit"
import type { PDFDocument, PDFFont } from "pdf-lib"

/**
 * The three faces the invoicing templates ask for, plus a CJK fallback.
 *
 * Liberation Sans covers Latin, Greek and Cyrillic and stops there. Real
 * customers are outside that: prod carries 17 documents across 11 Japanese
 * parties (株式会社アイシン, 祐一郎 小谷, 軽井沢町追分1660-4). Fixing only the
 * European half of "renders non-Latin as ?" would have left those looking
 * exactly as broken as before, which is why the fallback is here rather than
 * filed as a follow-up.
 *
 * Noto Sans JP is a separate FACE, not a replacement: it is a different design
 * with different metrics, so using it for Latin text would shift every measured
 * wrap point (see the note on metric compatibility above). It is reached only
 * for the characters Liberation cannot draw.
 */
export type UnicodeFace =
  | "regular"
  | "bold"
  | "italic"
  | "cjk"
  | "serif"
  | "serifBold"
  | "serifItalic"
  | "serifBoldItalic"

const FILES: Record<UnicodeFace, string> = {
  regular: "LiberationSans-Regular.ttf",
  bold: "LiberationSans-Bold.ttf",
  italic: "LiberationSans-Italic.ttf",
  cjk: "NotoSansJP-Regular.otf",
  // Liberation Serif: same family, release and licence file as Liberation Sans, and metrically
  // compatible with Times New Roman, which is what a classic contract layout prints in.
  serif: "LiberationSerif-Regular.ttf",
  serifBold: "LiberationSerif-Bold.ttf",
  serifItalic: "LiberationSerif-Italic.ttf",
  serifBoldItalic: "LiberationSerif-BoldItalic.ttf",
}

/**
 * Maps the schema's standard-font enum onto a face. The Helvetica family goes to
 * Liberation Sans and the Times family to Liberation Serif, each metrically
 * compatible with the font asked for, so a template keeps the serif or sans it
 * chose and gains the characters above Latin-1. Courier keeps its base-14 font:
 * a template asking for a monospace wants one, even at the Latin-1 ceiling.
 */
export const HELVETICA_FACE: Record<string, UnicodeFace> = {
  Helvetica: "regular",
  HelveticaBold: "bold",
  HelveticaOblique: "italic",
  HelveticaBoldOblique: "bold",
}

/** The Times family, served by the embedded Liberation Serif faces. */
export const TIMES_FACE: Record<string, UnicodeFace> = {
  TimesRoman: "serif",
  TimesRomanBold: "serifBold",
  TimesRomanItalic: "serifItalic",
  TimesRomanBoldItalic: "serifBoldItalic",
}

/** The embedded face a standard font name is served by, or undefined (Courier). */
export function unicodeFaceFor(standardFont: string): UnicodeFace | undefined {
  return HELVETICA_FACE[standardFont] ?? TIMES_FACE[standardFont]
}

// Read once per process, not once per render: three files, ~1.2 MB, on the
// synchronous path of every PDF the platform produces.
const bytesCache = new Map<UnicodeFace, Uint8Array>()

/** Directory holding the bundled faces. Overridable for tests. */
export function fontsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "fonts")
}

export function faceBytes(face: UnicodeFace): Uint8Array {
  const hit = bytesCache.get(face)
  if (hit) return hit
  const bytes = new Uint8Array(readFileSync(join(fontsDir(), FILES[face])))
  bytesCache.set(face, bytes)
  return bytes
}

/** The parts of a fontkit font a layout measures with. */
export interface FaceMetrics {
  unitsPerEm: number
  hasGlyphForCodePoint(codePoint: number): boolean
  layout(text: string): { glyphs: Array<{ advanceWidth: number }> }
}

const metricsCache = new Map<UnicodeFace, FaceMetrics>()

/**
 * A face's metrics, read from the same bytes the replayer embeds, so a layout
 * measures exactly what the page will draw. Read once per process.
 */
export function faceMetrics(face: UnicodeFace): FaceMetrics {
  const hit = metricsCache.get(face)
  if (hit) return hit
  const font = fontkit.create(Buffer.from(faceBytes(face))) as unknown as FaceMetrics
  metricsCache.set(face, font)
  return font
}

/** Whether a face holds a glyph for every character of `text`. */
export function faceDraws(face: UnicodeFace, text: string): boolean {
  const font = faceMetrics(face)
  for (const ch of text) if (!font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0)) return false
  return true
}

/**
 * The width of `text` at `size` in one face, glyph by glyph as pdf-lib draws it
 * (advance widths only: the replayer places glyphs without kerning).
 */
export function faceTextWidth(face: UnicodeFace, text: string, size: number): number {
  if (text === "") return 0
  const font = faceMetrics(face)
  let units = 0
  for (const g of font.layout(text).glyphs) units += g.advanceWidth
  return (units / font.unitsPerEm) * size
}

/**
 * Embed a face into `doc`, memoised per document.
 *
 * pdf-lib requires `registerFontkit` before any custom font embed and throws a
 * bare "Input document to PDFDocument.embed* must be..." otherwise; registering
 * twice on one document is harmless, so this does it unconditionally rather
 * than tracking a flag the caller could forget.
 */
export async function embedUnicodeFace(
  doc: PDFDocument,
  face: UnicodeFace,
  cache: Map<UnicodeFace, PDFFont>,
): Promise<PDFFont> {
  const hit = cache.get(face)
  if (hit) return hit
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(faceBytes(face), { subset: true })
  cache.set(face, font)
  return font
}

/**
 * Codepoint ranges the CJK fallback must handle. Kept in step with the
 * template-side allowlist in `templates/shared.ts` -- a character the template
 * lets through but this does not route to the fallback renders as .notdef, a
 * hollow box, which on an invoice reads as a rendering fault.
 */
const CJK_RANGES: Array<[number, number]> = [
  [0x2e80, 0x2fdf], // CJK radicals
  [0x3000, 0x30ff], // CJK punctuation, hiragana, katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
]

export function needsCjkFace(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

export interface TextRun {
  text: string
  cjk: boolean
}

/**
 * Split a string into consecutive runs of one face each.
 *
 * A single drawText call takes ONE font, and real values mix scripts in one
 * string ("株式会社アイシン YYSystem事業推進部"). Drawing the whole string with
 * the CJK face instead would work, but it would render the Latin half in a
 * different typeface from the rest of the document, so runs it is.
 */
export function splitByFace(text: string): TextRun[] {
  const runs: TextRun[] = []
  for (const ch of text) {
    const cjk = needsCjkFace(ch)
    const last = runs[runs.length - 1]
    if (last && last.cjk === cjk) last.text += ch
    else runs.push({ text: ch, cjk })
  }
  return runs
}
